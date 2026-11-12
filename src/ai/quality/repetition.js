// Repetición: parecido con mensajes recientes, aperturas, nombres y estructuras ya usadas en el stream.
const { norm, plainWords } = require('./text');
const { NUM_TOKEN_RE } = require('./numbers');
const { FORMULAS } = require('./lexicon');

// Arranque de la frase con los números abstraídos ("Cuatro horas y media…" y "Seis horas y once…" → "n horas"): evita repetir estructura
function openingKey(text) {
  const t = norm(text)
    .replace(/\bparlus1\w*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ');
  const abstracted = t
    .replace(new RegExp(`\\b(?:\\d+|${NUM_TOKEN_RE}(?:\\s+(?:y\\s+)?${NUM_TOKEN_RE})*)\\b`, 'g'), 'n')
    .replace(/\s+/g, ' ')
    .trim();
  return abstracted.split(' ').slice(0, 2).join(' ');
}

function sameOpening(text, recent = []) {
  const key = openingKey(text);
  return key.split(' ').length >= 2 && recent.some((r) => openingKey(r) === key);
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
  return [...new Set(candidates.map(norm).filter(Boolean))].filter((login) => {
    const re = new RegExp(`(?:^|[^a-z0-9_])@?${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`);
    return re.test(t);
  });
}

// --- Repetición: palabras de contenido compartidas con mensajes recientes ---
const contentWords = (s) =>
  new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5),
  );

