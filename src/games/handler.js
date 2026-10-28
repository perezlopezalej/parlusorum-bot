const { groqWithRetry, truncate } = require('../utils/groq-utils');
const { getCurrentGame, getGameInfo } = require('../twitch/api');
const { canMakeRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');
const { setTriviaActive, getTriviaStats, registrarAcierto, registrarFallo, bumpTriviaStreak, getTriviaTopCache, setTriviaTopCache, invalidateTriviaTopCache } = require('../utils/state');
const { incrementUserCounter, getCounterLeaderboard, getRecentSessionDeaths, getLoreRows } = require('../utils/supabase');
const { touchesAvoidedTopic } = require('../lore/handler');
const { sanitizeForAI } = require('../utils/filter');
const { buildChannelQuestion } = require('./channel-questions');
const msgs = require('../../config/messages.json').trivia_rank;

const WINS_FACT = 'trivia_wins';
const TOP_CACHE_TTL = 5 * 60 * 1000;

// --- Trivia (general + canal) ---
const triviaQuestions = [
  // Generales
  { question: '¿En qué año salió Minecraft?', answer: '2011' },
  { question: '¿Cuántos jugadores tiene un equipo de fútbol?', answer: '11' },
  { question: '¿Cuál es el planeta más grande del sistema solar?', answer: 'jupiter' },
  { question: '¿Cuántos colores tiene el arcoíris?', answer: '7' },
  { question: '¿En qué país se inventó el videojuego Tetris?', answer: 'rusia' },
  { question: '¿Cuál es el juego más vendido de la historia?', answer: 'minecraft' },
  { question: '¿Cuántos bits tiene un byte?', answer: '8' },
  { question: '¿En qué año se fundó Twitch?', answer: '2011' },
  { question: '¿Cuántos jugadores tiene un equipo de baloncesto?', answer: '5' },
  { question: '¿Qué empresa creó PlayStation?', answer: 'sony' },
  { question: '¿En qué año salió el primer iPhone?', answer: '2007' },
  { question: '¿Cuántos lados tiene un hexágono?', answer: '6' },
  { question: '¿Quién creó el personaje de Mario Bros?', answer: 'miyamoto' },
  { question: '¿En qué año salió Fortnite?', answer: '2017' },
  { question: '¿Cuál es el océano más grande del mundo?', answer: 'pacifico' },
  { question: '¿Cuántos continentes hay en la Tierra?', answer: '7' },
  { question: '¿Qué empresa desarrolló Grand Theft Auto?', answer: 'rockstar' },
  { question: '¿En qué año salió League of Legends?', answer: '2009' },
  { question: '¿Cuántos segundos tiene un minuto?', answer: '60' },
  { question: '¿Qué empresa creó Xbox?', answer: 'microsoft' },
  { question: '¿En qué país se inventó el ajedrez?', answer: 'india' },
  { question: '¿Cuántos planetas hay en el sistema solar?', answer: '8' },
  { question: '¿Qué empresa creó la Nintendo Switch?', answer: 'nintendo' },
  { question: '¿En qué año salió Among Us?', answer: '2018' },
  { question: '¿Cuál es la capital de Japón?', answer: 'tokio' },
  { question: '¿Cuántos jugadores hay en un equipo de béisbol?', answer: '9' },
  // Del canal
  { question: '¿Qué es el FUA según el meme original?', answer: 'fuerza universal aplicada' },
  { question: '¿Cómo se llama el bot del canal?', answer: 'dios_fua' },
  { question: '¿ParLusorum es un streamer o una pareja de streamers?', answer: 'pareja' },
  { question: '¿En qué juego cooperativo han jugado juntos ParLusorum?', answer: 'it takes two' },
  { question: '¿De qué mitología trata Black Myth: Wukong?', answer: 'china' },
  { question: '¿Cómo se llama el juego de supervivencia post-apocalíptico que han jugado en el canal?', answer: 'the last of us part ii remastered' },
];

let activeTriviaQuestion = null;
let triviaTimeout = null;
let triviaHintStage = 0;
const TRIVIA_DURATION_MS = Math.max(10000, parseInt(process.env.TRIVIA_DURATION_MS || '30000', 10) || 30000);
const askedQuestions = new Set();

// Evita llamar a Groq más de una vez cada 2 min para el mismo juego
let lastGeneratedQuestion = null; // { question, answer, pistas, curiosidad, game, ts }
const GENERATED_TTL = 2 * 60 * 1000;

// Últimas preguntas generadas por juego, para no repetirlas
const RECENT_PER_GAME = 15;
const recentQuestions = new Map(); // game -> [question]

function questionWords(text) {
  return new Set(normalizeAnswer(text).split(' ').filter(w => w.length > 2));
}

function isSimilarQuestion(a, b) {
  const wa = questionWords(a);
  const wb = questionWords(b);
  if (!wa.size || !wb.size) return false;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common) >= 0.6;
}

