const fs = require('fs');
const { addPoints } = require('../games/handler');

// --- Datos de usuarios ---
const usersPath = './data/users.json';

function loadUsers() {
  if (!fs.existsSync(usersPath)) return {};
  return JSON.parse(fs.readFileSync(usersPath, 'utf8'));
}

function saveUsers(data) {
  fs.writeFileSync(usersPath, JSON.stringify(data, null, 2));
}

// --- Primer mensaje ---
function checkFirstMessage(client, channel, tags) {
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const users = loadUsers();

  if (!users[userId]) {
    // Usuario nuevo en el canal
    users[userId] = {
      username,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      messageCount: 1,
      firstMessageAlerted: true
    };
    saveUsers(users);
    client.say(channel, `👋 ¡Bienvenid@ @${username} al canal! Es tu primer mensaje aquí, espero que disfrutes del stream 🎉`);
    addPoints(username, 10);
    return;
  }

  // Usuario conocido — actualizar lastSeen y messageCount
  const lastSeen = new Date(users[userId].lastSeen);
  const now = new Date();
  const daysSinceLastSeen = (now - lastSeen) / (1000 * 60 * 60 * 24);

  // Alerta de regreso si lleva más de 7 días sin aparecer
  if (daysSinceLastSeen >= 7) {
    client.say(channel, `🎊 ¡@${username} ha vuelto después de ${Math.floor(daysSinceLastSeen)} días! ¡Bienvenid@ de nuevo! 🔥`);
    addPoints(username, 20);
  }

  users[userId].lastSeen = now.toISOString();
  users[userId].messageCount = (users[userId].messageCount || 0) + 1;
  users[userId].username = username;
  saveUsers(users);

  // Comprobar logros
  checkAchievements(client, channel, username, users[userId]);
}

// --- Lurker Love ---
const lurkerMap = new Map();
const LURKER_THRESHOLD = 15 * 60 * 1000; // 15 minutos sin hablar

function trackLurker(client, channel, tags) {
  const username = tags['display-name'];
  const now = Date.now();

  if (lurkerMap.has(username)) {
    const lastMessage = lurkerMap.get(username);
    if (now - lastMessage >= LURKER_THRESHOLD) {
      client.say(channel, `👀 ¡@${username} ha salido del modo lurker! Gracias por seguir ahí 💜`);
      addPoints(username, 15);
    }
  }

  lurkerMap.set(username, now);
}

// --- Detector de aniversarios ---
function checkAnniversary(client, channel, tags) {
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const users = loadUsers();

  if (!users[userId]?.firstSeen) return;

  const firstSeen = new Date(users[userId].firstSeen);
  const now = new Date();

  const sameDay = firstSeen.getDate() === now.getDate();
  const sameMonth = firstSeen.getMonth() === now.getMonth();
  const years = now.getFullYear() - firstSeen.getFullYear();

  if (sameDay && sameMonth && years > 0) {
    client.say(channel, `🎂 ¡Hoy es el aniversario de @${username} en el canal! ¡Hace ${years} año(s) que estás aquí! 🥳`);
    addPoints(username, 100);
  }
}

// --- Sistema de logros ---
const achievements = [
  { id: 'messages_10', condition: (u) => u.messageCount >= 10, message: '🏅 ¡@{username} ha conseguido el logro "Conversador"! (10 mensajes)' },
  { id: 'messages_100', condition: (u) => u.messageCount >= 100, message: '🥈 ¡@{username} ha conseguido el logro "Habladín"! (100 mensajes)' },
  { id: 'messages_500', condition: (u) => u.messageCount >= 500, message: '🥇 ¡@{username} ha conseguido el logro "Leyenda del chat"! (500 mensajes)' },
];

function checkAchievements(client, channel, username, userData) {
  if (!userData.achievements) userData.achievements = [];

  for (const achievement of achievements) {
    if (!userData.achievements.includes(achievement.id) && achievement.condition(userData)) {
      userData.achievements.push(achievement.id);
      const msg = achievement.message.replace('{username}', username);
      client.say(channel, msg);
      addPoints(username, 50);
    }
  }

  const users = loadUsers();
  const userId = Object.keys(users).find(id => users[id].username === username);
  if (userId) {
    users[userId] = { ...users[userId], ...userData };
    saveUsers(users);
  }
}

// --- Alertas de subs y raids ---
function onSub(client, channel, username) {
  client.say(channel, `🎉 ¡Muchísimas gracias @${username} por suscribirte! ¡Eres increíble! 💜`);
  addPoints(username, 200);
}

function onRaid(client, channel, username, viewers) {
  client.say(channel, `⚔️ ¡RAID de @${username} con ${viewers} viewers! ¡Bienvenidos a todos! 🔥 ¡Vamos a darles un buen recibimiento!`);
}

// --- Handler principal de mensajes ---
function handleMessage(client, channel, tags) {
  checkFirstMessage(client, channel, tags);
  trackLurker(client, channel, tags);
  checkAnniversary(client, channel, tags);
}

module.exports = { handleMessage, onSub, onRaid };