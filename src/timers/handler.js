const { isLiveViaEventSub, getStreamUptime } = require('../eventsub');
const { getCurrentGame } = require('../twitch/api');
const {
  recordFilterDiscard,
  recordFilterSent,
  isSilenced,
  isReactive,
  getDeathCount,
  getStreamStartedAt,
  getStreamNarrative,
  markStructure,
  getUsedStructures,
  getBotHistory,
  addBotMessage,
  getPlayer,
  markNamed,
  getNamedUsers,
} = require('../utils/state');
const { windowFacts } = require('../utils/narrative');
const { chatTopic, gameVocabulary, properNouns } = require('../ai/moment-facts');
const { pickBest } = require('../ai/pick-best');
const { canMakeRequest } = require('../utils/ratelimit');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

const MIN_UPTIME_MS = 5 * 60 * 1000;
const { withOrigin } = require('../utils/chatlog');
const { getChatWindow } = require('../ai/handler');
const quality = require('../ai/quality');
const factcheck = require('../ai/factcheck');
const { lookupGameInfo } = require('../twitch/api');
const { buildTimerSystem, retryNote, dayLine } = require('../ai/style');
const { truncate } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const MIN_CHAT_FOR_SUMMARY = 15; // mensajes en la ventana para contar solo de qué ha hablado el chat
const MIN_USERS_FOR_TOPIC = 3; // usuarios distintos en el mismo tema para que entre en el resumen
const AI_TIMER_INTERVAL_MS = parseInt(process.env.AI_TIMER_INTERVAL_MS || String(30 * 60 * 1000), 10);
const AI_TIMER_NAME_WINDOW_MS = 15 * 60 * 1000; // un nombre (Pao incluido) no se repite en otro comentario IA durante este rato

// Separación mínima entre mensajes de timer: si varios coinciden en el mismo minuto salen espaciados
const MIN_TIMER_GAP_MS = parseInt(process.env.TIMER_MIN_GAP_MS || String(90 * 1000), 10);
const MAX_TIMER_QUEUE = 4;
const timerQueue = [];
let timerDrainRef = null;

function enqueueTimerMessage(send) {
  if (timerQueue.length >= MAX_TIMER_QUEUE) return;
  timerQueue.push(send);
  if (!timerDrainRef) drainTimerQueue();
}

function drainTimerQueue() {
  const send = timerQueue.shift();
  if (!send) {
    timerDrainRef = null;
    return;
  }
  try {
    if (isLiveViaEventSub() && !isSilenced() && !isReactive()) send();
  } catch (err) {
    logger.warn(`Timer: ${err.message}`);
  }
  timerDrainRef = setTimeout(drainTimerQueue, MIN_TIMER_GAP_MS);
  timerDrainRef.unref?.();
}

// Últimos comentarios IA del timer en este stream (para no repetir ideas)
const MAX_RECENT_TIMER_IA = 20;
const recentTimerIA = [];

const timerRefs = [];
let lastMessages = [];
let streamDurationInterval = null;

