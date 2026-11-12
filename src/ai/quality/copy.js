// Regla `copia`: palabras del chat reciente que acaban en un mensaje del bot sin venir de los hechos, del juego ni del canal.
// El cohost y el resumen de media hora ya no reciben líneas del chat; esta regla es la red de seguridad de salida.
const fs = require('fs');
const path = require('path');
const { norm, plainWords } = require('./text');

// Palabras frecuentes del español por orden de frecuencia (fuente y licencia: data/README.md)
const FREQ_FILE = path.join(__dirname, 'data', 'es-frecuentes.txt');
const IGNORE_TOP = 300; // las más frecuentes («para», «bien», «casa»…) no cuentan como palabras del chat

let ranks = null;
function loadRanks() {
  if (ranks) return ranks;
  ranks = new Map();
  let words = [];
  try {
    words = fs
      .readFileSync(FREQ_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    /* sin lista: toda palabra cuenta como poco común */
  }
  words.forEach((w, i) => {
    const k = norm(w);
    if (!ranks.has(k)) ranks.set(k, i);
  });
  return ranks;
}

// Posición de la palabra en la lista (0 = la más frecuente); Infinity si no está: palabra poco común
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
const stem = (w) => (w.length > 4 ? w.replace(/s$/, '').replace(/([aei]r)(?:l[aeo]|me|te|se|no)$/, '$1') : w);

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
  const rare = hits.find((w) => wordRank(w) === Infinity && wordRank(stem(w)) === Infinity);
  if (rare) return rare;
  if (hits.length >= 2) return hits.slice(0, 3).join(', ');
  // Cifras de dos o más dígitos («110»): las de una sola salen por casualidad
  const number = numbersIn(text).find((n) => n.length >= 2 && chatNumbers.has(n) && !okNumbers.has(n));
  return number || '';
}

module.exports = { copiedFromChat, wordRank };
