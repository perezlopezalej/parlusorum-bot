const { isLiveViaEventSub, getStreamUptime } = require('../eventsub');
const { getCurrentGame, getGameInfo } = require('../twitch/api');
const { isSilenced, getDeathCount } = require('../utils/state');
const { canMakeRequest } = require('../utils/ratelimit');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');
const { withOrigin } = require('../utils/chatlog');
const { getBotPersonality } = require('../ai/handler');
const { translateGenres } = require('../utils/genres');
const quality = require('../ai/quality');
const factcheck = require('../ai/factcheck');
const { AUTO_GAME_RULE, STYLE_RULES } = require('../ai/prompts');
const { getLoreContext } = require('../lore/handler');
const { groqWithRetry, truncate, GROQ_MODEL } = require('../utils/groq-utils');
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
  { id: 'fua', note: 'el FUA como fuerza universal, con una comparación absurda y cotidiana' },
  { id: 'tiempo', note: 'el tiempo que llevamos de directo ({uptime})' },
  { id: 'chat', note: 'una pregunta abierta y divertida para el chat, que no sea sobre el juego' },
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
    if (!uptime) return;

    enqueueTimerMessage(withOrigin('timer', () => client.say(`#${process.env.CHANNEL}`, `⏱️ ¡Llevamos ${uptime} de stream! ¿Cómo lo estáis pasando? 💜`)));
  }), 40 * 60 * 1000);

  // Timer dinámico con IA — comenta sobre el juego actual cada ~25 min
  timerRefs.push(setInterval(withOrigin('timer_ia', async () => {
    if (!isLiveViaEventSub() || isSilenced() || !canMakeRequest()) return;

    const gameInfo = await getCurrentGame().catch(() => null);
    const game = gameInfo?.game;
    if (!game) return;

    try {
      const rawg = await getGameInfo(game).catch(() => null);
      const genres = translateGenres(rawg?.genres);
      const gameContext = genres
        ? `${game} (${genres}${rawg.released ? `, ${rawg.released.slice(0, 4)}` : ''})`
        : game;

      const learnedLore = await getLoreContext();
      const deathCount = getDeathCount();
      const deathNote = deathCount === 0
        ? 'El contador de muertes está a 0: NO menciones muertes ni caídas.'
        : `Muertes anotadas del streamer: ${deathCount}. No cites otra cifra ni inventes muertes.`;
      const { topic } = pickTimerTopic({ last: lastTimerTopic });
      const topicNote = topic.note.replace('{uptime}', String(getStreamUptime() || ''));
      const tone = ['burla cariñosa', 'épica', 'observación curiosa'][Math.floor(Math.random() * 3)];
      const prior = recentTimerIA.length ? `
YA DIJISTE (no repitas ni parafrasees ninguna idea): ${recentTimerIA.map(m => `"${m}"`).join(' | ')}` : '';

      let msg = '';
      let feedback = '';
      for (let attempt = 0; attempt < 2 && !msg; attempt++) {
        if (attempt > 0 && !canMakeRequest()) break;
        const response = await groqWithRetry({
          model: GROQ_MODEL,
          max_tokens: 80,
          messages: [
            {
              role: 'system',
              content: `${getBotPersonality()}${learnedLore} Juego actual: "${gameContext}". Haz un comentario breve con tu personalidad y el lore del canal, sobre este tema: ${topicNote}. No nombres ni etiquetes (@) a ningún usuario, ni otros videojuegos que no sean el actual (nada de comparaciones con otros juegos), y no menciones el año de salida. Quien juega es Manu: habla de Manu, nunca de "Manu y Pao" jugando o muriendo. ${AUTO_GAME_RULE} ${deathNote} Tono: ${tone}. Estilo de comentarista deportivo prohibido. ${STYLE_RULES} Máx 2 frases cortas. Sin presentarte.${prior}${feedback ? `
TU INTENTO ANTERIOR FUE RECHAZADO: ${feedback}. Escribe otro distinto.` : ''}`
            },
            { role: 'user', content: `Suelta un comentario sobre el directo de ${game} (tono: ${tone})` }
          ]
        });
        const out = truncate((response.choices[0].message.content || '').trim());
        const check = quality.validateTimerIA(out, { deathCount, recent: recentTimerIA, currentGame: game, channelGames: channelConfig.games_played || [] });
        if (!check.ok) { feedback = check.reason; logger.info(`Timer IA descartado (${check.reason}): ${out.slice(0, 80)}`); continue; }
        const review = await factcheck.evaluate(out, `Juego: ${gameContext}. Muertes anotadas: ${deathCount}.`, { game, sense: true });
        if (review.discard) {
          logger.info(`Timer IA descartado (datos del juego sin respaldo): ${out.slice(0, 80)}`);
          break;
        }
        if (review.nonsense) { feedback = 'la frase no tiene sentido o está mal escrita; una sola idea, palabras sencillas'; logger.info(`Timer IA descartado (sin sentido o mal escrito): ${out.slice(0, 80)}`); continue; }
        msg = out;
      }
      if (msg) {
        lastTimerTopic = topic.id;
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
