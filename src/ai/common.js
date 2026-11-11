// Constantes y ayudas compartidas por los módulos de la IA (roles, fallbacks, tipo de usuario, respuestas de identidad).
const channelConfig = require('../../config/channel.json');
const messagesConfig = require('../../config/messages.json');
const identityReplies = require('../../config/identity-replies.json');
const { getStreamIsLive } = require('../utils/state');

const GENERAL_TEMPERATURE = 0.3; // cultura general: menos creatividad, menos datos inventados

// roles claramente definidos
const CREATOR_USERNAME = (channelConfig.creator_username || '').toLowerCase();

const STREAMER_USERNAME = (channelConfig.streamer_username || '').toLowerCase();

// --- Fallbacks en personaje por tipo de error (textos en config/messages.json) ---
const FALLBACK_RESPONSES = messagesConfig.fallback_responses;

function getFallback(type, mention = '') {
  const pool = FALLBACK_RESPONSES[type] || FALLBACK_RESPONSES.error;
  const msg = pool[Math.floor(Math.random() * pool.length)];
  return mention ? `${mention} ${msg}` : msg;
}

function getEventSubLiveStatus() { return getStreamIsLive(); }

function getUserType(username, tags) {
  const lower = username.toLowerCase();
  if (CREATOR_USERNAME && lower === CREATOR_USERNAME) return 'creator';
  if (STREAMER_USERNAME && lower === STREAMER_USERNAME) return 'streamer';
  if (tags?.mod || tags?.['user-type'] === 'mod' || tags?.badges?.moderator) return 'mod';
  if (tags?.subscriber || tags?.badges?.subscriber || tags?.badges?.founder) return 'sub';
  return 'normal';
}

// Mensajes dirigidos con @ a otro usuario (no al bot ni al streamer): conversación entre ellos, no del cohost
const BOT_LOGIN = (process.env.BOT_USERNAME || 'dios_fua').toLowerCase();

function isDirectedElsewhere(message) {
  const m = /^\s*@(\w+)/.exec(String(message || ''));
  if (!m) return false;
  const login = m[1].toLowerCase();
  return login !== BOT_LOGIN && login !== STREAMER_USERNAME && login !== 'parlusorum';
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Respuesta fija a una pregunta de identidad (config/identity-replies.json): rota sin repetir la última de ese tipo
const lastIdentityReply = {};

function pickIdentityReply(kind) {
  const pool = (identityReplies[kind] || []).filter(r => r !== lastIdentityReply[kind]);
  const pick = pool[Math.floor(Math.random() * pool.length)] || '';
  lastIdentityReply[kind] = pick;
  return pick;
}

module.exports = { CREATOR_USERNAME, STREAMER_USERNAME, isDirectedElsewhere, getEventSubLiveStatus, pickRandom, getUserType, GENERAL_TEMPERATURE, getFallback, pickIdentityReply };
