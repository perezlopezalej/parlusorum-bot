const fs = require('fs');
const { isDoublePoints, setDoublePoints, setDoublePointsTimer } = require('../utils/state');

const pointsPath = './data/points.json';

// --- Cache en memoria para puntos ---
let pointsCache = null;

function loadPoints() {
  if (pointsCache) return pointsCache;
  if (!fs.existsSync(pointsPath)) { pointsCache = {}; return {}; }
  pointsCache = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));
  return pointsCache;
}

function savePoints(data) {
  pointsCache = data;
  fs.writeFileSync(pointsPath, JSON.stringify(data, null, 2));
}

function getPoints(username) {
  const points = loadPoints();
  return points[username]?.points || 0;
}

// --- Cooldowns con limpieza automática ---
const cooldowns = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of cooldowns) {
    if (now > expiry) cooldowns.delete(key);
  }
}, 30 * 60 * 1000); // Limpiar cada 30 minutos

// --- Handler principal ---
function handle(client, channel, tags, command, args, config, isMod) {
  const username = tags['display-name'];

  // Comandos del config JSON
  if (config.commands[command]) {
    const cmd = config.commands[command];
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

    cooldowns.set(key, now + cmd.cooldown * 1000);
    client.say(channel, cmd.response);
    return;
  }

  // !top10
  if (command === 'top10') return handleTop10(client, channel);

  // !puntos — NUEVO
  if (command === 'puntos') {
    const pts = getPoints(username);
    client.say(channel, `@${username} tienes ${pts} puntos 💰`);
    return;
  }

  // !uptime — NUEVO
  if (command === 'uptime') return handleUptime(client, channel);

  // Comandos de mod
  if (command === 'x2' && isMod) return handleDoublePoints(client, channel);
  if (command === 'x2off' && isMod) return handleDoublePointsOff(client, channel);
}

// --- Top 10 ---
function handleTop10(client, channel) {
  try {
    const points = loadPoints();
    const sorted = Object.entries(points)
      .sort((a, b) => b[1].points - a[1].points)
      .slice(0, 10);

    if (sorted.length === 0) {
      client.say(channel, 'Aún no hay puntos registrados. ¡Empieza a chatear! 💬');
      return;
    }

    const list = sorted
      .map(([user, data], i) => `${i + 1}. ${user} (${data.points} pts)`)
      .join(' | ');

    const msg = `🏆 Top 10: ${list}`;
    client.say(channel, msg.slice(0, 490));
  } catch (err) {
    console.error('Error en top10:', err);
  }
}

// --- Uptime ---
const botStartTime = Date.now();

function handleUptime(client, channel) {
  const elapsed = Date.now() - botStartTime;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);

  let uptime = '';
  if (hours > 0) uptime += `${hours}h `;
  if (minutes > 0) uptime += `${minutes}m `;
  uptime += `${seconds}s`;

  client.say(channel, `⏱️ El bot lleva activo: ${uptime}`);
}

// --- Modo doble puntos ---
function handleDoublePoints(client, channel) {
  setDoublePoints(true);
  client.say(channel, '⚡ ¡MODO DOBLE PUNTOS ACTIVADO! Los puntos valen x2 durante 5 minutos 🎉');

  const timer = setTimeout(() => {
    setDoublePoints(false);
    client.say(channel, '⏰ El modo doble puntos ha terminado. ¡Gracias por participar!');
  }, 5 * 60 * 1000);

  setDoublePointsTimer(timer);
}

function handleDoublePointsOff(client, channel) {
  setDoublePoints(false);
  setDoublePointsTimer(null);
  client.say(channel, '⏹️ Modo doble puntos desactivado.');
}

module.exports = { handle, loadPoints, savePoints, getPoints };
