const { isLiveViaEventSub, getStreamUptime } = require('../eventsub');
const { getCurrentGame } = require('../twitch/api');
const { isSilenced, getDeathCount, getStreamStartedAt, markStructure, getUsedStructures, getBotHistory, addBotMessage, getPlayer } = require('../utils/state');
const { canMakeRequest } = require('../utils/ratelimit');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

const MIN_UPTIME_MS = 5 * 60 * 1000;
const { withOrigin } = require('../utils/chatlog');
const { getBotPersonality } = require('../ai/handler');
const quality = require('../ai/quality');
const factcheck = require('../ai/factcheck');
const { lookupGameInfo } = require('../twitch/api');
const { AUTO_GAME_RULE, STYLE_RULES, playerRule } = require('../ai/prompts');
const { getLoreContext } = require('../lore/handler');
const { truncate } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const AI_TIMER_INTERVAL_MS = parseInt(process.env.AI_TIMER_INTERVAL_MS || String(25 * 60 * 1000), 10);

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
  if (!send) { timerDrainRef = null; return; }
  try { if (isLiveViaEventSub() && !isSilenced()) send(); } catch (err) { logger.warn(`Timer: ${err.message}`); }
  timerDrainRef = setTimeout(drainTimerQueue, MIN_TIMER_GAP_MS);
  timerDrainRef.unref?.();
}

// Últimos comentarios IA del timer en este stream (para no repetir ideas)
const MAX_RECENT_TIMER_IA = 20;
const recentTimerIA = [];
let lastTimerTopic = '';

// Tema obligatorio de cada comentario, para que dos seguidos no sean el mismo. Ninguno nombra ni etiqueta a nadie.
const TIMER_TOPICS = [
  { id: 'lore', note: 'una anécdota o broma del lore del canal' },
  { id: 'fua', note: 'el FUA como fuerza universal, con una broma directa (sin compararlo con objetos ni situaciones cotidianas)' },
  { id: 'tiempo', note: 'el tiempo que llevamos de directo ({uptime}); no abras la frase con la hora ni con el contador' },
  { id: 'chat', note: 'una pregunta concreta y divertida sobre el stream o el FUA (nada de motivación, autoayuda ni preguntas existenciales)' },
];

// Elige un tema distinto al anterior
function pickTimerTopic({ last = '', rand = Math.random } = {}) {
  const pool = TIMER_TOPICS.filter(t => t.id !== last);
  return { topic: pool[Math.floor(rand() * pool.length)] };
}

const timerRefs = [];
let lastMessages = [];
let streamDurationInterval = null;

