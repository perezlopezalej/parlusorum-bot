// Control de calidad puro de las respuestas de la IA (sin estado ni I/O): tono, repetición, emotes, muertes y cortes.

// Léxico latinoamericano que no encaja con un chat de España
const LATAM_RE = /\b(pucha|puchas|qu[eé] onda|(?:la|esa|esta) onda|[oó]rale|[aá]ndale|chido|chida|ahorita|ch[eé]vere|bac[aá]n|g[uü]ey|wey|parce|boludo|che|vos|platicar|platicamos|padr[ií]simo|no manches)\b/i;

// Rechazos con voz de robot ("No puedo participar en eso", "Lo siento, no puedo ayudar")
const ROBOT_REFUSAL_RE = /\b(no puedo (?:participar|ayudar|ayudarte|responder|continuar|hacer eso|cumplir)|no es algo que (?:haga|pueda)|lo siento|como (?:ia|inteligencia artificial|modelo)|no estoy (?:programado|autorizado)|no me est[aá] permitido|no entiend[eo] esos insultos)\b/i;

// Fórmulas que el cohost repitió hasta el cansancio en el directo del 28-10
const FORMULAS = [
  /pr[oó]xim[ao] ca[ií]da/i,
  /(?:el )?fua (?:se )?(?:est[aá] )?(?:carg(?:a|ando|ándose)|cargado)/i,
  /\bcarg[aá]ndose\b/i,
  /(?:el )?silencio (?:es|se siente|pesa|est[aá])/i,
  /m[aá]s (?:quieto|pesado|denso) que/i,
  /vibra(?:r)? (?:al|como siempre)|hacen vibrar|el chat vibra/i,
  /energ[ií]a (?:pura|fua)/i,
];

// Metáforas de comentarista deportivo: el hook ya no debe sonar a narrador de fútbol
const SPORTS_RE = /\b(f[uú]tbol|gol(?:azo)?|goles|delantero|portero|champions|[aá]rbitro|var|penalti|tiempo extra|comentarista|narrador|estadio|afici[oó]n|liga|mundial|partido|balón)\b/i;

const DEATH_WORDS_RE = /\b(muert[eoa]s?|muri[oó]|morir|mori|ca[ií]das?|ca[ey]ó|caer|cae|caen|caerá|cay[oó]|fallece|palm[oó])\b/i;

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

function hasLatam(text) { return LATAM_RE.test(text); }
function isRobotRefusal(text) { return ROBOT_REFUSAL_RE.test(text); }
function matchesFormula(text) { return FORMULAS.some(re => re.test(text)); }

