// Hechos del momento para el cohost y el timer: frases neutras escritas por el código a partir del estado del stream.
// Así el modelo no recibe líneas literales del chat (jerga, nicks, chistes internos) y no puede copiarlas.
// Módulo puro: sin estado ni I/O. Lo usan el cohost (lista <hechos>) y el resumen de media hora (tema del chat).
const { approxDuration, mentionsEthnicTerms, personalMatch } = require('./quality');

const MAX_FACTS = 5;
const MIN_USERS = 2; // una categoría del chat necesita al menos 2 usuarios distintos
const RECENT_MS = 10 * 60 * 1000;
const MIN_MINUTES = 20; // antes de eso el rato de directo no es tema

const strip = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const NUMBER_WORDS = [
  'cero',
  'una',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
];
const num = (n) => NUMBER_WORDS[n] || String(n);
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

// --- Categorías del chat (reglas; una línea cuenta para la primera que case) ---
const LAUGH_RE = /^(?:\W|\d)*(?:(?:j+[aeiou]+j*|ha+h[ah]*|he+h[eh]*|k+e+k+w*|lo+l+|xd+|lmao|rofl)\W*)+$/i;
const ADVICE_RE =
  /(?<!\p{L})(?:tienes que|tiene que|hay que|tenias que|tendrias que|deberias|tira|usa|mira|ve a|ve hacia|dale|sube|baja|cuidado|no vayas|no (?:le )?des|ataca|esquiva|corre|salta|agarrate|apunta|prueba|intenta|intentalo|por la (?:izquierda|derecha)|a la (?:izquierda|derecha)|hacia (?:arriba|abajo))(?!\p{L})/iu;
const CHEER_RE =
  /(?<!\p{L})(?:animo|vamos|tu puedes|puedes con|fuerza|crack|maquina|campeon|bien hecho|que bueno|genial|grande|lo conseguiste|lo lograste|eso es|asi se hace)(?!\p{L})/iu;
const GAME_TALK_RE =
  /(?<!\p{L})(?:el juego|el boss|el jefe|los jefes|el mapa|el nivel|la historia|los graficos|la banda sonora|la musica|el combate|el caballo|el escenario|la pelea|el combo)(?!\p{L})/iu;

// → 'risas' | 'consejos' | 'animos' | 'preguntas' | 'juego' | null (charla ajena al directo)
function classifyLine(text, gameWords = []) {
  const t = strip(text)
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.startsWith('!')) return null;
  if (mentionsEthnicTerms(text) || personalMatch(text)) return null;
  if (LAUGH_RE.test(t)) return 'risas';
  if (ADVICE_RE.test(t)) return 'consejos';
  if (CHEER_RE.test(t)) return 'animos';
  if (GAME_TALK_RE.test(t) || gameWords.some((w) => new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'u').test(t)))
    return 'juego';
  if (/\?/.test(t) && t.length >= 12) return 'preguntas';
  return null;
}

const STOP = new Set(
  'para pero como esto esta este esos esas solo muy mas que los las del con una uno por sin sus han hay fue son ser the and of de la el en y a o'.split(
    ' ',
  ),
);

// Palabras del juego: las del nombre y las de la ficha, en minúsculas y sin acentos, de 4+ letras y sin palabras vacías
function gameVocabulary(...texts) {
  const out = new Set();
  for (const text of texts) {
    for (const w of strip(text).split(/[^a-z0-9ñ]+/)) {
      if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
    }
  }
  return [...out];
}

// Nombres propios de un texto (la ficha de IGDB viene en inglés: solo sirven sus nombres de personajes y lugares):
// palabras con mayúscula inicial que no abren frase, en minúsculas y sin acentos
function properNouns(text) {
  const out = new Set();
  for (const sentence of String(text || '').split(/[.!?:;]\s+/)) {
    const words = sentence.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    words.slice(1).forEach((w) => {
      const k = strip(w);
      if (/^\p{Lu}\p{Ll}/u.test(w) && k.length >= 4 && !STOP.has(k)) out.add(k);
    });
  }
  return [...out];
}

