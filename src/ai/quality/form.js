// Forma del mensaje: basura, restos del razonamiento, cortes, mayúsculas, ortografía y formato de informe.
const { norm, plainWords } = require('./text');
const { malformedNumber } = require('./numbers');

// --- Basura: mensajes que no están en español, son demasiado cortos o traen restos del razonamiento del modelo ---
const ENGLISH_WORDS = new Set(['the', 'and', 'is', 'are', 'was', 'were', 'of', 'to', 'you', 'your', 'with', 'this', 'that', 'something', 'like', 'let', 'okay', 'finding', 'here', 'should', 'would', 'could', 'need', 'maybe', 'wait', 'hmm', 'user', 'thinking', 'we', 'they', 'what', 'for', 'on', 'at', 'be', 'have', 'has', 'not', 'but', 'so', 'just', 'about', 'from', 'my', 'our', 'their', 'how', 'why', 'it', 'its', 'i', 'will', 'can', 'do', 'does', 'message', 'response', 'write', 'writing', 'draft']);

const SPANISH_WORDS = new Set(['el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'y', 'e', 'o', 'u', 'que', 'en', 'es', 'son', 'se', 'su', 'sus', 'con', 'por', 'para', 'sin', 'sobre', 'como', 'mas', 'pero', 'muy', 'ya', 'no', 'si', 'me', 'te', 'le', 'les', 'nos', 'mi', 'tu', 'a', 'hay', 'ha', 'han', 'era', 'fue', 'esta', 'este', 'esto', 'eso', 'ese', 'ahi', 'aqui', 'cuando', 'donde', 'quien', 'ni', 'tan', 'todo', 'todos', 'toda', 'nada', 'algo', 'ser', 'estar', 'va', 'vamos', 'vas', 'voy', 'hoy', 'cada', 'otro', 'otra', 'solo', 'ahora', 'siempre']);

const REASONING_LEAK_RE = /\b(?:let me|let's|the user|i need to|i should|i'll|i'm going|okay,|hmm+|wait,|first,? i|they want|we need|must (?:be|produce|write))\b|<\/?think>|\[(?:thinking|analysis)\]|^\s*(?:analysis|draft|output|borrador|reasoning)\s*:|\b(?:el usuario (?:quiere|pide|dice)|borrador del mensaje)\b/i;

const TRIVIAL_TOKEN_RE = /^\p{L}+\d+\w*$/u; // emotes y nicks con números ("parlus1X", "stewar32")

// Palabras "de verdad" del mensaje: sin emotes (parlus1…), @menciones ni enlaces
function wordsOf(text) {
  return String(text || '').replace(/https?:\/\/\S+/gi, ' ').replace(/@\w+/g, ' ').replace(/\bparlus1\w*/gi, ' ')
    .split(/[^\p{L}\p{N}']+/u).filter(w => w && !TRIVIAL_TOKEN_RE.test(w));
}

// Devuelve { rule: 'basura', reason } o null. minWords: palabras mínimas (3 por defecto)
function junkProblem(text, { minWords = 3 } = {}) {
  const raw = String(text || '');
  const words = wordsOf(raw);
  if (words.length < minWords) return { rule: 'basura', reason: 'demasiado corto; escribe una frase completa en español' };
  if (REASONING_LEAK_RE.test(raw)) return { rule: 'basura', reason: 'incluye restos de razonamiento o texto que no es el mensaje; escribe solo el mensaje final en español' };
  let en = 0;
  let es = 0;
  for (const w of words) {
    const k = norm(w);
    if (ENGLISH_WORDS.has(k)) en++;
    if (SPANISH_WORDS.has(k) || /[ñáéíóúü¡¿]/i.test(w)) es++;
  }
  if (/[ñáéíóúü¡¿]/i.test(raw)) es++;
  if (en >= 2 && en >= es) return { rule: 'basura', reason: 'no está en español; escribe solo en español de España' };
  if (es === 0 && words.length >= 3) return { rule: 'basura', reason: 'no parece un mensaje en español; escribe una frase completa en español de España' };
  const num = malformedNumber(raw);
  if (num) return { rule: 'numero', reason: `número mal escrito ("${num}"); escribe la cifra con dígitos o bien en palabras ("cuarenta y siete")` };
  return null;
}

// Final colgando ("el stream y.", "cuando la.")
const DANGLING_RE = /(?:^|\s)(?:y|e|o|u|a|de|del|la|el|los|las|un|una|que|con|por|para|en|se|su|sus|al|como|pero|cuando|mi|tu|ni|sin|sobre)$/i;

function isCutOff(text) {
  const t = String(text || '').replace(/\bparlus1\w+/gi, '').replace(/[\s.!?…¡¿"”»)]+$/, '').trim();
  return DANGLING_RE.test(t);
}

// "parrrrrrr": letras alargadas del chat que el bot copia (5 o más iguales seguidas)
const ELONGATED_RE = /(\p{L})\1{4,}/u;

function hasElongation(text) { return ELONGATED_RE.test(plainWords(text).replace(/\bFU+A+\b/gi, ' ')); }

// Quita del chat que se enseña al modelo las palabras con letras alargadas (para que no las copie)
function cleanChatNoise(text) {
  return String(text || '').replace(/\S*(\p{L})\1{3,}\S*/gu, ' ').replace(/ {2,}/g, ' ').trim();
}

// Mayúsculas: solo el FUA y los nombres propios; "MasterClass", "SOULS" o "el Jefe" no
const CAPS_OK = new Set(['FUA', 'IA', 'DLC', 'RPG', 'GG', 'ADE', 'GIF', 'OK', 'LOL', 'XP', 'NPC', 'HP', 'PS5', 'PS4', 'FPS', 'MMO', 'USA', 'EEUU', 'UE']);

const CAMEL_OK = new Set(['PogChamp', 'TwitchCon', 'YouTube', 'PlayStation', 'GitHub', 'LinkedIn', 'DualSense', 'SoulsLike', 'FromSoftware']);

const COMMON_NOUNS_CAP_RE = /\b(?:el|la|los|las|un|una|unos|unas|del|al|este|esta|ese|esa|estos|esas)\s+(?:Jefe|Jefes|Boss|Bosses|Suelo|Chat|Directo|Stream|Juego|Mando|Mapa|Dron|Canal|Streamer|Streamers|Muerte|Muertes|Ca[ií]da|Ca[ií]das|Combate|Enemigo|Enemigos|Pantalla|Partida)\b/u;

// Nombres propios que nunca son "mayúsculas raras": los del canal (config/channel.json), el lore y los nicks que se pasen
// (quien escribe y los que hablan en el chat). Se comparan sin @ y en minúscula.
const channelCfg = require('../../../config/channel.json');

const loreCfg = require('../../../config/lore.json');

function properNames(extra = []) {
  const set = new Set();
  const add = v => { const s = String(v || '').trim().toLowerCase().replace(/^@/, ''); if (s && !/\s/.test(s)) set.add(s); };
  [channelCfg.streamer, channelCfg.streamer_username, channelCfg.creator_username, process.env.BOT_USERNAME, 'dios_fua', 'P1X3LUS',
    ...(channelCfg.streamers || []), ...(channelCfg.moderators || []), ...(channelCfg.bot_whitelist || []), ...(channelCfg.proper_names || []),
    ...Object.keys(loreCfg.people || {}), ...Object.keys(loreCfg.nicknames || {}), ...Object.values(loreCfg.nicknames || {}),
    ...extra].forEach(add);
  return set;
}

function oddCaps(text, names = []) {
  const t = plainWords(text);
  const known = properNames(names);
  // Se mira palabra a palabra: "EvalUser12", "@EvalUser" o "ParLusorum" son nombres, no mayúsculas raras
  for (const word of t.match(/[\p{L}\p{N}_]+/gu) || []) {
    if (known.has(word.toLowerCase())) continue;
    const m = /(?<!\p{L})\p{Lu}\p{Ll}+(?:\p{Lu}\p{Ll}+)+(?!\p{L})/u.exec(word);
    if (m && !CAMEL_OK.has(m[0])) return m[0];
  }
  const hit = COMMON_NOUNS_CAP_RE.exec(t);
  if (hit) return hit[0];
  for (const sentence of t.split(/(?<=[.!?…])\s+/)) {
    const caps = [...sentence.matchAll(/\b\p{Lu}{3,}\b/gu)].map(m => m[0]).filter(w => !CAPS_OK.has(w) && !/^FU+A+$/.test(w) && !known.has(w.toLowerCase()));
    const allCaps = [...sentence.matchAll(/\b\p{Lu}{2,}\b/gu)].length;
    if (caps.length && allCaps < 2) return caps[0]; // una frase entera en mayúsculas es un grito, no un error
  }
  return '';
}

// Errores de ortografía y género de palabras que la IA repite: "ignoreís", "menudo masterclass"
const EIS_OK = /^(?:re|fre|sonre|engre|desfre)[ií]s$/iu; // reír y freír sí llevan «-eís»

function spellingProblem(text) {
  const t = plainWords(text);
  for (const m of t.matchAll(/(?<!\p{L})\p{L}{3,}e[ií]s(?!\p{L})/giu)) {
    if (/eís$/i.test(m[0]) && !EIS_OK.test(m[0])) return `«${m[0]}» lleva la tilde en la «e» (-éis)`;
  }
  if (/\b(?:el|un|menudo|vaya|buen|este|ese|del|qu[eé])\s+master\s?class\b/i.test(t)) return '«masterclass» es femenino («una masterclass»)';
  return '';
}

// Formato de informe: "En los últimos 30′ …", "(5 del día)", minutos con prima
const REPORT_FORMAT_RE = /\ben los [uú]ltimos \d+\s*(?:['′’]|min)|\(\s*\d+\s+(?:del d[ií]a|de hoy|hoy)\s*\)|\(\s*\d+\s*\)|\b\d+\s*['′’](?!\p{L})/iu;

function reportFormat(text) { return REPORT_FORMAT_RE.test(String(text || '')); }

// Listas de palabras sueltas del chat o nicks pegados: "el chat suelta harocho3847, tienes, parlusorum, poco y dron"
const WORD_LIST_RE = /\b(?:suelta|sueltan|tira|tiran|repite|repiten|escribe|escriben|dice|dicen|spamea\w*|grita|gritan)\s+["“«]?\p{L}[\p{L}\d]*(?:,\s+\p{L}[\p{L}\d]*){2,}/iu;

function wordListProblem(text) {
  const t = plainWords(String(text || ''));
  if (WORD_LIST_RE.test(t)) return 'lista de palabras sueltas del chat';
  return '';
}

module.exports = { junkProblem, isCutOff, hasElongation, oddCaps, spellingProblem, reportFormat, WORD_LIST_RE, wordListProblem, cleanChatNoise };
