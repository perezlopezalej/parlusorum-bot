// Memoria del chat en RAM: historial, buffer del stream, usuarios activos, conversaciones por usuario y cachés de datos por usuario.
const { addLoreSample, noteChatter, setLastCohostContextHash } = require('../utils/state');
const quality = require('./quality');
const { sanitizeForAI } = require('../utils/filter');

const userFactsCache = new Map();

const USER_FACTS_TTL = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userFactsCache) if (now - v.ts > USER_FACTS_TTL) userFactsCache.delete(k);
}, USER_FACTS_TTL);

// Por user_id de Twitch (los hechos no se guardan por nick). Sin id no hay datos.
async function getCachedUserFacts(userId) {
  if (!userId) return [];
  const key = String(userId);
  const cached = userFactsCache.get(key);
  if (cached && Date.now() - cached.ts < USER_FACTS_TTL) return cached.data;
  const { getUserFacts, getUserCounter } = require('../utils/supabase');
  const [facts, wins] = await Promise.all([getUserFacts(key), getUserCounter(key, 'trivia_wins')]);
  // trivia_wins es un contador sin caducidad: se lee aparte del filtro de 30 días
  const data = [...facts.filter(f => f.fact_type !== 'trivia_wins'), ...(wins > 0 ? [{ fact_type: 'trivia_wins', value: String(wins) }] : [])];
  userFactsCache.set(key, { data, ts: Date.now() });
  return data;
}

function clearUserFactsCache() { userFactsCache.clear(); }

// --- Usuarios activos en el stream actual ---
const activeUsersThisStream = new Set();

const activeUserIds = new Map(); // nick en minúsculas → user_id de Twitch

const streamMessageCounts = new Map();

function trackActiveUser(username, userId = null) {
  if (!username) return;
  const lc = username.toLowerCase();
  activeUsersThisStream.add(lc);
  if (userId) activeUserIds.set(lc, String(userId));
}

// { nick: user_id } de los usuarios activos que tienen id (para guardar sus hechos por id)
function getActiveUserIds() {
  return Object.fromEntries(activeUserIds);
}

function getActiveUsers() {
  return [...activeUsersThisStream];
}

const MIN_REGULAR_MESSAGES = 3;

function getActiveUsersWithMinMessages(minCount = MIN_REGULAR_MESSAGES) {
  return [...activeUsersThisStream].filter(u => (streamMessageCounts.get(u) || 0) >= minCount);
}

function resetActiveUsers() {
  activeUsersThisStream.clear();
  activeUserIds.clear();
  streamMessageCounts.clear();
  userConversations.clear();
  setLastCohostContextHash('');
}

const chatHistory = [];

const MAX_HISTORY = 40;

const streamChatBuffer = [];

const MAX_STREAM_BUFFER = 50;

let lastChatMessageTime = Date.now();

const MAX_CONVERSATION_USERS = 200;

function addToHistory(username, message, userId = null) {
  if (message.startsWith('!')) return;
  // No guardar mensajes del propio bot en el historial
  if ((username || '').toLowerCase() === (process.env.BOT_USERNAME || '').toLowerCase()) return;
  const safe = sanitizeForAI(message);
  if (!safe) return;
  noteChatter(username);
  chatHistory.push({ username, message: safe, ts: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  streamChatBuffer.push({ username, message: safe });
  if (streamChatBuffer.length > MAX_STREAM_BUFFER) streamChatBuffer.shift();
  addLoreSample(username, safe, userId);
  lastChatMessageTime = Date.now();
  trackActiveUser(username, userId);
  const lc = (username || '').toLowerCase();
  streamMessageCounts.set(lc, (streamMessageCounts.get(lc) || 0) + 1);
}

function updateLastChatTime() { lastChatMessageTime = Date.now(); }

function getLastChatTime() { return lastChatMessageTime; }

// Mensajes del chat de los últimos windowMs (sin comandos ni bots), del más antiguo al más reciente
function getChatWindow(windowMs = 30 * 60 * 1000, now = Date.now()) {
  return chatHistory.filter(m => now - m.ts <= windowMs).map(m => ({ username: m.username, message: m.message }));
}

function getRecentHistory(n = 6) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  return chatHistory
    .filter(m => m.ts > cutoff)
    .slice(-n)
    .map(m => `${m.username}: ${quality.cleanChatNoise(m.message)}`)
    .join('\n');
}

// --- Memoria de conversacion por usuario ---
const userConversations = new Map();

const sessionStart = Date.now();

const MAX_CONV_TURNS = 5;

const MAX_CONV_AGE = 60 * 60 * 1000;

function getUserConversation(userId) {
  const conv = userConversations.get(userId) || [];
  const cutoff = Date.now() - MAX_CONV_AGE;
  return conv
    .filter(m => m.ts > sessionStart && m.ts > cutoff)
    .map(({ role, content }) => ({ role, content }));
}

function addToUserConversation(userId, role, content) {
  if (userConversations.size >= MAX_CONVERSATION_USERS) {
    const oldest = [...userConversations.entries()]
      .sort((a, b) => (a[1].at(-1)?.ts || 0) - (b[1].at(-1)?.ts || 0))
      .slice(0, 50)
      .map(([k]) => k);
    oldest.forEach(k => userConversations.delete(k));
  }
  const conv = userConversations.get(userId) || [];
  conv.push({ role, content, ts: Date.now() });
  while (conv.length > MAX_CONV_TURNS * 2) conv.shift();
  userConversations.set(userId, conv);
}

// Privacidad (!fua_olvidame): borra de la RAM todo lo de un usuario. Devuelve cuántas cosas quitó.
function forgetUserInMemory({ userId, login }) {
  const nick = String(login || '').toLowerCase();
  let removed = 0;
  const mine = m => !!nick && String(m.username || '').toLowerCase() === nick;
  for (const arr of [chatHistory, streamChatBuffer]) {
    for (let i = arr.length - 1; i >= 0; i--) if (mine(arr[i])) { arr.splice(i, 1); removed++; }
  }
  if (userId) {
    const id = String(userId);
    if (userConversations.delete(id)) removed++;
    if (userFactsCache.delete(id)) removed++;
    if (questionCooldowns.delete(id)) removed++;
  }
  if (nick) {
    if (userConversations.delete(nick)) removed++;
    if (activeUsersThisStream.delete(nick)) removed++;
    activeUserIds.delete(nick);
    streamMessageCounts.delete(nick);
  }
  return removed;
}

const recentMessages = [];

function trackMessage() {
  const now = Date.now();
  recentMessages.push(now);
  while (recentMessages.length > 0 && recentMessages[0] < now - 60000) recentMessages.shift();
  return recentMessages.length;
}

// --- !dios_fua ---
const questionCooldowns = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of questionCooldowns) if (now > v) questionCooldowns.delete(k); }, 30 * 60 * 1000);

function getStreamChatBuffer() {
  return streamChatBuffer.map(m => `${m.username}: ${m.message}`).join('\n');
}

module.exports = { chatHistory, getCachedUserFacts, getRecentHistory, recentMessages, getStreamChatBuffer, getLastChatTime, getUserConversation, addToUserConversation, trackMessage, questionCooldowns, streamChatBuffer, addToHistory, updateLastChatTime, getActiveUsers, getActiveUsersWithMinMessages, resetActiveUsers, clearUserFactsCache, getActiveUserIds, forgetUserInMemory, getChatWindow };
