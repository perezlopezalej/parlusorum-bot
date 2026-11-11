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

// Marcas de este texto para `markStructure`: estructura, día de la semana, "Entre…" y palabras largas
function streamMarks(text, game = '') {
  const marks = [];
  const s = structureKey(text);
  if (s) marks.push(s);
  if (WEEKDAY_RE.test(text)) marks.push('dia-semana');
  if (ENTRE_RE.test(text)) marks.push('entre-x-y');
  for (const w of notableWords(text, game)) marks.push(`w:${w}`);
  return marks;
}

// Motivo si el texto repite algo que ya salió en el stream (used = Set de marcas)
function repeatedInStream(text, used = new Set(), game = '') {
  if (!used || !used.size) return '';
  if (used.has('dia-semana') && WEEKDAY_RE.test(text))
    return 'repite el día de la semana, que ya se dijo en este stream; habla del momento sin nombrarlo';
  if (used.has('entre-x-y') && ENTRE_RE.test(text))
    return 'repite la estructura «Entre X y Y…» de este stream; empieza de otra forma';
  for (const w of notableWords(text, game))
    if (used.has(`w:${w}`)) return `repite la palabra «${w}», que ya se usó en este stream; usa otra`;
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
};
