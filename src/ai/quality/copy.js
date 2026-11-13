// Reglas `copia` e `inventado`: palabras del chat reciente que acaban en un mensaje del bot sin venir de los hechos, y detalles
// (nombres, palabras raras) que no salen de los hechos, del juego ni del canal.
// El cohost y el resumen de media hora ya no reciben líneas del chat; estas reglas son la red de seguridad de salida.
const fs = require('fs');
const path = require('path');
const { norm, plainWords } = require('./text');

// Palabras frecuentes del español por orden de frecuencia (fuente y licencia: data/README.md)
const FREQ_FILE = path.join(__dirname, 'data', 'es-frecuentes.txt');
// Vocabulario propio del directo, editable: nunca es un detalle inventado
const DIRECTO_FILE = path.join(__dirname, 'data', 'vocabulario-directo.txt');
const IGNORE_TOP = 300; // las más frecuentes («para», «bien», «casa»…) no cuentan como palabras del chat
const COMMON_RANK = 5000; // regla `copia`: de aquí en adelante (o ausente) una palabra del chat es poco común
const INVENTED_RANK = 30000; // regla `inventado`: de aquí en adelante (o ausente) una palabra es poco común

const readList = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return []; // sin fichero: sin lista
  }
};

let ranks = null;
function loadRanks() {
  if (ranks) return ranks;
  ranks = new Map();
  readList(FREQ_FILE).forEach((w, i) => {
    const k = norm(w);
    if (!ranks.has(k)) ranks.set(k, i);
  });
  return ranks;
}

let directoWords = null;
const loadDirectoWords = () => (directoWords = directoWords || readList(DIRECTO_FILE));

// Posición de la palabra en la lista (0 = la más frecuente); Infinity si no está
function wordRank(word) {
  const r = loadRanks().get(norm(word));
  return r === undefined ? Infinity : r;
}

// Vocabulario del canal y de cualquier directo: que el chat lo use no lo convierte en copia
const CHANNEL_WORDS = [
  'fua',
  'dios',
  'lusorum',
  'lusorums',
  'parlusorum',
  'manu',
  'pao',
  'chat',
  'directo',
  'stream',
  'streamer',
  'canal',
  'jefe',
  'boss',
  'caida',
  'muerte',
  'partida',
  'juego',
  'jugar',
  'jugando',
  'mando',
  'intento',
  'victoria',
  'raid',
  'subs',
  'vlxj97',
];

// Raíz para comparar: sin la -s del plural y sin el pronombre pegado al infinitivo («chuparla» y «separarlo» → «chupar», «separar»)
const stem = (w) =>
  w.length > 4 ? w.replace(/s$/, '').replace(/([aei]r)(?:(?:se|me|te|nos)?l[aeo]s?|me|te|se|nos?)$/, '$1') : w;

// Formas de una palabra para buscarla en las listas: tal cual, sin -s y sin -es («tropiezos», «caídas», «jefes»)
const singulars = (k) => [...new Set([k, stem(k), k.replace(/es$/, '')])].filter((w) => w.length >= 3);

// Palabras de contenido de un texto: [{ word, stem }], de 4+ letras y fuera de las más frecuentes
function contentWords(text) {
  const out = [];
  for (const w of norm(plainWords(text)).split(/[^a-z0-9]+/)) {
    if (w.length < 4 || /^\d+$/.test(w) || wordRank(w) < IGNORE_TOP) continue;
    out.push({ word: w, stem: stem(w) });
  }
  return out;
}

const numbersIn = (text) => norm(plainWords(text)).match(/\d+/g) || [];
const lineText = (l) => (typeof l === 'string' ? l : l?.message || '');