// Muertes: con contador a 0 no se habla de muertes/caídas; si se cita una cifra debe ser la del contador
function mentionsUnrecordedDeaths(text, deathCount) {
  if (!DEATH_WORDS_RE.test(text)) return false;
  if (!deathCount) return true;
  const nums = [...text.matchAll(/(?:#|n[uú]mero |muerte |ca[ií]da )(\d+)|(\d+)\s*(?:muertes?|ca[ií]das?|veces)/gi)].map(m => parseInt(m[1] || m[2], 10));
  return nums.some(n => n !== deathCount);
}

// Usuarios nombrados en `text` (con o sin @) que ya se nombraron hace menos de windowMs. named: Map<login, ts>
function recentlyNamedIn(text, named, now, windowMs) {
  const t = norm(text);
  const hits = [];
  for (const [login, ts] of named) {
    if (now - ts >= windowMs) continue;
    const re = new RegExp(`(?:^|[^a-z0-9_])@?${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`);
    if (re.test(t)) hits.push(login);
  }
  return hits;
}

// Logins del `candidates` que aparecen en el texto (para marcarlos como nombrados)
function namesIn(text, candidates) {
  const t = norm(text);
  return [...new Set(candidates.map(norm).filter(Boolean))].filter(login => {
    const re = new RegExp(`(?:^|[^a-z0-9_])@?${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`);
    return re.test(t);
  });
}

// --- Emotes: como mucho 1 de cada 3 mensajes ---
const emoteRe = emotes => new RegExp(`(?:${emotes.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
const hasEmote = (text, emotes) => emotes.length > 0 && emoteRe(emotes).test(text);

// Se permite emote solo si ninguno de los 2 últimos mensajes del bot (más recientes al final) llevó
function emoteAllowed(recentBotMessages, emotes) {
  return !recentBotMessages.slice(-2).some(m => hasEmote(m, emotes));
}

function stripEmotes(text, emotes) {
  if (!emotes.length) return text;
  return text.replace(emoteRe(emotes), '').replace(/\s+([,.;:!?…])/g, '$1').replace(/ {2,}/g, ' ').trim();
}

// Aplica la política: sin permiso se quitan todos; con permiso se deja como mucho el primero
function applyEmotePolicy(text, allowed, emotes) {
  if (!emotes.length) return text;
  if (!allowed) return stripEmotes(text, emotes);
  let seen = false;
  return text.replace(emoteRe(emotes), m => (seen ? '' : (seen = true, m))).replace(/ {2,}/g, ' ').replace(/\s+([,.;:!?…])/g, '$1').trim();
}

// --- Repetición: palabras de contenido compartidas con mensajes recientes ---
const contentWords = s => new Set(norm(s).split(/[^a-z0-9]+/).filter(w => w.length >= 5));
function similarity(a, b) {
  const A = contentWords(a), B = contentWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}
function tooSimilar(text, recent, threshold = 0.6) {
  return recent.some(r => similarity(text, r) >= threshold);
}
function repeatsFormula(text, recent) {
  return FORMULAS.some(re => re.test(text) && recent.some(r => re.test(r)));
}

// Validación del cohost. ctx: { deathCount, recent: string[], named: Map, now, nameWindowMs }
function validateCohost(text, { deathCount = 0, recent = [], named = new Map(), now = Date.now(), nameWindowMs = 15 * 60 * 1000 } = {}) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, reason: 'menciona muertes que no están en el contador' };
  const names = recentlyNamedIn(text, named, now, nameWindowMs);
  if (names.length) return { ok: false, reason: `nombra a ${names.join(', ')}, que ya se nombró hace poco; no nombres a nadie` };
  if (matchesFormula(text) && repeatsFormula(text, recent)) return { ok: false, reason: 'repite una fórmula que ya usaste' };
  if (tooSimilar(text, recent)) return { ok: false, reason: 'se parece demasiado a un mensaje reciente' };
  return { ok: true };
}

// Hook anti-silencio: voz de Dios Fua, sin deporte, sin muertes inventadas ni repetir los últimos hooks
function validateHook(text, { deathCount = 0, recent = [] } = {}) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (SPORTS_RE.test(text)) return { ok: false, reason: 'usa metáforas de comentarista deportivo' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, reason: 'menciona muertes que no están en el contador' };
  if (tooSimilar(text, recent)) return { ok: false, reason: 'se parece demasiado a un hook reciente' };
  return { ok: true };
}

// Validación de respuestas a menciones (sin la parte de nombres: se responde al que escribe)
function validateMention(text) {
  if (!text || text.length < 3) return { ok: false, reason: 'vacío' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  return { ok: true };
}

// --- Cortes en final de frase ---
// Fin (exclusivo) de la última frase completa dentro de `limit`; -1 si no hay ninguna razonable
function lastSentenceEnd(text, limit, minRatio = 0.3) {
  const head = text.slice(0, limit);
  let end = -1;
  for (const m of head.matchAll(/[.!?…]+(?=\s|$)/g)) end = m.index + m[0].length;
  return end > 0 && end >= limit * minRatio ? end : -1;
}

// Recorta `text` a `limit` caracteres terminando en frase; sin final de frase, en la última palabra y con punto
function cutAtSentence(text, limit) {
  if (text.length <= limit) return text;
  const end = lastSentenceEnd(text, limit);
  if (end > 0) return text.slice(0, end).trim();
  const head = text.slice(0, limit - 1);
  const sp = head.lastIndexOf(' ');
  if (sp < limit * 0.3) return text.slice(0, limit - 3) + '...';
  return head.slice(0, sp).replace(/[\s,;:¡¿-]+$/, '') + '.';
}

// Respuesta cortada por max_tokens (finish_reason 'length'): se queda con las frases completas si las hay
function dropTrailingFragment(text) {
  const t = String(text || '').trim();
  if (/[.!?…]$/.test(t)) return t;
  const end = lastSentenceEnd(t, t.length, 0.25);
  return end > 0 ? t.slice(0, end).trim() : t.replace(/[\s,;:¡¿-]+$/, '') + '.';
}

module.exports = {
  LATAM_RE, ROBOT_REFUSAL_RE, FORMULAS,
  hasLatam, isRobotRefusal, matchesFormula, mentionsUnrecordedDeaths, recentlyNamedIn, namesIn,
  hasEmote, emoteAllowed, stripEmotes, applyEmotePolicy, similarity, tooSimilar, repeatsFormula,
  validateCohost, validateHook, validateMention, SPORTS_RE, lastSentenceEnd, cutAtSentence, dropTrailingFragment,
};
