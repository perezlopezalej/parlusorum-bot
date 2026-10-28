// Detección pura de menciones directas y preguntas naturales dirigidas al bot (sin estado ni I/O)

const TARGET = 'diosfua';
const MAX_NATURAL_LENGTH = 90;

// Cooldowns: la mención directa responde casi siempre; la natural es más espaciada
const COOLDOWNS = {
  direct: { globalMs: 8 * 1000, userMs: 10 * 1000 },
  natural: { globalMs: 45 * 1000, userMs: 30 * 1000 },
};

// Minúsculas y sin tildes
const normalize = s => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
// Letras repetidas 3+ veces ("fuaaaa") se reducen a una
const squash = s => s.replace(/(.)\1{2,}/g, '$1');
const lettersOnly = s => normalize(s).replace(/[^a-z]/g, '');

// Distancia de edición con transposición (Damerau/OSA)
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const targetsFor = botNames => [...new Set([TARGET, ...botNames.map(lettersOnly).filter(n => n.length >= 5)])];

// "dios fua", "diosfua", "dios_fua", "@dios_fua", mayúsculas, signos repetidos y una letra de más o de menos.
// Ante la duda se prefiere responder: un falso positivo cuesta menos que ignorar a quien habla con el bot.
function isDirectMention(message, botNames = []) {
  const words = normalize(message).split(/[^a-z]+/).filter(Boolean).map(squash);
  const targets = targetsFor(botNames);
  const near = candidate => candidate.length >= 5 && targets.some(t => editDistance(candidate, t) <= 1);
  return words.some((w, i) => near(w) || (i + 1 < words.length && near(w + words[i + 1])));
}

// Preguntas naturales: ancladas al inicio de la frase. needsQuestion = exige "?" para disparar.
const NATURAL_PATTERNS = [
  // Juego actual
  { re: /^(?:y )?(?:a )?que juego (?:es|juegas|juegan|jugais|jugamos|estas jugando|estais jugando|estan jugando)\b/, needsQuestion: false },
  { re: /^(?:y )?a que (?:juegas|juegan|jugais|estas jugando|estais jugando|estan jugando)\b/, needsQuestion: false },
  { re: /^(?:y )?que (?:estas|estais|estan) jugando\b/, needsQuestion: false },
  { re: /^como se llama (?:el|este) juego\b/, needsQuestion: false },
  { re: /^de que va (?:el juego|este juego|esto)\b/, needsQuestion: false },
  // Duración del stream
  { re: /^cuanto (?:tiempo )?(?:llevas|llevais)(?: (?:ya|hoy|aqui|jugando|de stream|de directo|en (?:el )?(?:stream|directo)))*$/, needsQuestion: false },
  { re: /^cuanto (?:tiempo )?lleva (?:el|este) (?:stream|directo)$/, needsQuestion: false },
  // Identidad del bot
  { re: /^(?:tu )?eres (?:un )?(?:bot|ia|inteligencia artificial|robot|real|humano|persona)$/, needsQuestion: true },
  { re: /^como te llamas$/, needsQuestion: true },
  { re: /^quien eres$/, needsQuestion: true },
  // Dificultad
  { re: /^(?:es|esta) (?:muy )?(?:dificil|complicado|facil)(?: (?:el|este) (?:juego|boss|jefe|nivel))?$/, needsQuestion: true },
  { re: /^que tan (?:dificil|facil) (?:es|esta)(?: (?:el|este) (?:juego|boss|jefe|nivel))?$/, needsQuestion: true },
];

function isNaturalQuestion(message, tags = {}, botNames = []) {
  if (!message || message.length > MAX_NATURAL_LENGTH) return false;
  const botKeys = targetsFor(botNames);
  const isBot = name => botKeys.includes(lettersOnly(name));

  // Respuesta a otro usuario o @ a otra persona: no va dirigido al bot
  const replyTo = tags['reply-parent-user-login'];
  if (replyTo && !isBot(replyTo)) return false;
  const mentions = message.match(/@\w+/g) || [];
  if (mentions.some(m => !isBot(m))) return false;

  const hasQuestionMark = /[?¿]/.test(message);
  const text = normalize(message)
    .replace(/@\w+/g, ' ')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .replace(/\s+/g, ' ');
  return NATURAL_PATTERNS.some(p => p.re.test(text) && (!p.needsQuestion || hasQuestionMark));
}

