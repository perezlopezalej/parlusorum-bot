let timerIndex = 0;
let timerInterval = null;

function start(client, config) {
  if (!config.timers || config.timers.length === 0) return;

  console.log(`⏰ Timers iniciados (${config.timers.length} mensajes)`);

  // Lanzar cada timer según su intervalo individual
  config.timers.forEach((timer) => {
    setInterval(() => {
      client.say(`#${process.env.CHANNEL}`, timer.message);
    }, timer.interval * 60 * 1000);
  });
}

function stop() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
    console.log('⏹️ Timers detenidos');
  }
}

module.exports = { start, stop };