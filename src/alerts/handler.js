const { getChannelInfo, getFollowerCount, getCurrentGame } = require('../twitch/api');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');
const { loadUsers, saveUsers } = require('../utils/storage');
const { setRaidActive } = require('../utils/state');
const { canMakeRequest } = require('../utils/ratelimit');
const { sanitizeForAI } = require('../utils/filter');
const { groqWithRetry, truncate } = require('../utils/groq-utils');

const BOT_NAME = (process.env.BOT_USERNAME || '').toLowerCase();
const STREAMER_USERNAME = (channelConfig.streamer_username || 'parlusorum').toLowerCase();

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const welcomeMessages = [
  '👋 Bienvenid@ @{username}! Es tu primer mensaje aqui 🎉 Si tienes alguna pregunta usa !dios_fua',
  '🎊 Ey @{username}! Primera vez por aqui, que alegria! 💜 Preguntame lo que quieras con !dios_fua!',
  '✨ @{username} entra al chat por primera vez! Bienvenid@! 🔥 Usa !comandos para ver que puedo hacer',
  '🌟 @{username} estrena su primer mensaje! Bienvenid@! 👋 El FUA te da la bienvenida! 💪',
];

const returnMessages = [
  '🎊 @{username} ha vuelto despues de {days} dias! Bienvenid@ de nuevo! 🔥',
  '👀 @{username} resucita despues de {days} dias! Cuanto tiempo! 🎉',
  '🥳 Ha vuelto @{username} despues de {days} dias! El canal estaba incompleto sin ti! 💜',
];

const lurkerMessages = [
  '👀 @{username} ha salido del modo lurker! Gracias por seguir ahi 💜',
  '🕵️ @{username} sale de las sombras! Sabiamos que estabas ahi 😏',
  '🐱 @{username} vuelve al chat! El lurker ha hablado 🎉',
  '🌙 @{username} abandona el modo fantasma! Bienvenid@ de vuelta! 👋',
];

const subMessages = [
  '🎉 Muchisimas gracias @{username} por suscribirte! Eres increible! 💜',
  '💜 @{username} se ha suscrito! La familia crece! Gracias! 🎊',
  '🥳 @{username} acaba de suscribirse! Eres un crack! 🔥',
  '⭐ Nuevo suscriptor! Bienvenid@ al club @{username}! 💜🎉',
];

const anniversaryCelebrated = new Set();
const MAX_ANNIVERSARY_SET = 500;

// --- Throttle de mensajes salientes ---
const messageQueue = [];
let messageTimer = null;

function throttleSay(client, channel, msg) {
  messageQueue.push({ client, channel, msg });
  if (!messageTimer) processMessageQueue();
}

function processMessageQueue() {
  if (messageQueue.length === 0) { messageTimer = null; return; }
  const { client, channel, msg } = messageQueue.shift();
  try { client.say(channel, msg); } catch {}
  messageTimer = setTimeout(processMessageQueue, 1600);
}