// ¿El texto repite palabras del chat reciente? Devuelve la palabra o la cifra copiada ('' si no hay copia).
// Cuenta como copia: una palabra poco común del chat, dos corrientes, o una cifra que solo está en el chat.
// opts.allowed: textos o palabras legítimos (hechos del momento, nombre y ficha del juego); opts.gameWords: vocabulario del
// juego (vale también el parecido por las 5 primeras letras: «colosos» con «Colossus»); opts.numbers: cifras legítimas.
function copiedFromChat(text, chatLines = [], { allowed = [], gameWords = [], numbers = [] } = {}) {
  if (!chatLines || !chatLines.length) return '';
  const chatStems = new Set();
  const chatNumbers = new Set();
  for (const line of chatLines) {
    for (const { stem: s } of contentWords(lineText(line))) chatStems.add(s);
    for (const n of numbersIn(lineText(line))) chatNumbers.add(n);
  }
  const allowedStems = new Set(CHANNEL_WORDS.map(stem));
  const okNumbers = new Set(numbers.map(String));
  for (const a of [...allowed, ...gameWords]) {
    for (const { stem: s } of contentWords(a)) allowedStems.add(s);
    for (const n of numbersIn(a)) okNumbers.add(n);
  }
  const prefixes = new Set(
    gameWords
      .map((g) => norm(g))
      .filter((g) => g.length >= 5)
      .map((g) => g.slice(0, 5)),
  );
  const hits = [];
  const seen = new Set();
  for (const { word, stem: s } of contentWords(text)) {
    if (seen.has(s) || !chatStems.has(s) || allowedStems.has(s)) continue;
    if (word.length >= 5 && prefixes.has(word.slice(0, 5))) continue;
    seen.add(s);
    hits.push(word);
  }
  const rare = hits.find((w) => wordRank(w) >= COMMON_RANK && wordRank(stem(w)) >= COMMON_RANK);
  if (rare) return rare;
  if (hits.length >= 2) return hits.slice(0, 3).join(', ');
  // Cifras de dos o más dígitos («110»): las de una sola salen por casualidad
  const number = numbersIn(text).find((n) => n.length >= 2 && chatNumbers.has(n) && !okNumbers.has(n));
  return number || '';
}

// ¿Alguna palabra de la lista empieza por `prefix`? (búsqueda binaria en la lista ordenada)
let sortedWords = null;
function hasListPrefix(prefix) {
  if (!sortedWords) sortedWords = [...loadRanks().keys()].sort();
  let lo = 0;
  let hi = sortedWords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedWords[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedWords.length && sortedWords[lo].startsWith(prefix);
}

// Distancia de edición (Levenshtein) entre dos palabras cortas
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Detalle inventado: un nombre propio (palabra con mayúscula que no abre frase) o una palabra poco común (de la posición
// INVENTED_RANK en adelante o ausente de la lista de frecuencia, también en singular) que no sale de los hechos, de la ficha
// del juego, del vocabulario del directo (data/vocabulario-directo.txt) ni del canal («las Colosales», «esa costra para saltar»).
// Devuelve la palabra o '' si no hay.
// opts.allowed: textos legítimos (hechos, ficha, nombre del juego, el prompt); opts.gameWords: vocabulario del juego (una variante
// cercana, hasta 2-3 letras de diferencia, también vale: «colosos» con «Colossus»); opts.names: nicks del chat.
function inventedDetail(text, { allowed = [], gameWords = [], names = [] } = {}) {
  const ok = new Set([...CHANNEL_WORDS, ...loadDirectoWords()].flatMap((w) => singulars(norm(w))));
  for (const a of [...allowed, ...gameWords, ...names]) {
    for (const w of norm(plainWords(a)).split(/[^a-z0-9ñ]+/)) if (w) ok.add(stem(w));
  }
  const near = [...new Set([...allowed, ...gameWords].flatMap((a) => norm(plainWords(a)).split(/[^a-z0-9ñ]+/)))].filter(
    (w) => w.length >= 5,
  );
  const t = plainWords(text);
  const re = /\p{L}[\p{L}'’]*/gu;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const word = m[0];
    const k = norm(word);
    const next = t[m.index + word.length] || '';
    if (k.length < 4 || /\d/.test(next) || /^\p{Lu}{2,}$/u.test(word)) continue; // «FUA», «gangar79»
    if (singulars(k).some((w) => ok.has(w))) continue;
    const before = t.slice(0, m.index).replace(/\s+$/, '');
    const startsSentence = !before || /[.!?¡¿…:;"“«(\-—]$/.test(before);
    const proper = /^\p{Lu}\p{Ll}/u.test(word) && !startsSentence;
    const rank = Math.min(...singulars(k).map(wordRank));
    // formas conjugadas o derivadas («animan», «peleando») cuentan como comunes si empiezan igual que una palabra de la lista
    const uncommon = k.length >= 5 && rank >= INVENTED_RANK && !hasListPrefix(k.slice(0, Math.max(5, k.length - 2)));
    if (!proper && !uncommon) continue;
    // un nombre propio solo vale exacto; una palabra poco común, también si es variante cercana de una permitida
    if (
      !proper &&
      near.some(
        (w) => Math.abs(w.length - k.length) <= 3 && editDistance(w, k) <= (w.length >= 6 && k.length >= 6 ? 3 : 2),
      )
    )
      continue;
    return word;
  }
  return '';
}

module.exports = { copiedFromChat, inventedDetail, wordRank };