// Un comentario IA con el resumen de la última media hora. Devuelve el texto enviado ('' si no se envió nada).
async function runTimerIA(client) {
  if (!isLiveViaEventSub() || isSilenced() || isReactive() || !canMakeRequest()) return '';

  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game;
  if (!game) return '';

  const now = Date.now();
  const firstFacts = windowFacts(getStreamNarrative(), now, AI_TIMER_INTERVAL_MS);
  const chatLines = getChatWindow(AI_TIMER_INTERVAL_MS, now);
  // Del chat solo entra el tema, en una frase fija escrita por el código (moment-facts): ninguna línea literal llega al modelo
  const playerName = { pao: 'Pao', ambos: 'Manu y Pao' }[getPlayer()] || 'Manu';
  const topicFor = (gameWords) =>
    chatLines.length >= MIN_CHAT_FOR_SUMMARY
      ? chatTopic(chatLines, { player: playerName, gameWords, minUsers: MIN_USERS_FOR_TOPIC })
      : null;
  if (!firstFacts.relevant && !topicFor(gameVocabulary(game))) {
    logger.info('Timer IA: nada relevante en la última media hora, no se envía');
    return '';
  }

  try {
    // Ficha del juego actual (caché de IGDB): el revisor no descarta datos correctos como el año, y sus nombres propios
    // cuentan como vocabulario del juego
    const sheet = (await lookupGameInfo(game, { detail: true }).catch(() => ({}))).info;
    const gameFacts = factcheck.gameFactsText(sheet);
    const gameWords = [...new Set([...gameVocabulary(game), ...properNouns(sheet?.description)])];
    const topic = topicFor(gameWords);
    const chatTalk = !!topic;
    const emotes = channelConfig.channel_emotes || [];

    let msg = '';
    let feedback = '';
    for (let attempt = 0; attempt < 3 && !msg; attempt++) {
      if (attempt > 0 && !canMakeRequest()) break;
      // El estado se lee de nuevo en cada intento: la IA puede tardar y el contador cambiar mientras tanto
      const at = Date.now();
      const deathCount = getDeathCount();
      const facts = windowFacts(getStreamNarrative(), at, AI_TIMER_INTERVAL_MS);
      if (!facts.relevant && !chatTalk) break;
      const summary = `Última media hora: ${facts.lines.length ? facts.lines.join('; ') : 'sin caídas ni jefes nuevos'}.${topic ? ` ${topic.texto}.` : ''} Total de caídas del directo hasta ahora: ${deathCount} (dato de apoyo; no hace falta citarlo).`;
      // Lo que ya se dijo en ese tramo (cohost incluido): el código comprueba el parecido, el prompt no lo cita
      const saidInWindow = getBotHistory()
        .filter((e) => at - e.ts <= AI_TIMER_INTERVAL_MS)
        .map((e) => e.msg);
      const recent = [...recentTimerIA, ...saidInWindow];
      const lastCitedDeaths = quality.citesDeathCount((getBotHistory().slice(-1)[0] || {}).msg || '', deathCount);
      const system = buildTimerSystem({
        game,
        player: getPlayer(),
        now: new Date(at),
        weekday: !getUsedStructures().has('dia-semana'),
      });
      const response = await aiChat('timer', {
        max_tokens: 90,
        messages: [
          { role: 'system', content: `${system}${retryNote(feedback)}` },
          { role: 'user', content: `<resumen>${summary}</resumen>` },
        ],
      });
      // Si el contador cambió mientras la IA escribía, el texto parte de datos viejos: se rehace con el estado actual
      if (getDeathCount() !== deathCount) {
        feedback = '';
        logger.info('Timer IA: el contador cambió mientras se generaba, se rehace con el estado actual');
        continue;
      }
      // Emote como mucho 1 de cada 3 mensajes y siempre al final
      const allowEmote = quality.emoteAllowed(
        getBotHistory().map((e) => e.msg),
        emotes,
      );
      const out = quality.applyEmotePolicy(
        truncate((response.choices[0].message.content || '').trim()),
        allowEmote,
        emotes,
        getBotHistory().map((e) => e.msg),
      );
      const check = quality.validateTimerIA(out, {
        deathCount,
        extraDeathNumbers: [facts.deaths, facts.streak],
        recent,
        currentGame: game,
        channelGames: channelConfig.games_played || [],
        usedStructures: getUsedStructures(),
        lastCitedDeaths,
        player: getPlayer(),
        named: getNamedUsers(),
        now: at,
        nameWindowMs: AI_TIMER_NAME_WINDOW_MS,
        chatLines,
        allowedWords: [system, summary],
        gameWords,
      });
      if (!check.ok) {
        recordFilterDiscard('timer_ia', String(check.reason).slice(0, 30));
        feedback = check.reason;
        logger.info(`Timer IA descartado (${check.reason}): ${out.slice(0, 80)}`);
        continue;
      }
      // Un modelo pequeño comprueba ortografía, lógica y que cuadre con el resumen y el juego; si no puede, la revisión de siempre
      const pick = await pickBest([out], {
        dayLine: dayLine(new Date(at)),
        game,
        facts: `Caídas anotadas: ${deathCount}. Juega ${playerName}. ${summary}`,
        activity: getChatWindow(5 * 60 * 1000, at).length,
        generator: response._ai?.model,
      });
      if (pick.status === 'none') {
        recordFilterDiscard('timer_ia', 'selector');
        feedback = 'selector';
        logger.info(`Timer IA descartado (el selector no lo ve bueno): ${out.slice(0, 80)}`);
        continue;
      }
      const review = await factcheck.evaluate(
        out,
        `Juego: ${game}. Muertes anotadas: ${deathCount}. ${summary} ${gameFacts}`,
        { game, sense: pick.status === 'error' },
      );
      if (review.discard) {
        recordFilterDiscard('timer_ia', 'datos');
        logger.info(`Timer IA descartado (datos del juego sin respaldo): ${out.slice(0, 80)}`);
        break;
      }
      if (review.nonsense) {
        recordFilterDiscard('timer_ia', 'sentido');
        feedback = 'la frase no tiene sentido o está mal escrita';
        logger.info(`Timer IA descartado (sin sentido o mal escrito): ${out.slice(0, 80)}`);
        continue;
      }
      msg = out;
    }
    if (msg) {
      for (const key of quality.streamMarks(msg, game)) markStructure(key);
      markNamed(quality.namesIn(msg, ['pao']));
      addBotMessage(msg);
      recentTimerIA.push(msg);
      if (recentTimerIA.length > MAX_RECENT_TIMER_IA) recentTimerIA.shift();
      recordFilterSent('timer_ia');
      enqueueTimerMessage(withOrigin('timer_ia', () => client.say(`#${process.env.CHANNEL}`, msg)));
    }
    return msg;
  } catch (err) {
    logger.warn(`Timer IA: ${err.message}`);
    return '';
  }
}