// --- Primer mensaje ---
async function checkFirstMessage(client, channel, tags) {
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const usernameLower = username.toLowerCase();

  if (usernameLower === BOT_NAME || usernameLower === STREAMER_USERNAME) return;

  const users = await loadUsers();
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

    if (canMakeRequest()) {
      try {
        const gameInfo = await getCurrentGame().catch(() => null);
        const game = gameInfo?.game ? ` Estan jugando a "${gameInfo.game}".` : '';
        const safeUsername = sanitizeForAI(username) || 'usuario';
        const response = await groqWithRetry({
          max_tokens: 60,
          messages: [
            {
              role: 'system',
              content: `Eres dios_fua, bot del canal de ${channelConfig.streamer}.${game} @${safeUsername} acaba de escribir su PRIMER mensaje en el canal. Dale la bienvenida de forma unica, calida y con personalidad.${game ? ' Menciona el juego de forma natural si encaja.' : ''} Sin presentarte. SIEMPRE en espanol. Max 1 frase corta.`
            },
            { role: 'user', content: `Bienvenida para @${safeUsername}` }
          ]
        });
        throttleSay(client, channel, truncate(response.choices[0].message.content));
      } catch {
        throttleSay(client, channel, pick(welcomeMessages).replace('{username}', username));
      }
    } else {
      throttleSay(client, channel, pick(welcomeMessages).replace('{username}', username));
    }
    return;
  }

  const userData = users[userId];
  const lastSeen = new Date(userData.lastSeen);
  const daysSinceLastSeen = (now - lastSeen) / (1000 * 60 * 60 * 24);

  if (daysSinceLastSeen >= 7) {
    throttleSay(client, channel, pick(returnMessages)
      .replace('{username}', username)
      .replace('{days}', Math.floor(daysSinceLastSeen)));
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

function checkAnniversary(client, channel, username, userData, now) {
  if (!userData.firstSeen) return;
  const firstSeen = new Date(userData.firstSeen);
  const sameDay = firstSeen.getDate() === now.getDate();
  const sameMonth = firstSeen.getMonth() === now.getMonth();
  const years = now.getFullYear() - firstSeen.getFullYear();
  if (sameDay && sameMonth && years > 0) {
    throttleSay(client, channel, `🎂 Hoy es el aniversario de @${username} en el canal! Hace ${years} año(s) que estas aqui! 🥳`);
  }
}

// --- Lurker Love --- FIX #2: no disparar lurker en los primeros minutos del stream
const lurkerMap = new Map();
const LURKER_THRESHOLD = parseInt(process.env.LURKER_THRESHOLD_MS || String(15 * 60 * 1000), 10);

// FIX #2: timestamp de inicio del stream actual
let streamOnlineTimestamp = 0;

// Llamar esto cuando EventSub detecta stream.online
function onStreamOnline() {
  streamOnlineTimestamp = Date.now();
  // Limpiar el lurkerMap para que nadie dispare el lurker
  // al hablar por primera vez nada mas empieza el stream
  lurkerMap.clear();
  logger.info('Lurker map limpiado por inicio de stream');
}

setInterval(() => {
  const now = Date.now();
  for (const [user, time] of lurkerMap) {
    if (now - time > 24 * 60 * 60 * 1000) lurkerMap.delete(user);
  }
}, 60 * 60 * 1000);

function trackLurker(client, channel, tags) {
  const userId = tags['user-id'];
  const username = tags['display-name'];
  if (username.toLowerCase() === BOT_NAME || username.toLowerCase() === STREAMER_USERNAME) return;

  const now = Date.now();

  // FIX #2: no disparar lurker en los primeros LURKER_THRESHOLD ms del stream
  // Si el stream acaba de arrancar, no contar como lurker
  if (streamOnlineTimestamp > 0 && now - streamOnlineTimestamp < LURKER_THRESHOLD) {
    lurkerMap.set(userId, now);
    return;
  }

  if (lurkerMap.has(userId) && now - lurkerMap.get(userId) >= LURKER_THRESHOLD) {
    throttleSay(client, channel, pick(lurkerMessages).replace('{username}', username));
  }
  lurkerMap.set(userId, now);
}

// --- Logros ---
const achievementsList = [
  { id: 'messages_10', condition: u => u.messageCount >= 10, message: '🏅 @{username} ha conseguido el logro "Conversador"! (10 mensajes)' },
  { id: 'messages_100', condition: u => u.messageCount >= 100, message: '🥈 @{username} ha conseguido el logro "Habladín"! (100 mensajes)' },
  { id: 'messages_500', condition: u => u.messageCount >= 500, message: '🥇 @{username} ha conseguido el logro "Leyenda del chat"! (500 mensajes)' },
];

function checkAchievements(client, channel, username, userData) {
  if (!userData.achievements) userData.achievements = [];
  for (const achievement of achievementsList) {
    if (!userData.achievements.includes(achievement.id) && achievement.condition(userData)) {
      userData.achievements.push(achievement.id);
      throttleSay(client, channel, achievement.message.replace('{username}', username));
    }
  }
}

function onSub(client, channel, username) {
  throttleSay(client, channel, pick(subMessages).replace('{username}', username));
}

function onBits(client, channel, username, bits) {
  if (bits >= 1000) throttleSay(client, channel, `💎 WOW! @${username} acaba de donar ${bits} bits! INCREIBLE! 🔥🔥🔥`);
  else if (bits >= 100) throttleSay(client, channel, `💜 @${username} ha donado ${bits} bits! Muchas gracias! 🎉`);
  else throttleSay(client, channel, `✨ Gracias @${username} por los ${bits} bits! 💜`);
}

async function onRaid(client, channel, username, viewers) {
  client.say(channel, `⚔️ RAID de @${username} con ${viewers} viewers! Bienvenidos a todos! 🔥`);
  if (!canMakeRequest()) { setRaidActive(username); return; }
  try {
    const raidInfo = await getChannelInfo(username);
    const game = raidInfo?.game_name || null;
    const context = game ? `Venian de streamear "${game}".` : '';
    const response = await groqWithRetry({
      max_tokens: 100,
      messages: [
        { role: 'system', content: `Eres el bot del canal de ${channelConfig.streamer}. Responde SIEMPRE en espanol. Maximo 400 caracteres.` },
        { role: 'user', content: `@${username} ha hecho raid con ${viewers} viewers. ${context} Genera un mensaje de bienvenida personalizado y gracioso. Maximo 1-2 frases.` }
      ]
    });
    const extra = response.choices[0].message.content.trim();
    if (extra) client.say(channel, truncate(extra));
  } catch (err) { logger.error(`Error en raid IA: ${err.message}`); }

  setRaidActive(username);
}

let broadcasterId = null;
let lastFollowerCount = null;
const milestones = channelConfig.milestones || [50, 100, 200, 500, 1000];

async function initFollowerTracking(client, channel, id) {
  broadcasterId = id;
  lastFollowerCount = await getFollowerCount(broadcasterId);
  logger.info(`Seguidores actuales: ${lastFollowerCount}`);
}

async function checkFollowerMilestones(client, channel) {
  if (!broadcasterId) return;
  const current = await getFollowerCount(broadcasterId);
  if (current === null || current === lastFollowerCount) return;
  for (const milestone of milestones) {
    if (lastFollowerCount < milestone && current >= milestone) {
      client.say(channel, `🎊 EL CANAL HA LLEGADO A ${milestone} SEGUIDORES!! INCREIBLE! 🥳🔥`);
    }
  }
  lastFollowerCount = current;
}

async function handleMessage(client, channel, tags) {
  const botName = (process.env.BOT_USERNAME || '').toLowerCase();
  if (tags['display-name']?.toLowerCase() === botName) return;
  if (tags['username']?.toLowerCase() === botName) return;
  await checkFirstMessage(client, channel, tags);
  trackLurker(client, channel, tags);
}

module.exports = {
  handleMessage, onSub, onBits, onRaid, initFollowerTracking,
  checkFollowerMilestones, onStreamOnline, throttleSay
};
