const { isStreamLive, getCurrentGame, getStreamInfo } = require('../twitch/api');
const logger = require('../utils/logger');

const timerRefs = [];
let lastMessages = [];
let streamStartTime = null;

// Timer extra: duración del stream cada 40 minutos
let streamDurationInterval = null;

function start(client, config) {
  if (!config.timers || config.timers.length === 0) return;

  logger.info(`⏰ Timers iniciados (${config.timers.length} mensajes)`);
  lastMessages = new Array(config.timers.length).fill('');

  config.timers.forEach((timer, index) => {
    const ref = setInterval(async () => {
      if (!isStreamLive()) return;

      const suffix = lastMessages[index] === timer.message ? ' ‎' : '';
      const msg = timer.message + suffix;
      lastMessages[index] = msg;
      client.say(`#${process.env.CHANNEL}`, msg);
    }, timer.interval * 60 * 1000);

    timerRefs.push(ref);
  });

  // Timer de duración del stream cada 40 min
  streamDurationInterval = setInterval(async () => {
    const info = await getStreamInfo().catch(() => null);
    if (!info?.live) { streamStartTime = null; return; }

    if (!streamStartTime && info.startedAt) {
      streamStartTime = new Date(info.startedAt);
    }

    if (streamStartTime) {
      const mins = Math.floor((Date.now() - streamStartTime) / 60000);
      const hours = Math.floor(mins / 60);
      const remaining = mins % 60;
      const timeStr = hours > 0 ? `${hours}h ${remaining}m` : `${mins}m`;
      client.say(`#${process.env.CHANNEL}`, `⏱️ ¡Llevamos ${timeStr} de stream! ¿Cómo lo estáis pasando? 💜`);
    }
  }, 40 * 60 * 1000);
}

function stop() {
  timerRefs.forEach(ref => clearInterval(ref));
  timerRefs.length = 0;
  if (streamDurationInterval) { clearInterval(streamDurationInterval); streamDurationInterval = null; }
  logger.info('⏹️ Timers detenidos');
}

module.exports = { start, stop };