function isRecentQuestion(game, question) {
  return (recentQuestions.get(game) || []).some(r => isSimilarQuestion(r, question));
}

function rememberQuestion(game, question) {
  const list = recentQuestions.get(game) || [];
  list.push(question);
  if (list.length > RECENT_PER_GAME) list.shift();
  recentQuestions.set(game, list);
}

// Pregunta sobre la historia del canal (muertes, ranking, lore activo), sin IA y sin repetir
const CHANNEL_QUESTION_CHANCE = 0.25;
const CHANNEL_KEY = '__canal__';

async function getChannelQuestion() {
  const [sessions, [champion], loreRows] = await Promise.all([getRecentSessionDeaths(50), getTop(1), getLoreRows(['active'])]);
  const lore = loreRows
    .map(r => ({ kind: r.kind, term: sanitizeForAI(r.term) }))
    .filter(r => r.term && !touchesAvoidedTopic(r.term));
  const picked = buildChannelQuestion({ sessions, champion, lore }, { isRecent: question => isRecentQuestion(CHANNEL_KEY, question) });
  if (!picked) return null;
  rememberQuestion(CHANNEL_KEY, picked.question);
  return { ...picked, aliases: picked.aliases || [], pistas: buildHints(picked.answer), game: null, ts: Date.now() };
}

const winsText = n => `${n} ${n === 1 ? 'victoria' : 'victorias'}`;

// --- Normalización, similitud y pistas ---
const ARTICLES = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'the', 'a', 'an']);
const CONNECTORS = new Set(['de', 'del', 'y', 'en']);
const SIMILARITY_THRESHOLD = 0.85;

function normalizeAnswer(text) {
  const words = String(text || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  const noArticles = words.filter(w => !ARTICLES.has(w));
  const base = noArticles.length ? noArticles : words;
  // Conectores solo se ignoran en respuestas de varias palabras
  const noConnectors = base.length > 1 ? base.filter(w => !CONNECTORS.has(w)) : base;
  return (noConnectors.length ? noConnectors : base).join(' ');
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Devuelve { d, m, y } si el texto es una fecha completa ("22 de junio de 2023", "22 junio 2023", "22/06/2023", "2023-06-22")
function parseDate(text) {
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  let d, m, y, r;
  if ((r = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/))) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = t.match(/^(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})$/))) {
    d = +r[1]; m = MONTHS.indexOf(r[2]) + 1; y = +r[3];
  } else return null;
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { d, m, y } : null;
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function isAnswerMatch(message, answer, aliases = []) {
  return [answer, ...aliases].some(a => isSingleMatch(message, a));
}

function isSingleMatch(message, answer) {
  const ad = parseDate(answer);
  if (ad) {
    const md = parseDate(message);
    return !!md && md.d === ad.d && md.m === ad.m && md.y === ad.y;
  }
  const m = normalizeAnswer(message);
  const a = normalizeAnswer(answer);
  if (!m || !a) return false;
  if (m === a) return true;
  // Respuestas cortas o numéricas: solo coincidencia exacta (evita que "7" valga por "8")
  if (a.length < 5 || /\d/.test(a)) return false;
  const similarity = 1 - levenshtein(m, a) / Math.max(m.length, a.length);
  return similarity >= SIMILARITY_THRESHOLD;
}

