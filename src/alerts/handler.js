const fs = require('fs');
const Groq = require('groq-sdk');
const { getChannelInfo, getFollowerCount } = require('../twitch/api');
const channelConfig = require('../../config/channel.json');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const usersPath = './data/users.json';

// --- Cache en memoria ---
let usersCache = null;

function loadUsers() {
  if (usersCache) return usersCache;
  if (!fs.existsSync(usersPath)) { usersCache = {}; return {}; }
  try {
    usersCache = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  } catch (e) {
    console.error('⚠️ users.json corrupto, reiniciando...');
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

// --- Aniversarios celebrados en esta sesión ---
const anniversaryCelebrated = new Set();

// --- Primer mensaje + regreso + aniversario ---
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

  if (daysSinceLastSeen >= 7) {
    client.say(channel, `🎊 ¡@${username} ha vuelto después de ${Math.floor(daysSinceLastSeen)} días! ¡Bienvenid@ de nuevo! 🔥`);
  }

  userData.lastSeen = now.toISOString();
  userData.messageCount = (userData.messageCount || 0) + 1;
  userData.username = username;

  if (!anniversaryCelebrated.has(userId)) {
    checkAnniversary(client, channel, username, userData, now);
    anniversaryCelebrated.add(userId);
  }

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

// --- Lurker Love ---
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
  const userId = tags['user-id'];
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

// --- Logros ---
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
      client.say(channel, achievement.message.replace('{username}', username));
    }
  }
}

// --- Sub ---
function onSub(client, channel, username) {
  client.say(channel, `🎉 ¡Muchísimas gracias @${username} por suscribirte! ¡Eres increíble! 💜`);
}

// --- Raid contextual inteligente ---
async function onRaid(client, channel, username, viewers) {
  // Mensaje inmediato mientras carga la IA
  client.say(channel, `⚔️ ¡RAID de @${username} con ${viewers} viewers! ¡Bienvenidos a todos! 🔥`);

  // Intentar obtener info del canal raider para personalizar
  try {
    const raidInfo = await getChannelInfo(username);
    const game = raidInfo?.game_name || null;
    const title = raidInfo?.title || null;

    const context = game
      ? `Venían de streamear "${game}"${title ? ` con el título "${title}"` : ''}.`
      : '';

    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `Eres el bot del canal de ${channelConfig.streamer}. ${channelConfig.description} Responde en español. Máximo 400 caracteres.`
        },
        {
          role: 'user',
          content: `El streamer @${username} acaba de hacer un raid al canal con ${viewers} viewers. ${context} Genera un mensaje de bienvenida personalizado, cálido y gracioso para su comunidad. Máximo 1-2 frases. Sin repetir que ya llegaron, eso ya se dijo.`
        }
      ]
    });

    const extra = response.choices[0].message.content.trim();
    if (extra) client.say(channel, extra.slice(0, 490));
  } catch (err) {
    console.error('Error en raid IA:', err.message);
  }
}

// --- Contador de seguidores en hitos ---
let broadcasterId = null;
let lastFollowerCount = null;
const milestones = channelConfig.milestones || [50, 100, 200, 500, 1000];

async function initFollowerTracking(client, channel, id) {
  broadcasterId = id;
  // Obtener count inicial sin celebrar
  lastFollowerCount = await getFollowerCount(broadcasterId);
  console.log(`👥 Seguidores actuales: ${lastFollowerCount}`);
}

async function checkFollowerMilestones(client, channel) {
  if (!broadcasterId) return;

  const current = await getFollowerCount(broadcasterId);
  if (current === null || current === lastFollowerCount) return;

  // Comprobar si se cruzó algún hito
  for (const milestone of milestones) {
    if (lastFollowerCount < milestone && current >= milestone) {
      client.say(channel, `🎊 ¡¡EL CANAL HA LLEGADO A ${milestone} SEGUIDORES!! ¡ESTO ES INCREÍBLE! 🥳🔥 ¡Gracias a todos por hacer esto posible!`);
      console.log(`🎉 Hito alcanzado: ${milestone} seguidores`);
    }
  }

  lastFollowerCount = current;
}

// --- Handler principal ---
function handleMessage(client, channel, tags) {
  checkFirstMessage(client, channel, tags);
  trackLurker(client, channel, tags);
}

module.exports = {
  handleMessage,
  onSub,
  onRaid,
  initFollowerTracking,
  checkFollowerMilestones
};
