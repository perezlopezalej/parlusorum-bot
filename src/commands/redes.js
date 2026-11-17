// Redes sociales del canal (config/redes.json): respuestas de !redes, !discord y !tiktok, dominios permitidos y aviso periódico.
// Funciones puras salvo la lectura del JSON, que se inyecta en los tests.
const defaultRedes = require('../../config/redes.json');
const messages = require('../../config/messages.json').redes;

const COMMANDS = ['redes', 'discord', 'tiktok'];
const USER_COOLDOWN_MS = 60 * 1000;
const GLOBAL_COOLDOWN_MS = 30 * 1000;
const REMINDER_INTERVAL_MS = parseInt(process.env.REDES_INTERVAL_MS || String(60 * 60 * 1000), 10);
const MIN_UPTIME_MS = 10 * 60 * 1000;

const isLink = (v) => typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim());

// Texto de respuesta para el comando, o null si no es de redes o falta el enlace en el JSON
function replyFor(command, redes = defaultRedes) {
  const { discord, tiktok } = redes;
  if (command === 'discord') return isLink(discord) ? messages.discord.replace('{url}', discord.trim()) : null;
  if (command === 'tiktok') return isLink(tiktok) ? messages.tiktok.replace('{url}', tiktok.trim()) : null;
  if (command === 'redes') {
    const parts = [];
    if (isLink(discord)) parts.push(messages.discord.replace('{url}', discord.trim()));
    if (isLink(tiktok)) parts.push(messages.tiktok.replace('{url}', tiktok.trim()));
    return parts.length ? parts.join(' ') : null;
  }
  return null;
}

// Dominios exactos de los enlaces del JSON (sin www.), en minúsculas
function allowedHosts(redes = defaultRedes) {
  const hosts = new Set();
  for (const v of Object.values(redes)) {
    if (!isLink(v)) continue;
    try {
      hosts.add(new URL(v.trim()).hostname.replace(/^www\./, '').toLowerCase());
    } catch {
      /* enlace mal escrito: no se permite nada */
    }
  }
  return [...hosts];
}

// Cooldown por usuario y global compartido entre los tres comandos. Devuelve true si toca esperar; si no, lo registra.
function onCooldown(map, userId, now = Date.now()) {
  const keys = [`redes-user-${userId}`, 'redes-global'];
  if (keys.some((k) => map.has(k) && now < map.get(k))) return true;
  map.set(keys[0], now + USER_COOLDOWN_MS);
  map.set(keys[1], now + GLOBAL_COOLDOWN_MS);
  return false;
}

// ¿Toca el aviso periódico? Con directo de EventSub, sin silencio ni modo reactivo y pasados los primeros 10 minutos
function reminderDue({ live, silenced, reactive, startedAt, now = Date.now() }) {
  if (!live || silenced || reactive) return false;
  return !!startedAt && now - startedAt >= MIN_UPTIME_MS;
}

module.exports = {
  COMMANDS,
  REMINDER_INTERVAL_MS,
  MIN_UPTIME_MS,
  replyFor,
  allowedHosts,
  onCooldown,
  reminderDue,
};