function similarity(a, b) {
  const A = contentWords(a),
    B = contentWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

function tooSimilar(text, recent, threshold = 0.6) {
  return recent.some((r) => similarity(text, r) >= threshold);
}

function repeatsFormula(text, recent) {
  return FORMULAS.some((re) => re.test(text) && recent.some((r) => re.test(r)));
}

// Marcas por stream: lo que solo puede salir una vez (día de la semana, "Entre X y Y…") o no repetirse (palabras llamativas)
const WEEKDAY_RE = /\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i;

const ENTRE_RE = /^[¡¿"“\s]*entre\b[^.!?]{2,70}?\by\b/i;

const NOTABLE_SKIP = new Set([
  'parlusorum',
  'lusorums',
  'streamer',
  'streamers',
  'directo',
  'siguiente',
  'caidas',
  'muertes',
  'jugando',
  'personas',
  'compañero',
]);

function notableWords(text, game = '') {
  const gameWords = new Set(
    norm(game)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const out = new Set();
  for (const w of plainWords(text).split(/[^\p{L}]+/u)) {
    const k = norm(w);
    if (k.length >= 9 && !NOTABLE_SKIP.has(k) && !gameWords.has(k)) out.add(k);
  }
  return out;
}

// Metáforas y comparaciones con marca reconocible: una por stream entre cohost, hook y resumen de media hora.
// «si el FUA fuera una ley…», «como si fueran confeti», «ni que fuera…», «más intenso que una banca», «el FUA es la gravedad del chat».
const METAPHOR_RES = [
  /(?<!\p{L})si\s[^.!?,;]{1,40}?\s(?:fuera|fuese|fueran|fuesen)(?!\p{L})/iu,
  /(?<!\p{L})como si(?!\p{L})/iu,
  /(?<!\p{L})ni que (?:fuera|fuese|fueran|fuesen|tuviera|tuviese|estuviera|estuviese)(?!\p{L})/iu,
  /(?<!\p{L})m[aá]s\s+\p{L}+(?:\s+\p{L}+)?\s+que\s+(?:un|una|unos|unas|el|la|los|las|mi|tu|su)\s+\p{L}+/iu,
  /(?<!\p{L})(?:es|son|sois|eres|soy)\s+(?:el|la|los|las)\s+\p{L}+\s+(?:del|de la|de los|de las|de este|de esta)\s/iu,
  /(?<!\p{L})parece(?:n|is)?\s+(?:un|una|unos|unas)\s+\p{L}+/iu,
];

function isMetaphor(text) {
  const t = String(text || '');
  return METAPHOR_RES.some((re) => re.test(t));
}

const METAPHOR_MARK = 'metafora';

const METAPHOR_REASON =
  'usa otra metáfora o comparación y ya salió una en este stream; di la idea directa, tal cual pasa';

// Marcas de este texto para `markStructure`: estructura, día de la semana, "Entre…", metáfora y palabras largas
function streamMarks(text, game = '') {
  const marks = [];
  const s = structureKey(text);
  if (s) marks.push(s);
  if (WEEKDAY_RE.test(text)) marks.push('dia-semana');
  if (ENTRE_RE.test(text)) marks.push('entre-x-y');
  if (isMetaphor(text)) marks.push(METAPHOR_MARK);
  for (const w of notableWords(text, game)) marks.push(`w:${w}`);
  const closing = closingMark(text);
  if (closing) marks.push(closing);
  return marks;
}

// Motivo si el texto repite algo que ya salió en el stream (used = Set de marcas)
function repeatedInStream(text, used = new Set(), game = '') {
  if (!used || !used.size) return '';
  const closing = repeatedClosing(text, used);
  if (closing) return closing;
  if (used.has('dia-semana') && WEEKDAY_RE.test(text))
    return 'repite el día de la semana, que ya se dijo en este stream; habla del momento sin nombrarlo';
  if (used.has('entre-x-y') && ENTRE_RE.test(text))
    return 'repite la estructura «Entre X y Y…» de este stream; empieza de otra forma';
  if (used.has(METAPHOR_MARK) && isMetaphor(text)) return METAPHOR_REASON;
  for (const w of notableWords(text, game))
    if (used.has(`w:${w}`)) return `repite la palabra «${w}», que ya se usó en este stream; usa otra`;
  return '';
}

// --- Coletillas: la última frase exclamativa de un mensaje con varias frases («¡A seguir con la partida!») ---
// Cola del mensaje: emotes del canal (parlus1…) y emojis finales
const TAIL_RE = /(?:\s*(?:parlus1\w+|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*))+\s*$/u;

function closingSentence(text) {
  const body = String(text || '')
    .replace(TAIL_RE, '')
    .trim();
  const m = /[.!?…]\s+¡?([^.!?…]*)!+$/u.exec(body); // exige una frase anterior: un mensaje de una sola frase no tiene coletilla
  if (!m) return '';
  const sentence = m[1].trim();
  const words = sentence.split(/\s+/).filter(Boolean);
  return words.length >= 3 && words.length <= 14 && contentWords(sentence).size >= 2 ? sentence : '';
}

const sameClosing = (a, b) => !!a && !!b && similarity(a, b) >= 0.5;

// ¿Termina el texto con una coletilla ya usada en `recent` (mensajes anteriores)?
function repeatsClosing(text, recent = []) {
  const mine = closingSentence(text);
  return !!mine && recent.some((r) => sameClosing(mine, closingSentence(r)));
}

// Marca por stream de la coletilla del texto ('' si no tiene)
function closingMark(text) {
  const s = closingSentence(text);
  return s ? `c:${norm(s)}` : '';
}

// Motivo si la coletilla del texto ya salió en este stream (used = Set de marcas)
function repeatedClosing(text, used = new Set()) {
  const mine = closingSentence(text);
  if (!mine || !used) return '';
  for (const key of used)
    if (typeof key === 'string' && key.startsWith('c:') && sameClosing(mine, key.slice(2)))
      return `repite la coletilla final «${mine}», que ya salió en este stream; cierra con otra idea o sin frase final`;
  return '';
}

// Años (2026...) que ya salieron en comentarios anteriores
function repeatsYear(text, recent) {
  const years = String(text).match(/\b20\d\d\b/g) || [];
  return years.some((y) => recent.some((r) => String(r).includes(y)));
}

// Estructuras de frase que el cohost/timer no debe repetir en el mismo stream ("Manu lleva 13 caídas y el FUA…")
const STRUCTURES = [
  ['lleva-caidas', /\blleva\s+\d+\s+(?:ca[ií]das?|muertes?)\b/i],
  ['contador-y-fua', /\b\d+\s+(?:ca[ií]das?|muertes?)\s+y\s+el\s+fua\b/i],
];

function structureKey(text) {
  const t = String(text || '');
  const hit = STRUCTURES.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

module.exports = {
  recentlyNamedIn,
  tooSimilar,
  repeatsFormula,
  repeatedInStream,
  structureKey,
  sameOpening,
  repeatsYear,
  notableWords,
  streamMarks,
  namesIn,
  similarity,
  openingKey,
  closingMark,
  repeatsClosing,
  repeatedClosing,
  isMetaphor,
  METAPHOR_MARK,
  METAPHOR_REASON,
};
