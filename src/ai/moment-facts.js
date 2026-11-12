// Hechos del momento para el cohost y el timer: frases neutras escritas por el código a partir del estado del stream.
// Así el modelo no recibe líneas literales del chat (jerga, nicks, chistes internos) y no puede copiarlas.
// Módulo puro: sin estado ni I/O. Aún no está conectado a los prompts.
const { approxDuration, mentionsEthnicTerms, personalMatch } = require('./quality');

const MAX_FACTS = 5;
const MIN_USERS = 2; // una categoría del chat necesita al menos 2 usuarios distintos
const RECENT_MS = 10 * 60 * 1000;

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
  /(?<!\p{L})(?:tienes que|tenias que|tendrias que|deberias|tira|usa|mira|ve a|ve hacia|dale|sube|baja|cuidado|no vayas|no (?:le )?des|ataca|esquiva|corre|salta|agarrate|apunta|prueba|intenta|intentalo|por la (?:izquierda|derecha)|a la (?:izquierda|derecha)|hacia (?:arriba|abajo))(?!\p{L})/iu;
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

// Tema del chat en una frase neutra, o null si no hay un tema claro (charla ajena, pocos usuarios).
// Solo se nombra una palabra del vocabulario del juego, y solo si 2+ usuarios la usan.
function chatTopic(chatLines = [], { player = 'el streamer', gameWords = [] } = {}) {
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
  const cat = order.find((c) => (byCat.get(c)?.size || 0) >= MIN_USERS);
  if (!cat) return null;
  const topWord = [...wordUsers.entries()]
    .filter(([, u]) => u.size >= MIN_USERS)
    .sort((a, b) => b[1].size - a[1].size)[0]?.[0];
  const text = {
    consejos: `El chat le está dando consejos a ${player}`,
    animos: `El chat está animando a ${player}`,
    risas: 'El chat se está riendo bastante',
    preguntas: 'El chat tiene dudas sobre lo que pasa en la partida',
    juego: topWord ? `El chat comenta el juego y habla mucho de ${topWord}` : 'El chat comenta el juego',
  }[cat];
  return { categoria: cat, texto: text, palabra: cat === 'juego' ? topWord || null : null };
}

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
// `avoid`: tipos usados en los últimos comentarios; pasan al final y, si sobra hueco, se quedan fuera.
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
} = {}) {
  const facts = [];
  const push = (tipo, texto, extra = []) => facts.push({ tipo, texto, claves: keysOf(texto, extra) });

  if (game) push('estado', `Juegan a ${game} y juega ${player}`, [game]);
  if (Number.isFinite(minutes) && minutes >= 0) push('tiempo', `Llevan ${approxDuration(minutes)} de directo`);

  const recent = (events || []).filter((e) => now - e.ts <= RECENT_MS);
  const recentDeaths = recent.filter((e) => e.type === 'death').reduce((a, e) => a + unitsOf(e), 0);
  const recentBosses = recent.filter((e) => ['boss', 'victory'].includes(e.type)).length;
  if (recentDeaths > 0) {
    const total = deathCount >= recentDeaths ? `; van ${plural(deathCount, 'caída', 'caídas')} hoy` : '';
    push('suceso', `${player} acaba de caer${total}`, ['caer', 'caida']);
  } else if (deathCount > 0) {
    push('suceso', `${player} lleva ${plural(deathCount, 'caída', 'caídas')} hoy`, ['caida']);
  }
  if (recentBosses > 0) push('suceso', 'Se acaba de superar un jefe', ['jefe']);
  else if (bosses > 0)
    push('suceso', `Hoy ${bosses === 1 ? 'ha caído' : 'han caído'} ${plural(bosses, 'jefe', 'jefes')}`, ['jefe']);

  const topic = chatTopic(chatLines, { player, gameWords });
  if (topic) push('chat', topic.texto, topic.palabra ? [topic.palabra] : []);

  const rank = (f) => (avoid.includes(f.tipo) ? 10 : 0) + ['suceso', 'chat', 'estado', 'tiempo'].indexOf(f.tipo);
  const picked = facts.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FACTS);
  return picked.map((f, i) => ({ id: `h${i + 1}`, ...f }));
}

// Bloque <hechos> para los prompts; '' si no hay hechos
function renderFacts(facts) {
  if (!facts?.length) return '';
  return `<hechos>\n${facts.map((f) => `${f.id}. ${f.texto}`).join('\n')}\n</hechos>`;
}

module.exports = { buildMomentFacts, chatTopic, classifyLine, gameVocabulary, renderFacts, keysOf };
