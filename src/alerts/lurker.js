// «Sale de las sombras»: aviso cuando alguien que llevaba mucho sin escribir vuelve al chat. Función pura.
// 17-11: cuatro avisos a habituales que habían hablado poco antes. Ahora solo para quien de verdad estaba en la sombra:
// ni VIP, mods o suscriptores, ni habituales por mensajes (REGULAR_MIN_MESSAGES), y tras un silencio largo (45 min por defecto).

const LURKER_THRESHOLD_MS = parseInt(process.env.LURKER_THRESHOLD_MS || String(45 * 60 * 1000), 10);
const REGULAR_MIN_MESSAGES = parseInt(process.env.LURKER_REGULAR_MIN_MESSAGES || '100', 10);

// VIP, mod, streamer o suscriptor (insignias de Twitch)
function hasChannelBadge(tags = {}) {
  const b = tags.badges || {};
  return !!(
    tags.mod ||
    tags['user-type'] === 'mod' ||
    b.broadcaster ||
    b.moderator ||
    b.vip ||
    b.subscriber ||
    b.founder
  );
}

// ¿Habitual del canal? Por insignia o por volumen de mensajes (userData.messageCount, ya contado el actual)
function isChannelRegular(tags, userData, minMessages = REGULAR_MIN_MESSAGES) {
  return hasChannelBadge(tags) || (Number(userData?.messageCount) || 0) >= minMessages;
}

// lastSeenAt: ms del mensaje anterior de esta persona en este directo (0 = no se la ha visto)
function shouldGreetLurker({
  tags = {},
  userData = null,
  lastSeenAt = 0,
  now = Date.now(),
  greeted = false,
  thresholdMs = LURKER_THRESHOLD_MS,
  minMessages = REGULAR_MIN_MESSAGES,
} = {}) {
  if (greeted || !lastSeenAt) return false;
  if (now - lastSeenAt < thresholdMs) return false;
  return !isChannelRegular(tags, userData, minMessages);
}

module.exports = { shouldGreetLurker, isChannelRegular, hasChannelBadge, LURKER_THRESHOLD_MS, REGULAR_MIN_MESSAGES };
