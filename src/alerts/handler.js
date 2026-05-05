const fs = require('fs');

const usersPath = './data/users.json';

// --- Cache en memoria para usuarios ---
let usersCache = null;

function loadUsers() {
  if (usersCache) return usersCache;
  if (!fs.existsSync(usersPath)) { usersCache = {}; return {}; }
  try {
    usersCache = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  } catch (e) {
    console.error('⚠️ users.json corrupto o inválido, reiniciando datos...');
    usersCache = {};
  }
  return usersCache;
}

function saveUsers(data) {
  usersCache = data;
  try {
    fs.writeFileSync(usersPath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('⚠️ Error al guardar users.json:', e.message);
  }
}

// --- Control de aniversarios ya celebrados en esta sesión ---
const anniversaryCelebrated = new Set();

// --- Primer mensaje + alerta de regreso + aniversario ---
function checkFirstMessage(client, channel, tags) {
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const users = loadUsers();
  const now = new Date();

  if (!users[userId]) {
    users[userId] = {
      username,
      firstSeen: now.toISOString(),
      lastSeen: now.toISOString(),
      messageCount: 1,
      achievements: []
    };
    saveUsers(users);
    client.say(channel, `👋 ¡Bienvenid@ @${username} al canal! Es tu primer mensaje aquí 🎉`);
    return;
  }

  const userData = users[userId];
  const lastSeen = new Date(userData.lastSeen);
  const daysSinceLastSeen = (now - lastSeen) / (1000 * 60 * 60 * 24);

  // Alerta de regreso (más de 7 días)
  if (daysSinceLastSeen >= 7) {
    client.say(channel, `🎊 ¡@${username} ha vuelto después de ${Math.floor(daysSinceLastSeen)} días! ¡Bienvenid@ de nuevo! 🔥`);
  }

  // Actualizar datos
  userData.lastSeen = now.toISOString();
  userData.messageCount = (userData.messageCount || 0) + 1;
  userData.username = username;

  // Comprobar aniversario (solo una vez por sesión por usuario)
  if (!anniversaryCelebrated.has(userId)) {
    checkAnniversary(client, channel, username, userData, now);
    anniversaryCelebrated.add(userId);
  }

  // Comprobar logros (antes de guardar, para que los achievements se incluyan)
  checkAchievements(client, channel, username, userData);

  saveUsers(users);
}

// --- Aniversario ---
function checkAnniversary(client, channel, username, userData, now) {
  if (!userData.firstSeen) return;

  const firstSeen = new Date(userData.firstSeen);
  const sameDay = firstSeen.getDate() === now.getDate();
  const sameMonth = firstSeen.getMonth() === now.getMonth();
  const years = now.getFullYear() - firstSeen.getFullYear();

  if (sameDay && sameMonth && years > 0) {
    client.say(channel, `🎂 ¡Hoy es el aniversario de @${username} en el canal! ¡Hace ${years} año(s) que estás aquí! 🥳`);
  }
}

// --- Lurker Love con limpieza automática ---
const lurkerMap = new Map();
const LURKER_THRESHOLD = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  const limit = 24 * 60 * 60 * 1000;
  for (const [user, time] of lurkerMap) {
    if (now - time > limit) lurkerMap.delete(user);
  }
}, 60 * 60 * 1000);

function trackLurker(client, channel, tags) {
  const userId = tags['user-id']; // usar user-id como clave
  const username = tags['display-name'];
  const now = Date.now();

  if (lurkerMap.has(userId)) {
    const lastMessage = lurkerMap.get(userId);
    if (now - lastMessage >= LURKER_THRESHOLD) {
      client.say(channel, `👀 ¡@${username} ha salido del modo lurker! Gracias por seguir ahí 💜`);
    }
  }

  lurkerMap.set(userId, now);
}

// --- Sistema de logros (sin puntos) ---
const achievementsList = [
  { id: 'messages_10', condition: (u) => u.messageCount >= 10, message: '🏅 ¡@{username} ha conseguido el logro "Conversador"! (10 mensajes)' },
  { id: 'messages_100', condition: (u) => u.messageCount >= 100, message: '🥈 ¡@{username} ha conseguido el logro "Habladín"! (100 mensajes)' },
  { id: 'messages_500', condition: (u) => u.messageCount >= 500, message: '🥇 ¡@{username} ha conseguido el logro "Leyenda del chat"! (500 mensajes)' },
];

function checkAchievements(client, channel, username, userData) {
  if (!userData.achievements) userData.achievements = [];

  for (const achievement of achievementsList) {
    if (!userData.achievements.includes(achievement.id) && achievement.condition(userData)) {
      userData.achievements.push(achievement.id);
      const msg = achievement.message.replace('{username}', username);
      client.say(channel, msg);
    }
  }
}

// --- Alertas de subs y raids ---
function onSub(client, channel, username) {
  client.say(channel, `🎉 ¡Muchísimas gracias @${username} por suscribirte! ¡Eres increíble! 💜`);
}

function onRaid(client, channel, username, viewers) {
  client.say(channel, `⚔️ ¡RAID de @${username} con ${viewers} viewers! ¡Bienvenidos a todos! 🔥`);
}

// --- Handler principal ---
function handleMessage(client, channel, tags) {
  checkFirstMessage(client, channel, tags);
  trackLurker(client, channel, tags);
}

module.exports = { handleMessage, onSub, onRaid };