function start(client, config) {
  if (!config.timers || config.timers.length === 0) return;

  logger.info(`⏰ Timers iniciados (${config.timers.length} mensajes)`);
  lastMessages = new Array(config.timers.length).fill('');

  config.timers.forEach((timer, index) => {
    const ref = setInterval(
      withOrigin('timer', () => {
        // Usar EventSub para saber si está en directo (fiable)
        if (!isLiveViaEventSub() || isSilenced() || isReactive()) return;

        const suffix = lastMessages[index] === timer.message ? ' ‎' : '';
        const msg = timer.message + suffix;
        lastMessages[index] = msg;
        enqueueTimerMessage(withOrigin('timer', () => client.say(`#${process.env.CHANNEL}`, msg)));
      }),
      timer.interval * 60 * 1000,
    );

    timerRefs.push(ref);
  });

  // Timer de duración del stream cada 40 min — usa EventSub (fiable)
  streamDurationInterval = setInterval(
    withOrigin('timer', () => {
      if (!isLiveViaEventSub() || isSilenced() || isReactive()) return;

      const uptime = getStreamUptime();
      const startedAt = getStreamStartedAt();
      // Sin tiempo real de directo (p. ej. justo tras un despliegue) no hay nada que contar
      if (!uptime || !startedAt || Date.now() - startedAt < MIN_UPTIME_MS) return;

      enqueueTimerMessage(
        withOrigin('timer', () =>
          client.say(`#${process.env.CHANNEL}`, `⏱️ ¡Llevamos ${uptime} de stream! ¿Cómo lo estáis pasando? 💜`),
        ),
      );
    }),
    40 * 60 * 1000,
  );

  // Timer IA: resumen de la última media hora. El código reúne lo que ha pasado (caídas, jefes, tema del chat) y la IA
  // lo cuenta con gracia en una frase. Si no ha pasado nada relevante, no se envía nada.
  timerRefs.push(
    setInterval(
      withOrigin('timer_ia', () => runTimerIA(client)),
      AI_TIMER_INTERVAL_MS,
    ),
  );
}

function stop() {
  timerRefs.forEach((ref) => clearInterval(ref));
  timerRefs.length = 0;
  timerQueue.length = 0;
  recentTimerIA.length = 0;
  if (timerDrainRef) {
    clearTimeout(timerDrainRef);
    timerDrainRef = null;
  }
  if (streamDurationInterval) {
    clearInterval(streamDurationInterval);
    streamDurationInterval = null;
  }
  logger.info('⏹️ Timers detenidos');
}

module.exports = { start, stop, enqueueTimerMessage, runTimerIA };
