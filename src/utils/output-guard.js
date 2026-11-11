/**
 * output-guard.js — Defensas en la salida: lo último que se comprueba antes de que un mensaje llegue al chat.
 * Funciones puras (sin estado ni I/O): irc-ratelimit.js las llama justo antes de enviar.
 *
 *  - eco: el bot no repite literalmente lo que escribió un usuario
 *  - ofensivo: términos de filter.js (sin las frases de inyección, que solo valen para la entrada)
 *  - URL: ningún enlace salvo dominios de confianza (twitch.tv, igdb.com)
 *  - directo: sin directo, solo hablan las respuestas a comandos (y el cierre del stream, con margen)
 */
const { containsOffensive } = require('./filter');

const ALLOWED_HOSTS = ['twitch.tv', 'igdb.com'];

// Respuestas directas a un usuario que pueden salir con el canal offline
const DIRECT_ORIGINS = new Set(['comando', 'dios_fua', 'chiste', 'quemeperdi', 'trivia']);

// Orígenes cuyo texto puede coincidir legítimamente con lo que escribe el chat (la respuesta de la trivia)
const ECHO_EXEMPT_ORIGINS = new Set(['trivia']);

// Solo cuenta como eco una copia larga: 6+ palabras seguidas, o 4+ que sean casi todo (80%+) lo que escribió el usuario.
// Repetir parte de la pregunta (un juego, un nombre, "quién desarrolló X") es normal y no salta.
const ECHO_RUN_WORDS = 6;
const ECHO_SHORT_RUN_WORDS = 4;
const ECHO_SHORT_RUN_RATIO = 0.8;
const ECHO_WINDOW_MS = 5 * 60 * 1000;

const TLDS =
  'com|net|org|tv|gg|io|es|ly|me|xyz|co|info|app|dev|ru|cn|tk|ml|ga|cf|gl|link|to|be|fm|ws|cc|biz|online|site|shop|club|live';
// Con esquema, con www., o "dominio.tld" (TLD en minúsculas, para no confundir "genial.Es que" con un dominio)
const URL_RE = new RegExp(
  `(?:https?://|www\\.)[^\\s]+|\\b[A-Za-z0-9][A-Za-z0-9-]*(?:\\.[A-Za-z0-9-]+)*\\.(?:${TLDS})\\b(?:/[^\\s]*)?`,
  'g',
);

function hostOf(match) {
  return match
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#:]/)[0]
    .toLowerCase();
}

// Devuelve la primera URL no permitida del texto, o null
function findDisallowedUrl(text) {
  for (const m of String(text || '').match(URL_RE) || []) {
    const host = hostOf(m);
    if (!ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return m;
  }
  return null;
}

// Minúsculas, sin tildes ni signos, espacios colapsados
function normalizeEcho(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

// Texto que escribió el usuario sin el comando inicial ("!muertes ...") ni @menciones iniciales
function userPayload(text) {
  return normalizeEcho(String(text || '').replace(/^\s*(?:@\S+\s+)*(?:![\wñ]+\s*)?(?:@\S+\s+)*/i, ''));
}

// Quita nombres (usuarios, juegos) del texto normalizado, dejando un separador que corta las rachas de palabras
function maskNames(norm, names) {
  let out = ` ${norm} `;
  for (const n of names || []) {
    const k = normalizeEcho(n);
    if (k.length >= 3) out = out.split(` ${k} `).join(' | ');
  }
  return out.trim();
}

// Racha más larga de palabras seguidas que comparten dos textos ya normalizados
function longestRun(a, b) {
  const x = a.split(' '),
    y = b.split(' ');
  let best = 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1] && x[i - 1] !== '|') {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

// ¿Copia el mensaje del bot una parte larga de lo que escribió algún usuario? recent: [{ text, at }]; names: nombres a ignorar
function findEcho(botText, recent, now = Date.now(), names = []) {
  const bot = maskNames(normalizeEcho(botText), names);
  for (const r of recent || []) {
    if (now - r.at > ECHO_WINDOW_MS) continue;
    const u = maskNames(userPayload(r.text), names);
    const words = u.split(' ').filter((w) => w !== '|').length;
    if (words < ECHO_SHORT_RUN_WORDS) continue;
    const run = longestRun(u, bot);
    if (run >= ECHO_RUN_WORDS || (run >= ECHO_SHORT_RUN_WORDS && run >= words * ECHO_SHORT_RUN_RATIO)) return r.text;
  }
  return null;
}

// ¿Puede el bot hablar ahora? Sin directo solo las respuestas a comandos, salvo en el margen tras el fin del stream
function canSpeak({ origin, live, graceUntil = 0, now = Date.now() }) {
  if (live) return true;
  if (now < graceUntil) return true;
  return DIRECT_ORIGINS.has(origin);
}

// → { ok: true } | { ok: false, reason: 'offline' | 'ofensivo' | 'url' | 'eco' }
function checkOutbound(
  text,
  { origin = 'otro', live = true, graceUntil = 0, recent = [], names = [], now = Date.now() } = {},
) {
  if (!canSpeak({ origin, live, graceUntil, now })) return { ok: false, reason: 'offline' };
  if (containsOffensive(text)) return { ok: false, reason: 'ofensivo' };
  if (findDisallowedUrl(text)) return { ok: false, reason: 'url' };
  if (!ECHO_EXEMPT_ORIGINS.has(origin) && findEcho(text, recent, now, names)) return { ok: false, reason: 'eco' };
  return { ok: true };
}

module.exports = {
  checkOutbound,
  canSpeak,
  findDisallowedUrl,
  findEcho,
  normalizeEcho,
  userPayload,
  DIRECT_ORIGINS,
  ECHO_WINDOW_MS,
};