// Pistas generadas en código: nunca revelan la respuesta completa.
// Pista 1: nº de palabras/letras. Pista 2 (solo si la respuesta es larga): primera letra.
function buildHints(answer) {
  const words = String(answer).trim().split(/\s+/).filter(Boolean);
  const letters = words.join('').length;
  const unit = /^\d+$/.test(words.join('')) ? ['cifra', 'cifras'] : ['letra', 'letras'];
  const hints = [`${words.length > 1 ? `${words.length} palabras, ` : ''}${letters} ${letters === 1 ? unit[0] : unit[1]}`];
  if (letters >= 5) {
    const first = words[0][0].toUpperCase();
    const mask = words.map((w, i) => (i === 0 ? first + '_'.repeat(w.length - 1) : '_'.repeat(w.length))).join(' ');
    hints.push(`empieza por "${first}": ${mask}`);
  }
  return hints;
}

// Se activa de forma síncrona al entrar: mientras se genera la pregunta (varios await) otro !trivia no lanza una segunda
let triviaStarting = false;

async function handleTrivia(client, channel) {
  if (activeTriviaQuestion) {
    client.say(channel, truncate(`❓ Ya hay una pregunta activa: "${activeTriviaQuestion.question}"`));
    return;
  }
  if (triviaStarting) return;
  triviaStarting = true;
  try {
    await startTrivia(client, channel);
  } finally {
    triviaStarting = false;
  }
}

