const { isLiveViaEventSub, getStreamUptime } = require('../eventsub');
const { getCurrentGame, getGameInfo } = require('../twitch/api');
const { isSilenced } = require('../utils/state');
const { canMakeRequest } = require('../utils/ratelimit');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');
const { getBotPersonality } = require('../ai/handler');
const { getLoreContext } = require('../lore/handler');
const { groqWithRetry, truncate } = require('../utils/groq-utils');
const AI_TIMER_INTERVAL_MS = parseInt(process.env.AI_TIMER_INTERVAL_MS || String(25 * 60 * 1000), 10);

const timerRefs = [];
let lastMessages = [];
let streamDurationInterval = null;

function start(client, config) {
  if (!config.timers || config.timers.length === 0) return;

  logger.info(`⏰ Timers iniciados (${config.timers.length} mensajes)`);
  lastMessages = new Array(config.timers.length).fill('');

  config.timers.forEach((timer, index) => {
    const ref = setInterval(() => {
      // Usar EventSub para saber si está en directo (fiable)
      if (!isLiveViaEventSub() || isSilenced()) return;

      const suffix = lastMessages[index] === timer.message ? ' ‎' : '';
      const msg = timer.message + suffix;
      lastMessages[index] = msg;
      client.say(`#${process.env.CHANNEL}`, msg);
    }, timer.interval * 60 * 1000);

    timerRefs.push(ref);
  });

  // Timer de duración del stream cada 40 min — usa EventSub (fiable)
  streamDurationInterval = setInterval(() => {
    if (!isLiveViaEventSub() || isSilenced()) return;

    const uptime = getStreamUptime();
    if (!uptime) return;

    client.say(`#${process.env.CHANNEL}`, `⏱️ ¡Llevamos ${uptime} de stream! ¿Cómo lo estáis pasando? 💜`);
  }, 40 * 60 * 1000);

  // Timer dinámico con IA — comenta sobre el juego actual cada ~25 min
  timerRefs.push(setInterval(async () => {
    if (!isLiveViaEventSub() || isSilenced() || !canMakeRequest()) return;

    const gameInfo = await getCurrentGame().catch(() => null);
    const game = gameInfo?.game;
    if (!game) return;

    try {
      const rawg = await getGameInfo(game).catch(() => null);
      const gameContext = rawg
        ? `${game}${rawg.genres ? ` (${rawg.genres})` : ''}${rawg.rating ? `, ${rawg.rating}/5 en RAWG` : ''}`
        : game;

      const learnedLore = await getLoreContext();
      const tone =['burla cariñosa', 'épica', 'observación curiosa del juego'][Math.floor(Math.random() * 3)];
      const response = await groqWithRetry({
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content: `${getBotPersonality()}${learnedLore} Juego actual: "${gameContext}". Haz un comentario breve sobre el juego con tu personalidad y el lore del canal. Elige UN tono al azar: burla cariñosa, épica, o observación curiosa del juego. Sin metáforas forzadas de otros temas ni estilo de comentarista deportivo. Máx 2 frases cortas. Sin presentarte.`
          },
          { role: 'user', content: `Comenta algo sobre ${game} (tono: ${tone})` }
        ]
      });
      const msg = truncate(response.choices[0].message.content);
      if (msg) client.say(`#${process.env.CHANNEL}`, msg);
    } catch (err) {
      logger.warn(`Timer IA: ${err.message}`);
    }
  }, AI_TIMER_INTERVAL_MS));
}

function stop() {
  timerRefs.forEach(ref => clearInterval(ref));
  timerRefs.length = 0;
  if (streamDurationInterval) { clearInterval(streamDurationInterval); streamDurationInterval = null; }
  logger.info('⏹️ Timers detenidos');
}

module.exports = { start, stop };