function start(client, config) {
  if (!config.timers || config.timers.length === 0) return;

  logger.info(`⏰ Timers iniciados (${config.timers.length} mensajes)`);
  lastMessages = new Array(config.timers.length).fill('');

  config.timers.forEach((timer, index) => {
    const ref = setInterval(withOrigin('timer', () => {
      // Usar EventSub para saber si está en directo (fiable)
      if (!isLiveViaEventSub() || isSilenced()) return;

      const suffix = lastMessages[index] === timer.message ? ' ‎' : '';
      const msg = timer.message + suffix;
      lastMessages[index] = msg;
      enqueueTimerMessage(withOrigin('timer', () => client.say(`#${process.env.CHANNEL}`, msg)));
    }), timer.interval * 60 * 1000);

    timerRefs.push(ref);
  });

  // Timer de duración del stream cada 40 min — usa EventSub (fiable)
  streamDurationInterval = setInterval(withOrigin('timer', () => {
    if (!isLiveViaEventSub() || isSilenced()) return;

    const uptime = getStreamUptime();
    const startedAt = getStreamStartedAt();
    // Sin tiempo real de directo (p. ej. justo tras un despliegue) no hay nada que contar
    if (!uptime || !startedAt || Date.now() - startedAt < MIN_UPTIME_MS) return;

    enqueueTimerMessage(withOrigin('timer', () => client.say(`#${process.env.CHANNEL}`, `⏱️ ¡Llevamos ${uptime} de stream! ¿Cómo lo estáis pasando? 💜`)));
  }), 40 * 60 * 1000);

  // Timer dinámico con IA — comenta sobre el juego actual cada ~25 min
  timerRefs.push(setInterval(withOrigin('timer_ia', async () => {
    if (!isLiveViaEventSub() || isSilenced() || !canMakeRequest()) return;

    const gameInfo = await getCurrentGame().catch(() => null);
    const game = gameInfo?.game;
    if (!game) return;

    try {
      // Solo el nombre del juego: con el género en el contexto el modelo lo repetía en cada mensaje ("juego de rol y acción")
      const gameContext = game;
      // Ficha del juego actual (caché de IGDB) solo para el revisor: así no descarta datos correctos como el año
      const gameFacts = factcheck.gameFactsText((await lookupGameInfo(game, { detail: true }).catch(() => ({}))).info);
      const emotes = channelConfig.channel_emotes || [];

      const learnedLore = await getLoreContext();
      const deathCount = getDeathCount();
      const deathNote = deathCount === 0
        ? 'El contador de muertes está a 0: NO menciones muertes ni caídas.'
        : `Muertes anotadas del streamer: ${deathCount}. No cites otra cifra ni inventes muertes.`;
      // No se cita el número de muertes en dos mensajes seguidos del bot (cohost y timer comparten historial)
      const lastCitedDeaths = quality.citesDeathCount((getBotHistory().slice(-1)[0] || {}).msg || '', deathCount);
      const { topic } = pickTimerTopic({ last: lastTimerTopic });
      const topicNote = topic.note.replace('{uptime}', String(getStreamUptime() || ''));
      const tone = ['burla cariñosa', 'épica', 'observación curiosa'][Math.floor(Math.random() * 3)];
      const prior = recentTimerIA.length ? `
YA DIJISTE (no repitas ni parafrasees ninguna idea): ${recentTimerIA.map(m => `"${m}"`).join(' | ')}` : '';

      let msg = '';
      let feedback = '';
      for (let attempt = 0; attempt < 2 && !msg; attempt++) {
        if (attempt > 0 && !canMakeRequest()) break;
        const response = await aiChat('timer', {
          max_tokens: 80,
          messages: [
            {
              role: 'system',
              content: `${getBotPersonality()}${learnedLore} Juego actual: "${gameContext}". Haz un comentario breve con tu personalidad y el lore del canal, sobre este tema: ${topicNote}. No nombres ni etiquetes (@) a ningún usuario, ni otros videojuegos que no sean el actual (nada de comparaciones con otros juegos), y no menciones el año de salida. ${playerRule(getPlayer())} ${AUTO_GAME_RULE} ${deathNote} Tono: ${tone}. Habla con la voz de Dios Fua, con frases llanas. No menciones el género del juego, no compares con objetos ni situaciones cotidianas y no hagas preguntas de motivación; cada mensaje con una estructura distinta. ${lastCitedDeaths ? 'Tu mensaje anterior ya citó el número de muertes: NO cites ninguna cifra de muertes en este. ' : ''}${STYLE_RULES} Máx 2 frases cortas. Sin presentarte.${prior}${feedback ? `
TU INTENTO ANTERIOR FUE RECHAZADO: ${feedback}. Escribe otro distinto.` : ''}`
            },
            { role: 'user', content: `Suelta un comentario sobre el directo de ${game} (tono: ${tone})` }
          ]
        });
        // Emote como mucho 1 de cada 3 mensajes y siempre al final
        const allowEmote = quality.emoteAllowed(getBotHistory().map(e => e.msg), emotes);
        const out = quality.applyEmotePolicy(truncate((response.choices[0].message.content || '').trim()), allowEmote, emotes);
        const check = quality.validateTimerIA(out, { deathCount, recent: recentTimerIA, currentGame: game, channelGames: channelConfig.games_played || [], usedStructures: getUsedStructures(), lastCitedDeaths, player: getPlayer() });
        if (!check.ok) { feedback = check.reason; logger.info(`Timer IA descartado (${check.reason}): ${out.slice(0, 80)}`); continue; }
        const review = await factcheck.evaluate(out, `Juego: ${gameContext}. Muertes anotadas: ${deathCount}. ${gameFacts}`, { game, sense: response._ai?.provider !== 'gemini' });
        if (review.discard) {
          logger.info(`Timer IA descartado (datos del juego sin respaldo): ${out.slice(0, 80)}`);
          break;
        }
        if (review.nonsense) { feedback = 'la frase no tiene sentido o está mal escrita; una sola idea, palabras sencillas'; logger.info(`Timer IA descartado (sin sentido o mal escrito): ${out.slice(0, 80)}`); continue; }
        msg = out;
      }
      if (msg) {
        lastTimerTopic = topic.id;
        markStructure(quality.structureKey(msg));
        addBotMessage(msg);
        recentTimerIA.push(msg);
        if (recentTimerIA.length > MAX_RECENT_TIMER_IA) recentTimerIA.shift();
        enqueueTimerMessage(withOrigin('timer_ia', () => client.say(`#${process.env.CHANNEL}`, msg)));
      }
    } catch (err) {
      logger.warn(`Timer IA: ${err.message}`);
    }
  }), AI_TIMER_INTERVAL_MS));
}

function stop() {
  timerRefs.forEach(ref => clearInterval(ref));
  timerRefs.length = 0;
  timerQueue.length = 0;
  recentTimerIA.length = 0;
  if (timerDrainRef) { clearTimeout(timerDrainRef); timerDrainRef = null; }
  if (streamDurationInterval) { clearInterval(streamDurationInterval); streamDurationInterval = null; }
  logger.info('⏹️ Timers detenidos');
}

module.exports = { pickTimerTopic, TIMER_TOPICS, start, stop, enqueueTimerMessage };