// Tema del chat en una frase neutra, o null si no hay un tema claro (charla ajena, pocos usuarios).
// Solo se nombra una palabra del vocabulario del juego, y solo si 2+ usuarios la usan.
// opts.minUsers: usuarios distintos que debe tener la categoría (2; el resumen de media hora pide más)
function chatTopic(chatLines = [], { player = 'el streamer', gameWords = [], minUsers = MIN_USERS } = {}) {
  const byCat = new Map();
  const wordUsers = new Map();
  let total = 0;
  for (const { username, message } of chatLines) {
    const user = String(username || '').toLowerCase();
    const cat = classifyLine(message, gameWords);
    total++;
    if (!cat) continue;
    if (!byCat.has(cat)) byCat.set(cat, new Set());
    byCat.get(cat).add(user);
    for (const w of gameWords) {
      if (new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'u').test(strip(message))) {
        if (!wordUsers.has(w)) wordUsers.set(w, new Set());
        wordUsers.get(w).add(user);
      }
    }
  }
  if (total < 3) return null;
  // Prioridad: lo que más aporta al comentario primero
  const order = ['consejos', 'juego', 'animos', 'risas', 'preguntas'];
  const cat = order.find((c) => (byCat.get(c)?.size || 0) >= minUsers);
  if (!cat) return null;
  const topWord = [...wordUsers.entries()]
    .filter(([, u]) => u.size >= MIN_USERS)
    .sort((a, b) => b[1].size - a[1].size)[0]?.[0];
  const many = / y /.test(player);
  const text = {
    consejos: `El chat ${many ? 'les' : 'le'} está dando consejos a ${player}`,
    animos: `El chat está animando a ${player}`,
    risas: 'El chat se está riendo bastante',
    preguntas: 'El chat tiene dudas sobre lo que pasa en la partida',
    juego: topWord ? `El chat comenta el juego y habla mucho de ${topWord}` : 'El chat comenta el juego',
  }[cat];
  return { categoria: cat, texto: text, palabra: cat === 'juego' ? topWord || null : null };
}

// Claves de cada tipo de hecho: raíces que delatan que un comentario habla de él (ver quality.touchesKeys)
const KEYS = {
  estado: ['juego', 'jugar', 'jugando', 'juega', 'juegan', 'partida', 'mando', 'aventura'],
  tiempo: ['hora', 'rato', 'directo', 'tiempo', 'minuto', 'media', 'tarde', 'noche', 'principio', 'empez', 'aguant'],
  caida: [
    'caer',
    'cae',
    'caen',
    'caes',
    'caid',
    'cayo',
    'cayendo',
    'suelo',
    'muert',
    'muere',
    'morir',
    'levant',
    'intento',
    'racha',
    'seguidas',
    'tropez',
    'tropiez',
    'primera',
  ],
  jefe: ['jefe', 'boss', 'victoria', 'gana', 'derrot', 'supera', 'tumba', 'venc', 'fuera'],
  chat: ['chat', 'lusorum', 'vosotr'],
  consejos: ['consej', 'aconsej', 'estrategi', 'caso', 'recomend', 'entrenador', 'guia', 'ayud', 'indicacion'],
  animos: ['anim', 'apoy', 'grada', 'aplau', 'empuj', 'fuerza'],
  risas: ['rie', 'ries', 'reis', 'reir', 'rien', 'riendo', 'risa', 'gracia', 'carcajad', 'chiste'],
  preguntas: ['duda', 'pregunt', 'respuesta', 'entera', 'explic', 'perdid'],
  juego: ['juego', 'coment', 'opina', 'habla'],
};

// Palabras significativas de un hecho: lo que un comentario puede citar sin inventar nada
function keysOf(text, extra = []) {
  const words = strip(text)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set([...words, ...extra.map(strip)])];
}

function unitsOf(e) {
  return Number.isInteger(e.n) && e.n > 0 ? e.n : 1;
}