async function startTrivia(client, channel) {

  let q = null;

  if (Math.random() < CHANNEL_QUESTION_CHANCE) {
    q = await getChannelQuestion().catch(err => { logger.warn(`Trivia canal: ${err.message}`); return null; });
  }

  if (!q && canMakeRequest()) {
    try {
      const gameInfo = await getCurrentGame();
      const game = gameInfo?.game;
      if (game) {
        if (lastGeneratedQuestion && lastGeneratedQuestion.game === game &&
            Date.now() - lastGeneratedQuestion.ts < GENERATED_TTL &&
            !isRecentQuestion(game, lastGeneratedQuestion.question)) {
          q = lastGeneratedQuestion;
        } else {
          const stats = getTriviaStats();
          let dificultadHint = '';
          if (stats.rachaActual >= 3) {
            dificultadHint = ` El chat lleva una racha de ${stats.rachaActual} aciertos seguidos — genera una pregunta difícil.`;
          } else if (stats.rachaActual <= -3) {
            dificultadHint = ` El chat lleva ${Math.abs(stats.rachaActual)} fallos seguidos — genera una pregunta más fácil.`;
          }
          // Solo se genera con datos reales de RAWG; sin ellos, banco estático
          const rawg = await getGameInfo(game, { detail: true });
          if (rawg?.description && rawg.description.length >= 80 && (rawg.developers || rawg.released)) {
            const recientes = recentQuestions.get(game) || [];
            const evitar = recientes.length ? `\nNO repitas ni imites estas preguntas ya hechas:\n- ${recientes.join('\n- ')}` : '';
            const datos = [
              `Nombre: ${rawg.name}`,
              rawg.released ? `Fecha de salida: ${rawg.released}` : null,
              rawg.developers ? `Desarrolladora: ${rawg.developers}` : null,
              rawg.genres ? `Géneros: ${rawg.genres}` : null,
              `Descripción (puede estar en inglés): ${rawg.description}`
            ].filter(Boolean).join('\n');
            const response = await groqWithRetry({
              max_tokens: 500,
              reasoning_effort: 'low',
              tools: [{
                type: 'function',
                function: {
                  name: 'generate_trivia',
                  description: 'Genera una pregunta de trivia sobre el juego actual usando solo los datos dados',
                  parameters: {
                    type: 'object',
                    properties: {
                      pregunta:           { type: 'string', description: 'En español, máx. 150 caracteres' },
                      respuesta_correcta: { type: 'string', description: 'En español o nombre propio, 1-3 palabras, sin frases' },
                      respuestas_alternativas: { type: 'array', items: { type: 'string' }, description: 'Otras respuestas válidas: nombre original en inglés, siglas o variantes habituales (puede ir vacío)' },
                      dificultad:         { type: 'string', enum: ['facil', 'media', 'dificil'] },
                      curiosidad:         { type: 'string', description: 'En español, máx. 120 caracteres, sacada de los datos' }
                    },
                    required: ['pregunta', 'respuesta_correcta', 'dificultad', 'curiosidad']
                  }
                }
              }],
              tool_choice: { type: 'function', function: { name: 'generate_trivia' } },
              messages: [{
                role: 'user',
                content: `Genera una pregunta de trivia sobre el videojuego "${game}" para un chat de Twitch.\nUsa EXCLUSIVAMENTE estos datos: la pregunta, la respuesta y la curiosidad deben salir SOLO de ellos; no añadas nada de tu memoria.\nRedacta SIEMPRE en español (traduce lo que esté en inglés): la pregunta y la respuesta principal en español; en respuestas_alternativas pon el nombre original en inglés, siglas o variantes habituales. La respuesta debe ser de 1-3 palabras y no debe aparecer en la pregunta. Si la pregunta es sobre una fecha, pregunta preferentemente solo por el año (respuesta de 4 dígitos, fácil de escribir en el chat).\nREGLA ANTI-SPOILERS: el streamer está jugando este juego ahora mismo. La pregunta, la respuesta y la curiosidad NO pueden revelar giros de la trama, muertes de personajes, identidades secretas ni el final, aunque aparezcan en los datos. Céntrate en datos del juego: estudio, año, género, mecánicas, ambientación y personajes principales tal como se presentan al inicio.${dificultadHint}${evitar}\n\nDATOS:\n${datos}`
              }]
            });
            const choice = response.choices[0];
            if (choice?.finish_reason === 'length') logger.warn('Trivia Groq: respuesta cortada por max_tokens');
            const toolCall = choice?.message?.tool_calls?.[0];
            const args = JSON.parse(toolCall.function.arguments);
            const answer = String(args.respuesta_correcta || '').trim();
            if (args.pregunta && isRecentQuestion(game, args.pregunta)) {
              logger.info('Trivia Groq: pregunta repetida, uso banco estático');
            } else if (args.pregunta && answer && !normalizeAnswer(args.pregunta).includes(normalizeAnswer(answer))) {
              const aliases = (Array.isArray(args.respuestas_alternativas) ? args.respuestas_alternativas : [])
                .map(a => String(a || '').trim()).filter(Boolean).slice(0, 6);
              q = {
                question: truncate(args.pregunta, 200),
                answer: answer.toLowerCase(),
                aliases,
                pistas: buildHints(answer),
                curiosidad: truncate(args.curiosidad || '', 150),
                game,
                ts: Date.now()
              };
              lastGeneratedQuestion = q;
            }
          }
          if (q) rememberQuestion(game, q.question);
        }
      }
    } catch (err) {
      logger.warn(`Trivia Groq: ${err.message}`);
    }
  }

  if (!q) {
    if (askedQuestions.size >= triviaQuestions.length) askedQuestions.clear();
    let candidate;
    do {
      candidate = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
    } while (askedQuestions.has(candidate.question));
    askedQuestions.add(candidate.question);
    q = { question: candidate.question, answer: candidate.answer, pistas: [] };
  }

  activeTriviaQuestion = q;
  triviaHintStage = 0;
  setTriviaActive(true);

  const hasPistas = q.pistas.length > 0;
  const totalSecs = Math.round(TRIVIA_DURATION_MS / 1000);
  client.say(channel, truncate(`🧠 TRIVIA: ${q.question} (${totalSecs}s${hasPistas ? ' — habrá pistas si nadie responde' : ' para responder'})`));
  scheduleNextTriviaPhase(client, channel);
}

