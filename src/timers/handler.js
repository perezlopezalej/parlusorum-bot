const { getCurrentGame } = require('../twitch/api');

const timerRefs = [];
let lastMessages = [];

function start(client, config) {
  if (!config.timers || config.timers.length === 0) return;

  console.log(`⏰ Timers iniciados (${config.timers.length} mensajes)`);

  lastMessages = new Array(config.timers.length).fill('');

  config.timers.forEach((timer, index) => {
    const ref = setInterval(async () => {
      // No enviar timers si el canal no está en directo
      const gameInfo = await getCurrentGame();
      if (!gameInfo?.game) return; // Si no hay juego configurado, el canal probablemente está offline

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
  console.log('⏹️ Timers detenidos');
}

module.exports = { start, stop };
