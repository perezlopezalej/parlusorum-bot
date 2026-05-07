const fs = require('fs');
const Groq = require('groq-sdk');
const { getChannelInfo, getFollowerCount } = require('../twitch/api');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const usersPath = require('path').join(__dirname, '../../data/users.json');

// --- Cache con escritura diferida ---
let usersCache = null;
let saveTimer = null;

function loadUsers() {
  if (usersCache) return usersCache;
  if (!fs.existsSync(usersPath)) { usersCache = {}; return {}; }
  try {
    usersCache = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  } catch (e) {
    logger.error('users.json corrupto, reiniciando...');
    usersCache = {};
  }
  return usersCache;
}

function saveUsers(data) {
  usersCache = data;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(usersPath, JSON.stringify(usersCache, null, 2));
    } catch (e) {
      logger.error(`Error al guardar users.json: ${e.message}`);
    }
    saveTimer = null;
  }, 5000);
}

// --- Mensajes variados ---
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const welcomeMessages = [
  '👋 ¡Bienvenid@ @{username}! Es tu primer mensaje aquí 🎉 Si tienes alguna pregunta usa !dios_fua',
  '🎊 ¡Ey @{username}! Primera vez por aquí, ¡qué alegría! 💜 ¡Pregúntame lo que quieras con !dios_fua!',
  '✨ ¡@{username} entra al chat por primera vez! ¡Bienvenid@! 🔥 Usa !comandos para ver qué puedo hacer',
  '🌟 ¡@{username} estrena su primer mensaje! ¡Bienvenid@! 👋 ¡El FUA te da la bienvenida! 💪',
];

const returnMessages = [
  '🎊 ¡@{username} ha vuelto después de {days} días! ¡Bienvenid@ de nuevo! 🔥',
  '👀 ¡@{username} resucita después de {days} días! ¡Cuánto tiempo! 🎉',
  '🥳 ¡Ha vuelto @{username} después de {days} días! ¡El canal estaba incompleto sin ti! 💜',
];

const lurkerMessages = [
  '👀 ¡@{username} ha salido del modo lurker! Gracias por seguir ahí 💜',
  '🕵️ ¡@{username} sale de las sombras! Sabíamos que estabas ahí 😏',
  '🐱 ¡@{username} vuelve al chat! El lurker ha hablado 🎉',
  '🌙 ¡@{username} abandona el modo fantasma! ¡Bienvenid@ de vuelta! 👋',
];

const subMessages = [
  '🎉 ¡Muchísimas gracias @{username} por suscribirte! ¡Eres increíble! 💜',
  '💜 ¡@{username} se ha suscrito! ¡La familia crece! ¡Gracias! 🎊',
  '🥳 ¡@{username} acaba de suscribirse! ¡Eres un crack! 🔥',
  '⭐ ¡Nuevo suscriptor! ¡Bienvenid@ al club @{username}! 💜🎉',
];

// --- Control de aniversarios ---
const anniversaryCelebrated = new Set();
const MAX_ANNIVERSARY_SET = 500;

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
    client.say(channel, pick(welcomeMessages).replace('{username}', username));
    return;
  }

  const userData = users[userId];
  const lastSeen = new Date(userData.lastSeen);
  const daysSinceLastSeen = (now - lastSeen) / (1000 * 60 * 60 * 24);

  if (daysSinceLastSeen >= 7) {
    const msg = pick(returnMessages)
      .replace('{username}', username)
      .replace('{days}', Math.floor(daysSinceLastSeen));
    client.say(channel, msg);
  }

  userData.lastSeen = now.toISOString();
  userData.messageCount = (userData.messageCount || 0) + 1;
  userData.username = username;

  if (!anniversaryCelebrated.has(userId)) {
    if (anniversaryCelebrated.size >= MAX_ANNIVERSARY_SET) anniversaryCelebrated.clear();
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
const LURKER_THRESHOLD = parseInt(process.env.LURKER_THRESHOLD_MS || String(15 * 60 * 1000), 10);

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
      client.say(channel, pick(lurkerMessages).replace('{username}', username));
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
  client.say(channel, pick(subMessages).replace('{username}', username));
}

// --- Bits ---
function onBits(client, channel, username, bits) {
  if (bits >= 1000) {
    client.say(channel, `💎 ¡¡WOW!! ¡@${username} acaba de donar ${bits} bits! ¡INCREÍBLE! ¡Muchísimas gracias! 🔥🔥🔥`);
  } else if (bits >= 100) {
    client.say(channel, `💜 ¡@${username} ha donado ${bits} bits! ¡Muchas gracias por el apoyo! 🎉`);
  } else {
    client.say(channel, `✨ ¡Gracias @${username} por los ${bits} bits! 💜`);
  }
}

// --- Raid contextual ---
async function onRaid(client, channel, username, viewers) {
  client.say(channel, `⚔️ ¡RAID de @${username} con ${viewers} viewers! ¡Bienvenidos a todos! 🔥`);

  try {
    const raidInfo = await getChannelInfo(username);
    const game = raidInfo?.game_name || null;
    const context = game ? `Venían de streamear "${game}".` : '';

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `Eres el bot del canal de ${channelConfig.streamer}. ${channelConfig.description} Responde SIEMPRE en español. Máximo 400 caracteres.`
        },
        {
          role: 'user',
          content: `@${username} ha hecho raid con ${viewers} viewers. ${context} Genera un mensaje de bienvenida personalizado, cálido y gracioso. Máximo 1-2 frases. Sin repetir que ya llegaron.`
        }
      ]
    });

    const extra = response.choices[0].message.content.trim();
    if (extra) client.say(channel, extra.slice(0, 490));
  } catch (err) {
    logger.error(`Error en raid IA: ${err.message}`);
  }
}

// --- Hitos de seguidores ---
let broadcasterId = null;
let lastFollowerCount = null;
const milestones = channelConfig.milestones || [50, 100, 200, 500, 1000];

async function initFollowerTracking(client, channel, id) {
  broadcasterId = id;
  lastFollowerCount = await getFollowerCount(broadcasterId);
  logger.info(`👥 Seguidores actuales: ${lastFollowerCount}`);
}

async function checkFollowerMilestones(client, channel) {
  if (!broadcasterId) return;
  const current = await getFollowerCount(broadcasterId);
  if (current === null || current === lastFollowerCount) return;

  for (const milestone of milestones) {
    if (lastFollowerCount < milestone && current >= milestone) {
      client.say(channel, `🎊 ¡¡EL CANAL HA LLEGADO A ${milestone} SEGUIDORES!! ¡INCREÍBLE! 🥳🔥 ¡Gracias a todos!`);
      logger.info(`🎉 Hito: ${milestone} seguidores`);
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
  onBits,
  onRaid,
  initFollowerTracking,
  checkFollowerMilestones
};
