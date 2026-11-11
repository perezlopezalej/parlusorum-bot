/**
 * privacy/retention.js — Caducidad automática de datos personales (cada hora).
 *
 *   chat_log          24 h (antes se genera el registro de calidad de las sesiones que aún no lo tienen)
 *   quality_log       30 días
 *   user_facts        90 días sin actualizar (los contadores, como trivia_wins, no: ver usuarios)
 *   users + contadores 1 año sin actividad (last_seen); al borrar un usuario se borran todos sus hechos
 *   cooldowns         los ya caducados
 *
 * Cada paso va aislado: un fallo de Supabase en uno no impide los demás ni afecta al bot.
 */
const logger = require('../utils/logger');
const supabase = require('../utils/supabase');
const { RETENTION_MS: CHAT_MS } = require('../utils/chatlog');

const DAY_MS = 24 * 60 * 60 * 1000;
const LIMITS = {
  chatMs: CHAT_MS,
  qualityMs: 30 * DAY_MS,
  factsMs: 90 * DAY_MS,
  usersMs: 365 * DAY_MS,
};
const INTERVAL_MS = 60 * 60 * 1000;

const iso = (now, ms) => new Date(now - ms).toISOString();

// Ejecuta todas las purgas. beforeChatPurge (p. ej. quality-log.catchUp) corre antes de borrar el chat:
// si falla, el chat NO se borra en esta pasada (se reintenta a la hora siguiente mientras no pase de 2×24 h).
async function runRetention({ now = Date.now(), db = supabase, beforeChatPurge = null, limits = LIMITS } = {}) {
  const result = { chat: 0, quality: 0, users: 0, facts: 0, cooldowns: 0, errors: [] };
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      result.errors.push(`${name}: ${e.message}`);
      return null;
    }
  };

  let canPurgeChat = true;
  if (beforeChatPurge) {
    // Solo se retiene el chat más allá de 24 h si el registro de calidad falla y aún no han pasado 48 h
    const ok = await step('registro de calidad', async () => {
      await beforeChatPurge({ now });
      return true;
    });
    canPurgeChat = ok === true;
  }
  const chatCutoff = canPurgeChat ? iso(now, limits.chatMs) : iso(now, limits.chatMs * 2);
  result.chat = (await step('chat_log', () => db.deleteChatLogBefore(chatCutoff))) || 0;
  result.quality = (await step('quality_log', () => db.deleteQualityLogBefore(iso(now, limits.qualityMs)))) || 0;
  const purged = await step('usuarios', () =>
    db.purgeInactiveUsers({ usersBefore: iso(now, limits.usersMs), factsBefore: iso(now, limits.factsMs) }),
  );
  if (purged) {
    result.users = purged.users;
    result.facts = purged.facts;
  }
  result.cooldowns = (await step('cooldowns', () => db.deleteExpiredCooldowns(new Date(now).toISOString()))) || 0;

  const total = result.chat + result.quality + result.users + result.facts + result.cooldowns;
  if (total > 0) {
    logger.info(
      `🧹 Caducidad: ${result.chat} chat, ${result.quality} calidad, ${result.users} usuarios, ${result.facts} hechos, ${result.cooldowns} cooldowns`,
    );
  }
  for (const e of result.errors) logger.warn(`Caducidad de datos: ${e}`);
  return result;
}

let timer = null;

function start(opts = {}) {
  if (timer || !(process.env.SUPABASE_URL && process.env.SUPABASE_KEY)) return;
  const tick = () => runRetention(opts).catch((e) => logger.warn(`Caducidad de datos: ${e.message}`));
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  tick();
  logger.info('🧹 Caducidad de datos activa (chat 24 h, calidad 30 d, hechos 90 d, usuarios y contadores 1 año)');
}

module.exports = { runRetention, start, LIMITS, INTERVAL_MS };
