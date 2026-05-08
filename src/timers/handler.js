const { isLiveViaEventSub, getStreamUptime } = require('../eventsub');
const logger = require('../utils/logger');

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
      if (!isLiveViaEventSub()) return;

      const suffix = lastMessages[index] === timer.message ? ' ‎' : '';
      const msg = timer.message + suffix;
      lastMessages[index] = msg;
      client.say(`#${process.env.CHANNEL}`, msg);
    }, timer.interval * 60 * 1000);

    timerRefs.push(ref);
  });

  // Timer de duración del stream cada 40 min — usa EventSub (fiable)
  streamDurationInterval = setInterval(() => {
    if (!isLiveViaEventSub()) return;

    const uptime = getStreamUptime();
    if (!uptime) return;

    client.say(`#${process.env.CHANNEL}`, `⏱️ ¡Llevamos ${uptime} de stream! ¿Cómo lo estáis pasando? 💜`);
  }, 40 * 60 * 1000);
}

function stop() {
  timerRefs.forEach(ref => clearInterval(ref));
  timerRefs.length = 0;
  if (streamDurationInterval) { clearInterval(streamDurationInterval); streamDurationInterval = null; }
  logger.info('⏹️ Timers detenidos');
}

module.exports = { start, stop };
