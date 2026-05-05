const cooldowns = new Map();

function handle(client, channel, tags, command, args, config, isMod) {
  const username = tags['display-name'];

  // Comandos del config JSON
  if (config.commands[command]) {
    const cmd = config.commands[command];

    // Comprobar cooldown
    const key = `${command}-${username}`;
    const now = Date.now();
    if (cooldowns.has(key)) {
      const expiry = cooldowns.get(key);
      if (now < expiry) {
        const remaining = Math.ceil((expiry - now) / 1000);
        client.say(channel, `@${username} espera ${remaining}s para usar !${command} de nuevo.`);
        return;
      }
    }

    // Guardar cooldown
    cooldowns.set(key, now + cmd.cooldown * 1000);

    // Responder
    client.say(channel, cmd.response);
    return;
  }

  // Comando !top10
  if (command === 'top10') {
    return handleTop10(client, channel);
  }

  // Comandos de mod
  if (command === 'x2' && isMod) {
    return handleDoublePoints(client, channel);
  }

  if (command === 'x2off' && isMod) {
    return handleDoublePointsOff(client, channel);
  }
}

// --- Top 10 ---
function handleTop10(client, channel) {
  try {
    const fs = require('fs');
    const path = './data/points.json';
    if (!fs.existsSync(path)) {
      client.say(channel, 'Aún no hay datos de puntos. ¡Chatea más! 💬');
      return;
    }
    const points = JSON.parse(fs.readFileSync(path, 'utf8'));
    const sorted = Object.entries(points)
      .sort((a, b) => b[1].points - a[1].points)
      .slice(0, 10);

    if (sorted.length === 0) {
      client.say(channel, 'Aún no hay puntos registrados.');
      return;
    }

    const list = sorted
      .map(([user, data], i) => `${i + 1}. ${user} (${data.points} pts)`)
      .join(' | ');

    client.say(channel, `🏆 Top 10: ${list}`);
  } catch (err) {
    console.error('Error en top10:', err);
  }
}

// --- Modo doble puntos ---
let doublePointsActive = false;

function handleDoublePoints(client, channel) {
  doublePointsActive = true;
  client.say(channel, '⚡ ¡MODO DOBLE PUNTOS ACTIVADO! Los puntos valen x2 durante 5 minutos 🎉');
  setTimeout(() => {
    doublePointsActive = false;
    client.say(channel, '⏰ El modo doble puntos ha terminado. ¡Gracias por participar!');
  }, 5 * 60 * 1000);
}

function handleDoublePointsOff(client, channel) {
  doublePointsActive = false;
  client.say(channel, '⏹️ Modo doble puntos desactivado.');
}

function isDoublePoints() {
  return doublePointsActive;
}

module.exports = { handle, isDoublePoints };