const { groqWithRetry, truncate } = require('../utils/groq-utils');
const { getCurrentGame, getGameInfo } = require('../twitch/api');
const { canMakeRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');
const { setTriviaActive, getTriviaStats, registrarAcierto, registrarFallo } = require('../utils/state');

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
  { question: '¿Qué es el FUA según el meme original?', answer: 'un grito' },
  { question: '¿Cómo se llama el bot del canal?', answer: 'dios_fua' },
  { question: '¿ParLusorum es un streamer o una pareja de streamers?', answer: 'pareja' },
  { question: '¿En qué juego cooperativo han jugado juntos ParLusorum?', answer: 'it takes two' },
  { question: '¿De qué mitología trata Black Myth: Wukong?', answer: 'china' },
  { question: '¿Cómo se llama el juego de supervivencia post-apocalíptico que han jugado en el canal?', answer: 'the last of us part ii remastered' },
];

let activeTriviaQuestion = null;
let triviaTimeout = null;
let triviaHintStage = 0;
const askedQuestions = new Set();

// Evita llamar a Groq más de una vez cada 2 min para el mismo juego
let lastGeneratedQuestion = null; // { question, answer, pistas, curiosidad, game, ts }
const GENERATED_TTL = 2 * 60 * 1000;

// --- Normalización, similitud y pistas ---
const ARTICLES = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'the', 'a', 'an']);
const SIMILARITY_THRESHOLD = 0.85;

function normalizeAnswer(text) {
  const words = String(text || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  const noArticles = words.filter(w => !ARTICLES.has(w));
  return (noArticles.length ? noArticles : words).join(' ');
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

function isAnswerMatch(message, answer) {
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
  const hints = [`${words.length > 1 ? `${words.length} palabras, ` : ''}${letters} ${letters === 1 ? "letra" : "letras"}`];
  if (letters >= 5) {
    const first = words[0][0].toUpperCase();
    const mask = words.map((w, i) => (i === 0 ? first + '_'.repeat(w.length - 1) : '_'.repeat(w.length))).join(' ');
    hints.push(`empieza por "${first}": ${mask}`);
  }
  return hints;
}

async function handleTrivia(client, channel) {
  if (activeTriviaQuestion) {
    client.say(channel, truncate(`❓ Ya hay una pregunta activa: "${activeTriviaQuestion.question}"`));
    return;
  }

  let q = null;

  if (canMakeRequest()) {
    try {
      const gameInfo = await getCurrentGame();
      const game = gameInfo?.game;
      if (game) {
        if (lastGeneratedQuestion && lastGeneratedQuestion.game === game &&
            Date.now() - lastGeneratedQuestion.ts < GENERATED_TTL) {
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
                content: `Genera una pregunta de trivia sobre el videojuego "${game}" para un chat de Twitch.\nUsa EXCLUSIVAMENTE estos datos: la pregunta, la respuesta y la curiosidad deben salir SOLO de ellos; no añadas nada de tu memoria.\nRedacta SIEMPRE en español (traduce lo que esté en inglés). La respuesta debe ser de 1-3 palabras y no debe aparecer en la pregunta.${dificultadHint}\n\nDATOS:\n${datos}`
              }]
            });
            const choice = response.choices[0];
            if (choice?.finish_reason === 'length') logger.warn('Trivia Groq: respuesta cortada por max_tokens');
            const toolCall = choice?.message?.tool_calls?.[0];
            const args = JSON.parse(toolCall.function.arguments);
            const answer = String(args.respuesta_correcta || '').trim();
            if (args.pregunta && answer && !normalizeAnswer(args.pregunta).includes(normalizeAnswer(answer))) {
              q = {
                question: truncate(args.pregunta, 200),
                answer: answer.toLowerCase(),
                pistas: buildHints(answer),
                curiosidad: truncate(args.curiosidad || '', 150),
                game,
                ts: Date.now()
              };
              lastGeneratedQuestion = q;
            }
          }
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
  client.say(channel, truncate(`🧠 TRIVIA: ${q.question} (${hasPistas ? '15s — habrá pistas si nadie responde' : '30 segundos para responder'})`));
  scheduleNextTriviaPhase(client, channel);
}

// Gestiona las fases: pista 1 (15s) → pista 2 (15s) → respuesta (15s).
// Sin pistas (banco estático): una sola fase de 30s, igual que antes.
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
  }, pistas.length > 0 ? 15000 : 30000);
}

function checkTriviaAnswer(client, channel, tags, message) {
  if (!activeTriviaQuestion) return;

  if (isAnswerMatch(message, activeTriviaQuestion.answer)) {
    const username = tags['display-name'];
    clearTimeout(triviaTimeout);
    const curiosidadWin = activeTriviaQuestion.curiosidad ? ` 💡 ${activeTriviaQuestion.curiosidad}` : '';
    client.say(channel, truncate(`🎉 ¡@${username} ha acertado! ¡Enhorabuena! 🏆${curiosidadWin}`));
    activeTriviaQuestion = null;
    triviaHintStage = 0;
    registrarAcierto();
    setTriviaActive(false);
  }
}

function handle(client, channel, tags, command, args) {
  switch (command) {
    case 'trivia':
      handleTrivia(client, channel).catch(err => logger.error(`Trivia: ${err.message}`));
      return;
  }
}

module.exports = { handle, checkTriviaAnswer, isAnswerMatch, buildHints, normalizeAnswer };