// Hechos del momento: lista de {id, tipo, texto, claves}. Tipos: suceso, chat, estado, tiempo.
// `avoid`: tipos de los últimos comentarios, del más antiguo al más reciente; pasan al final en ese orden, así el primer
// hecho (el que se comenta) va rotando de tipo. `moment`: el suceso en cola que se comenta ({ kind, description }); va el
// primero, es «abierto» (no exige claves) y sustituye a los hechos de caídas y jefes. `citeDeaths`: false si el mensaje
// anterior del bot ya dio la cifra de caídas. `player`: «Manu», «Pao» o «Manu y Pao».
// No inventa nada: cada hecho sale de un dato recibido. Puede devolver menos de 2 hechos si no hay datos.
function buildMomentFacts({
  game,
  gameWords = [],
  minutes,
  deathCount = 0,
  bosses = 0,
  player = 'el streamer',
  events = [],
  chatLines = [],
  now = Date.now(),
  avoid = [],
  moment = null,
  citeDeaths = true,
} = {}) {
  const facts = [];
  const push = (tipo, texto, extra = [], more = {}) =>
    facts.push({ tipo, texto, claves: keysOf(texto, extra), ...more });
  const many = / y /.test(player);

  if (moment?.description) push('suceso', String(moment.description).replace(/[.\s]+$/, ''), [], { abierto: true });
  if (game) push('estado', `Juegan a ${game} y ${many ? 'juegan' : 'juega'} ${player}`, [game, ...KEYS.estado]);
  if (Number.isFinite(minutes) && minutes >= MIN_MINUTES)
    push('tiempo', `Llevan ${approxDuration(minutes)} de directo`, KEYS.tiempo);

  const recent = (events || []).filter((e) => now - e.ts <= RECENT_MS);
  const recentDeaths = recent.filter((e) => e.type === 'death').reduce((a, e) => a + unitsOf(e), 0);
  const recentBosses = recent.filter((e) => ['boss', 'victory'].includes(e.type)).length;
  if (!moment) {
    if (recentDeaths > 0) {
      const total =
        citeDeaths && deathCount >= recentDeaths ? `; van ${plural(deathCount, 'caída', 'caídas')} hoy` : '';
      push('suceso', `${player} ${many ? 'acaban' : 'acaba'} de caer${total}`, KEYS.caida);
    } else if (deathCount > 0 && citeDeaths) {
      push('suceso', `${player} ${many ? 'llevan' : 'lleva'} ${plural(deathCount, 'caída', 'caídas')} hoy`, KEYS.caida);
    }
    if (recentBosses > 0) push('suceso', 'Se acaba de superar un jefe', KEYS.jefe);
    else if (bosses > 0)
      push('suceso', `Hoy ${bosses === 1 ? 'ha caído' : 'han caído'} ${plural(bosses, 'jefe', 'jefes')}`, KEYS.jefe);
  }

  const topic = chatTopic(chatLines, { player, gameWords });
  if (topic)
    push('chat', topic.texto, [...KEYS.chat, ...KEYS[topic.categoria], ...(topic.palabra ? [topic.palabra] : [])], {
      categoria: topic.categoria,
    });

  const rank = (f) => {
    if (f.abierto) return -1;
    const avoided = avoid.lastIndexOf(f.tipo);
    return (avoided >= 0 ? 10 * (avoided + 1) : 0) + ['suceso', 'chat', 'estado', 'tiempo'].indexOf(f.tipo);
  };
  const picked = facts.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FACTS);
  return picked.map((f, i) => ({ id: `h${i + 1}`, ...f }));
}

// Bloque <hechos> para los prompts; '' si no hay hechos
function renderFacts(facts) {
  if (!facts?.length) return '';
  return `<hechos>\n${facts.map((f) => `${f.id}. ${f.texto}`).join('\n')}\n</hechos>`;
}

module.exports = { buildMomentFacts, chatTopic, classifyLine, gameVocabulary, properNouns, renderFacts, keysOf };
