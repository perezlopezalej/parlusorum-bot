/**
 * privacy/commands.js — !fua_olvidame, !fua_olvidar @usuario (mods) y !privacidad.
 * Los textos viven en config/messages.json → "privacidad".
 */
const messages = require('../../config/messages.json').privacidad;
const channelConfig = require('../../config/channel.json');
const { truncate } = require('../utils/groq-utils');
const logger = require('../utils/logger');
const { forgetUser } = require('./forget');

const COOLDOWN_MS = 60 * 1000;
const PRIVACY_COOLDOWN_MS = 30 * 1000;
const cooldowns = new Map(); // `${comando}-${quien}` → hasta cuándo
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of cooldowns) if (v < now) cooldowns.delete(k);
  },
  10 * 60 * 1000,
).unref();

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// Cuentas a las que un mod no puede borrar los datos: el bot, el streamer y el canal
function protectedNames() {
  return new Set(
    [process.env.BOT_USERNAME, process.env.CHANNEL, channelConfig.streamer_username, channelConfig.creator_username]
      .map((n) =>
        String(n || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

function onCooldown(key, ms, now) {
  if ((cooldowns.get(key) || 0) > now) return true;
  cooldowns.set(key, now + ms);
  return false;
}

// user_id de un nick: primero users (ya visto en el chat) y, si no, Helix
async function resolveUserId(login) {
  try {
    const { loadUsers } = require('../utils/storage');
    const users = await loadUsers();
    const entry = Object.entries(users || {}).find(([, u]) => String(u.username || '').toLowerCase() === login);
    if (entry) return entry[0];
  } catch (e) {
    logger.warn(`!fua_olvidar: no se pudo leer users: ${e.message}`);
  }
  try {
    return await require('../twitch/api').getUserIdByLogin(login);
  } catch {
    return null;
  }
}

// !fua_olvidame: cualquiera borra sus propios datos
async function handleForgetMe(client, channel, tags, deps = {}) {
  const { forget = forgetUser, now = Date.now() } = deps;
  const username = tags['display-name'] || tags.username;
  const userId = tags['user-id'] || null;
  const login = String(tags.username || username || '').toLowerCase();
  if (!userId && !login) return;
  if (onCooldown(`me-${userId || login}`, COOLDOWN_MS, now)) {
    return client.say(channel, truncate(fill(messages.cooldown, { username })));
  }
  try {
    const res = await forget({ userId, login });
    if (res.ok) logger.info(`🧹 Datos olvidados a petición de ${login}`);
    else logger.warn(`!fua_olvidame ${login}: ${res.errors.join('; ')}`);
    return client.say(channel, truncate(fill(res.ok ? messages.forgot_me : messages.forgot_error, { username })));
  } catch (e) {
    logger.error(`!fua_olvidame: ${e.message}`);
    return client.say(channel, truncate(fill(messages.forgot_error, { username })));
  }
}

// !fua_olvidar @usuario: solo mods
async function handleForgetUser(client, channel, tags, args, isMod, deps = {}) {
  const { forget = forgetUser, resolveId = resolveUserId, now = Date.now() } = deps;
  const username = tags['display-name'] || tags.username;
  if (!isMod) return client.say(channel, truncate(fill(messages.mods_only, { username })));
  const target = String(args[1] || '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
  if (!/^\w{3,25}$/.test(target)) return client.say(channel, truncate(fill(messages.usage_olvidar, { username })));
  if (protectedNames().has(target)) return client.say(channel, truncate(fill(messages.not_allowed, { username })));
  if (onCooldown(`olvidar-${tags['user-id'] || username}`, COOLDOWN_MS / 2, now)) {
    return client.say(channel, truncate(fill(messages.cooldown, { username })));
  }
  try {
    const userId = await resolveId(target);
    const res = await forget({ userId, login: target });
    if (res.ok) logger.info(`🧹 Datos de ${target} olvidados a petición del mod ${username}`);
    else logger.warn(`!fua_olvidar ${target}: ${res.errors.join('; ')}`);
    return client.say(
      channel,
      truncate(fill(res.ok ? messages.forgot_user : messages.forgot_error, { username, target })),
    );
  } catch (e) {
    logger.error(`!fua_olvidar: ${e.message}`);
    return client.say(channel, truncate(fill(messages.forgot_error, { username, target })));
  }
}

// !privacidad: resumen corto (cooldown global)
function handlePrivacy(client, channel, tags, deps = {}) {
  const { now = Date.now() } = deps;
  if (onCooldown('privacidad', PRIVACY_COOLDOWN_MS, now)) return;
  const username = tags['display-name'] || tags.username;
  return client.say(channel, truncate(fill(messages.summary, { username })));
}

module.exports = { handleForgetMe, handleForgetUser, handlePrivacy, protectedNames, _cooldowns: cooldowns };