// Reparte TRIVIA_DURATION_MS en (pistas + 1) fases iguales: pista 1 → pista 2 → respuesta.
// Sin pistas (banco estático): una sola fase con toda la duración.
function scheduleNextTriviaPhase(client, channel) {
  const q = activeTriviaQuestion;
  if (!q) return;
  const pistas = q.pistas || [];

  triviaTimeout = setTimeout(() => {
    if (!activeTriviaQuestion) return;
    if (triviaHintStage < pistas.length) {
      client.say(channel, truncate(`💡 Pista ${triviaHintStage + 1}: ${pistas[triviaHintStage]}`));
      triviaHintStage++;
      scheduleNextTriviaPhase(client, channel);
    } else {
      const curiosidadTimeout = activeTriviaQuestion.curiosidad ? ` 💡 ${activeTriviaQuestion.curiosidad}` : '';
      client.say(channel, truncate(`⏰ ¡Tiempo! La respuesta era: ${activeTriviaQuestion.answer}${curiosidadTimeout}`));
      activeTriviaQuestion = null;
      triviaHintStage = 0;
      registrarFallo();
      setTriviaActive(false);
    }
  }, Math.round(TRIVIA_DURATION_MS / (pistas.length + 1)));
}

function checkTriviaAnswer(client, channel, tags, message) {
  if (!activeTriviaQuestion) return;

  if (isAnswerMatch(message, activeTriviaQuestion.answer, activeTriviaQuestion.aliases || [])) {
    const username = tags['display-name'];
    clearTimeout(triviaTimeout);
    const curiosidadWin = activeTriviaQuestion.curiosidad ? ` 💡 ${activeTriviaQuestion.curiosidad}` : '';
    activeTriviaQuestion = null;
    triviaHintStage = 0;
    registrarAcierto();
    setTriviaActive(false);
    announceWin(client, channel, username, curiosidadWin)
      .catch(err => logger.error(`Trivia ranking: ${err.message}`));
  }
}

// Top N con caché de 5 min (se invalida en cada victoria)
async function getTop(limit = 5) {
  const cache = getTriviaTopCache();
  if (cache.data && Date.now() - cache.ts < TOP_CACHE_TTL) return cache.data.slice(0, limit);
  const top = await getCounterLeaderboard(WINS_FACT, 10);
  setTriviaTopCache(top);
  return top.slice(0, limit);
}

async function announceWin(client, channel, username, curiosidad) {
  const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
  const wins = await incrementUserCounter(username, WINS_FACT);
  const streak = bumpTriviaStreak(username);
  let text = fill(msgs.win, { username });
  if (wins) {
    invalidateTriviaTopCache();
    const top = await getTop(5);
    const position = top.findIndex(r => r.username === username.toLowerCase()) + 1;
    const vars = { username, wins: winsText(wins), streak, position };
    if (position === 1 && wins > 1) text = fill(msgs.win_champion, vars);
    else if (streak >= 2) text = fill(msgs.win_streak, vars);
    else if (position > 0) text = fill(msgs.win_position, vars);
    else text = fill(msgs.win_total, vars);
  }
  client.say(channel, truncate(`${text}${curiosidad}`));
}

async function handleTop(client, channel) {
  const top = await getTop(5);
  if (!top.length) {
    client.say(channel, truncate(msgs.top_empty));
    return;
  }
  const medals = ['🥇', '🥈', '🥉', '4º', '5º'];
  client.say(channel, truncate(msgs.top_title + top.map((r, i) => `${medals[i]} ${r.username} (${winsText(r.count)})`).join(' · ')));
}

// Campeón actual para el contexto de la IA (null si no hay ranking)
async function getChampion() {
  const [first] = await getTop(1);
  return first || null;
}

function handle(client, channel, tags, command, args) {
  switch (command) {
    case 'trivia':
      handleTrivia(client, channel).catch(err => logger.error(`Trivia: ${err.message}`));
      return;
    case 'top':
      handleTop(client, channel).catch(err => logger.error(`!top: ${err.message}`));
      return;
  }
}

module.exports = { handle, handleTrivia, checkTriviaAnswer, getChampion, isAnswerMatch, buildHints, normalizeAnswer };
