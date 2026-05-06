const { isStreamLive } = require('../twitch/api');
const logger = require('../utils/logger');

const timerRefs = [];
let lastMessages = [];

function start(client, config) {
  if (!config.timers || config.timers.length === 0) return;

  logger.info(`⏰ Timers iniciados (${config.timers.length} mensajes)`);
  lastMessages = new Array(config.timers.length).fill('');

  config.timers.forEach((timer, index) => {
    const ref = setInterval(() => {
      // Solo enviar si el canal está en directo
      if (!isStreamLive()) return;

      // Evitar mensajes idénticos consecutivos
      const suffix = lastMessages[index] === timer.message ? ' ‎' : '';
      const msg = timer.message + suffix;
      lastMessages[index] = msg;
      client.say(`#${process.env.CHANNEL}`, msg);
    }, timer.interval * 60 * 1000);

    timerRefs.push(ref);
  });
}

function stop() {
  timerRefs.forEach(ref => clearInterval(ref));
  timerRefs.length = 0;
  logger.info('⏹️ Timers detenidos');
}

module.exports = { start, stop };
