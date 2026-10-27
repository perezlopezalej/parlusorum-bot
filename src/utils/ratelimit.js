/**
 * ratelimit.js — Rate limiter diferenciado por tipo de usuario
 * Mods y el creador tienen más margen que usuarios normales.
 */

const logger = require('./logger');

const MAX_RPM_GLOBAL = parseInt(process.env.AI_MAX_RPM || '20', 10);
const MAX_RPM_USER = parseInt(process.env.AI_MAX_RPM_USER || '3', 10);    // 3 por minuto usuario normal
const MAX_RPM_MOD = parseInt(process.env.AI_MAX_RPM_MOD || '8', 10);      // 8 por minuto para mods
const MAX_RPM_CREATOR = parseInt(process.env.AI_MAX_RPM_CREATOR || '15', 10); // 15 para el creador

// Rate limiter global — protege el límite de Groq
const globalTimestamps = [];

function canMakeRequest() {
  const now = Date.now();
  const cutoff = now - 60000;
  while (globalTimestamps.length > 0 && globalTimestamps[0] < cutoff) globalTimestamps.shift();
  if (globalTimestamps.length >= MAX_RPM_GLOBAL) return false;
  globalTimestamps.push(now);
  return true;
}

// Rate limiter por usuario
const userTimestamps = new Map();
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 60000;
  for (const [userId, timestamps] of userTimestamps) {
    const filtered = timestamps.filter(ts => ts > cutoff);
    if (filtered.length === 0) userTimestamps.delete(userId);
    else userTimestamps.set(userId, filtered);
  }
}, 2 * 60 * 1000);

function canUserMakeRequest(userId, userType = 'normal') {
  const now = Date.now();
  const cutoff = now - 60000;
  const timestamps = (userTimestamps.get(userId) || []).filter(ts => ts > cutoff);

  const limit = userType === 'creator' || userType === 'streamer' ? MAX_RPM_CREATOR
    : userType === 'mod' ? MAX_RPM_MOD
    : MAX_RPM_USER;

  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  userTimestamps.set(userId, timestamps);
  return true;
}

function getRequestsRemaining() {
  const now = Date.now();
  const cutoff = now - 60000;
  const recent = globalTimestamps.filter(ts => ts > cutoff);
  return Math.max(0, MAX_RPM_GLOBAL - recent.length);
}

module.exports = { canMakeRequest, canUserMakeRequest, getRequestsRemaining };