// Insultos y provocaciones típicas del chat (sobre texto normalizado)
const PROVOCATION_RE = /\b(subnormal|mierda|cagar|caga|chup(?:a|ame|amela|ar)\b|mamon|mamona|puto|puta|cabron|gilipollas|imbecil|idiota|panchito|maric[ao]n?|repelente|pesao|pesado|tus muertos|tu madre|callate|callas|cierra la boca|te faltan huevos|te (?:mato|mate|reviento|destruyo|voy a (?:matar|dejar|reventar))|vete a|que te follen)\b/;

function isProvocation(message) {
  return PROVOCATION_RE.test(normalize(message));
}

// Palabras que delatan que se habla CON el bot
const SECOND_PERSON = new Set(['te', 'tu', 'tus', 'eres', 'tienes', 'puedes', 'sabes', 'estas', 'quieres', 'haces', 'dices', 'contigo', 'dime', 'dinos', 'cuentanos', 'cuentame']);
// Delante del nombre: se habla DE él ("el dios fua", "con ese dios fua")
const THIRD_PREV = new Set(['el', 'ese', 'este', 'del', 'al', 'de', 'su', 'nuestro', 'mi', 'otro']);
// Detrás del nombre: verbo en tercera persona ("dios fua va a lo suyo")
const THIRD_NEXT = new Set(['va', 'es', 'esta', 'sigue', 'ha', 'funciona', 'tiene', 'hace', 'dice', 'sabe', 'quiere', 'parece', 'dijo', 'estaba', 'era', 'ya', 'siempre']);

// Posición [start, end) de la mención en la lista de palabras, o null
function mentionSpan(words, botNames) {
  const targets = targetsFor(botNames);
  const near = c => c.length >= 5 && targets.some(t => editDistance(c, t) <= 1);
  for (let i = 0; i < words.length; i++) {
    if (near(words[i])) return [i, i + 1];
    if (i + 1 < words.length && near(words[i] + words[i + 1])) return [i, i + 2];
  }
  return null;
}

// true si el mensaje habla CON el bot; false si habla DE él en tercera persona
function isAddressedToBot(message, tags = {}, botNames = []) {
  const text = normalize(message);
  if (text.split(/\s+/).some(w => w.startsWith('@') && isDirectMention(w, botNames))) return true;
  const words = text.split(/[^a-z]+/).filter(Boolean).map(squash);
  const span = mentionSpan(words, botNames);
  if (!span) return true;
  if (words.some(w => SECOND_PERSON.has(w))) return true;
  const prev = words[span[0] - 1];
  const next = words[span[1]];
  if (prev && THIRD_PREV.has(prev)) return false;
  if (next && THIRD_NEXT.has(next)) return false;
  return true;
}

// 'provocation' | 'direct' | 'natural' | null. Hablar DE el bot sin dirigirse a él no dispara nada.
function classifyMessage(message, tags = {}, { botNames = [] } = {}) {
  if (isDirectMention(message, botNames)) {
    if (isProvocation(message)) return 'provocation';
    return isAddressedToBot(message, tags, botNames) ? 'direct' : null;
  }
  if (isNaturalQuestion(message, tags, botNames)) return 'natural';
  return null;
}

// Provocaciones: solo la primera de cada usuario por ventana recibe réplica. until = fin de su ventana (0 si no tiene)
function provocationGate(now, until = 0) {
  return now >= until;
}

// multiplier (config del modo) solo afecta a las naturales
function cooldownMs(kind, multiplier = 1) {
  const base = COOLDOWNS[kind];
  const m = kind === 'natural' ? multiplier : 1;
  return { globalMs: base.globalMs * m, userMs: base.userMs * m };
}

// true si se puede responder ahora
function cooldownGate(kind, { now, lastGlobalAt = 0, userUntil = 0, multiplier = 1 }) {
  const { globalMs } = cooldownMs(kind, multiplier);
  return now - lastGlobalAt >= globalMs && now >= userUntil;
}

module.exports = { COOLDOWNS, editDistance, isDirectMention, isNaturalQuestion, isProvocation, isAddressedToBot, classifyMessage, provocationGate, cooldownMs, cooldownGate };
