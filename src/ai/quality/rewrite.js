// Arreglos del texto ya generado: recortes por frase, muletillas, nicks y nombres.
const { isCutOff } = require('./form');

// Todo mensaje del bot sale en una sola línea y con las palabras separadas: los saltos de línea (\n, \r, U+2028/2029), los
// espacios raros que escriben los modelos (NBSP, U+202F, finos...) y el espacio de ancho cero entre palabras pasan a un espacio;
// el guion blando y U+2060 se quitan (U+200D se respeta: une los emojis). Tras .!?… pegado a ¿/¡ va un espacio.
function oneLine(text) {
  return String(text ?? '')
    .replace(/[\s\u0085\u200b]+/g, ' ')
    .replace(/[\u00ad\u2060]/g, '')
    .replace(/([.!?…])(?=[¿¡])/g, '$1 ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// --- Lectura en voz alta: el canal usa un lector (TTS) que lee todo lo que escribe el bot ---
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const joinSpoken = (parts) =>
  parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0] || '';

// Minutos → «2 horas y 49 minutos», «1 hora», «49 minutos» (nunca «2h 49m»)
function spokenDuration(totalMinutes) {
  const mins = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const parts = [];
  if (h) parts.push(plural(h, 'hora', 'horas'));
  if (m) parts.push(plural(m, 'minuto', 'minutos'));
  return parts.length ? joinSpoken(parts) : 'menos de un minuto';
}

// Segundos → «30 segundos», «1 minuto y 5 segundos»
function spokenSeconds(totalSeconds) {
  const secs = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const parts = [];
  if (h) parts.push(plural(h, 'hora', 'horas'));
  if (m) parts.push(plural(m, 'minuto', 'minutos'));
  if (s || !parts.length) parts.push(plural(s, 'segundo', 'segundos'));
  return joinSpoken(parts);
}

const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_@#])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;
const unitRe = (body) => new RegExp(NOT_WORD_BEFORE + body + NOT_WORD_AFTER, 'giu');
const SPOKEN_HM_RE = unitRe(String.raw`(\d+)\s*h\s*(?:y\s*)?(\d+)\s*(?:m|min)`);
const SPOKEN_H_RE = unitRe(String.raw`(\d+)\s*h`);
const SPOKEN_MIN_RE = unitRe(String.raw`(\d+)\s*(?:m|min|mins)`);
const SPOKEN_SEC_RE = unitRe(String.raw`(\d+)\s*(?:s|seg)`);
const SPOKEN_ISIMO_RE = /(?<![\p{L}\p{N}_@])(\p{L}+?)isim([oa]s?)(?![\p{L}\p{N}_])/giu;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|‍|️|⃣/gu;

// ¿Quitar los emojis? TTS_QUITAR_EMOJIS=1 (desactivado por defecto): para cuando el lector los diga en alto
const stripEmojiEnabled = () => /^(1|true|si|sí|on)$/i.test(process.env.TTS_QUITAR_EMOJIS || '');

// Última capa antes de enviar: lo que se cuele con formato de pantalla pasa a palabras que el lector dice bien.
// «2h 49m» → «2 horas y 49 minutos», «30s» → «30 segundos», «#7» → «número 7», «nº» → «número», «+3» → «3 más»,
// « — », « · », « | » y «→» → coma, «buenisimas» → «buenísimas». No toca @nicks, !comandos ni emotes.
function speakable(text, { stripEmoji = stripEmojiEnabled() } = {}) {
  if (typeof text !== 'string') return text;
  let t = text
    .replace(SPOKEN_HM_RE, (_, h, m) => spokenDuration(Number(h) * 60 + Number(m)))
    .replace(SPOKEN_H_RE, (_, h) => plural(Number(h), 'hora', 'horas'))
    .replace(SPOKEN_MIN_RE, (_, m) => plural(Number(m), 'minuto', 'minutos'))
    .replace(SPOKEN_SEC_RE, (_, s) => plural(Number(s), 'segundo', 'segundos'))
    .replace(/(?<![\p{L}\p{N}_@])#(\d+)/gu, 'número $1')
    .replace(/(?<![\p{L}])n\.?[º°]\s*(?=\d)/giu, 'número ')
    .replace(/(?<![\p{L}])n\.?[º°](?![\p{L}])|№/giu, 'número')
    .replace(/(?<![\p{L}\p{N}_])\+(\d+)/gu, '$1 más')
    .replace(/\s*[—–·|→➜➡]+\s*/gu, ', ')
    .replace(SPOKEN_ISIMO_RE, (_, stem, end) => `${stem}ísim${end}`);
  if (stripEmoji) t = t.replace(EMOJI_RE, '');
  return t
    .replace(/^[\s,]+/, '')
    .replace(/\s+,/g, ',')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/,\s*([.!?…])/g, '$1')
    .replace(/([!?])\.(?!\.)/g, '$1') // «¡FUA!.» y «¿…?.»: el modelo los deja a veces antes de un emote
    .replace(/(?<![.\u2026])\.\.(?![.\u2026])/g, '.') // \u00ABsalto..\u00BB (no toca \u00AB...\u00BB ni \u00AB\u2026\u00BB)
    .replace(/(\p{Extended_Pictographic}\uFE0F?)\.(?!\.)/gu, '$1') // «como un roble! 😂.»
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Último «¡FUA!» de cierre: solo en una de cada tres menciones (recentFlags = si cerraron así las últimas)
const TRAILING_FUA_RE = /[\s,;]*¡?\bFUA\b!*[\s.]*$/i;

function limitTrailingFua(text, recentFlags = []) {
  const t = String(text || '');
  if (!TRAILING_FUA_RE.test(t) || t.replace(TRAILING_FUA_RE, '').trim().length < 8) return { text: t, had: false };
  if (!recentFlags.slice(-2).some(Boolean)) return { text: t, had: true };
  let out = t.replace(TRAILING_FUA_RE, '').trimEnd();
  // Si quitar el «FUA» deja la frase incompleta («Yo solo pongo el.»), se deja como está
  if (isCutOff(out)) return { text: t, had: true };
  if (!/[.!?…\p{Extended_Pictographic}]$/u.test(out)) out += '.';
  return { text: out, had: false };
}

// Nombres ya citados: si la frase empieza con ellos como vocativo ("Mujica90, ...") se quitan; en otro sitio no hay arreglo (null)
function stripLeadingNames(text, names) {
  let t = String(text || '');
  for (const login of names) {
    const re = new RegExp(`^([¡¿"\\s]*)@?${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,:]\\s*`, 'i');
    t = t.replace(re, '$1');
  }
  t = t.replace(/^([¡¿"\s]*)(\p{Ll})/u, (_, p, c) => p + c.toUpperCase());
  return t.trim() ? t.trim() : null;
}

// Los nombres de usuario los pone el código: cualquier @nombre del texto que no sea uno de `names` se corrige al más parecido
// (distancia ≤ 3) o se quita. names: logins/displays reales; el resultado usa su grafía exacta
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  return dp[a.length][b.length];
}

function fixMentions(text, names = []) {
  const known = names.map((n) => String(n || '').replace(/^@/, '')).filter(Boolean);
  return String(text || '')
    .replace(/@(\w+)/g, (all, tag) => {
      const exact = known.find((n) => n.toLowerCase() === tag.toLowerCase());
      if (exact) return `@${exact}`;
      const close = known
        .map((n) => [n, editDistance(n.toLowerCase(), tag.toLowerCase())])
        .sort((a, b) => a[1] - b[1])[0];
      return close && close[1] <= 3 ? `@${close[0]}` : '';
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

// Bienvenida: la IA escribe {usuario} donde quiere nombrar al recién llegado; el nombre lo inserta siempre el código
function insertUsername(text, username) {
  const clean = String(text || '')
    .replace(/@\w+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/\{usuario\}/i.test(clean)) return clean.replace(/\{usuario\}/gi, `@${username}`);
  return `@${username} ${clean}`;
}

// Resumen de reserva sin IA: datos reales (muertes, juego) y en positivo
function positiveSummaryFallback({ game, durationMinutes, deathCount } = {}) {
  const juego = game ? ` de ${game}` : '';
  const datos =
    deathCount > 0
      ? `${durationMinutes} minutos con ${deathCount} ${deathCount === 1 ? 'muerte' : 'muertes'}`
      : `${durationMinutes} minutos`;
  return `Gran stream${juego}: ${datos}, mucho FUA y muy buen ambiente en el chat.`;
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

// Respuesta cortada por max_tokens (finish_reason 'length'): se queda con las frases completas; sin ninguna, vacío (nunca se cierra un fragmento con un punto)
function dropTrailingFragment(text) {
  const t = String(text || '').trim();
  if (/[.!?…]$/.test(t)) return t;
  const end = lastSentenceEnd(t, t.length, 0.25);
  return end > 0 ? t.slice(0, end).trim() : '';
}

// Muletillas de trato ("tío", "tía", "colega", "bro", "chaval") usadas como apelativo: se quitan siempre, con su
// coma, sin descartar el mensaje. Como sustantivo ("ese tío", "mi colega", "menudo tío") se respetan.
const FILLER_RE = /(,\s*)?(?<![\p{L}\p{N}_@])(?:t[ií][oa]|colega|bro|chaval)(?![\p{L}\p{N}_])(\s*,)?/giu;

const NOUN_CONTEXT_RE =
  /(?:^|[\s¡¿])(?:el|la|un|una|ese|esa|este|esta|aquel|mi|tu|su|otro|otra|del|al|buen[oa]?|gran|menud[oa]|vaya|qu[eé]|pobre|ning[uú]n|cada|como|ni)\s+$/i;

function stripFillers(text, re = FILLER_RE) {
  return String(text)
    .replace(re, (m, before, after, off, full) => {
      if (before && after) return ',';
      if (before) return '';
      if (NOUN_CONTEXT_RE.test(full.slice(0, off))) return m;
      if (off === 0 || /[.!?¡¿]\s*$/.test(full.slice(0, off))) return '\0';
      return after ? ',' : ' ';
    })
    .replace(/\0\s*(\p{L})/gu, (_, c) => c.toUpperCase())
    .replace(/\0/g, '')
    .replace(/,\s*([.!?…])/g, '$1')
    .replace(/\s+([,.;:!?…])(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/¡\s+/g, '¡')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const limitFillers = (text) => (typeof text === 'string' ? stripFillers(text) : text);

// "Lusorums" (la comunidad): solo al chat en general, en 1 de cada 4 mensajes del bot (como el emote, por
// ventana de los últimos 3) y nunca en un mensaje dirigido a una persona (empieza por @usuario).
const LUSORUMS_RE = /(,\s*)?(?<![\p{L}\p{N}_@])lusorums?(?![\p{L}\p{N}_])(\s*,)?/giu;

const hasLusorums = (text) => {
  LUSORUMS_RE.lastIndex = 0;
  return LUSORUMS_RE.test(String(text || ''));
};

function limitLusorums(text, recentFlags = []) {
  if (typeof text !== 'string' || !hasLusorums(text)) return { text, had: false };
  if (!/^\s*@/.test(text) && !recentFlags.slice(-3).some(Boolean)) return { text, had: true };
  return { text: stripFillers(text, LUSORUMS_RE), had: false };
}

module.exports = {
  oneLine,
  speakable,
  spokenDuration,
  spokenSeconds,
  stripFillers,
  limitFillers,
  hasLusorums,
  limitLusorums,
  limitTrailingFua,
  stripLeadingNames,
  positiveSummaryFallback,
  fixMentions,
  insertUsername,
  lastSentenceEnd,
  cutAtSentence,
  dropTrailingFragment,
};
