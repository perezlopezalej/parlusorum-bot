const { groqWithRetry } = require('../utils/groq-utils');
const { getCurrentGame } = require('../twitch/api');
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
  { question: '¿Qué significa FUA según el meme original?', answer: 'fuerza universal aplicada' },
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

async function handleTrivia(client, channel) {
  if (activeTriviaQuestion) {
    client.say(channel, `❓ Ya hay una pregunta activa: "${activeTriviaQuestion.question}"`);
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
          const response = await groqWithRetry({
            max_tokens: 300,
            tools: [{
              type: 'function',
              function: {
                name: 'generate_trivia',
                description: 'Genera una pregunta de trivia sobre el juego actual',
                parameters: {
                  type: 'object',
                  properties: {
                    pregunta:           { type: 'string' },
                    opciones:           { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
                    respuesta_correcta: { type: 'string', description: 'Debe ser exactamente una de las opciones' },
                    dificultad:         { type: 'string', enum: ['facil', 'media', 'dificil'] },
                    curiosidad:         { type: 'string', description: 'Dato extra revelado al dar la respuesta' }
                  },
                  required: ['pregunta', 'opciones', 'respuesta_correcta', 'dificultad', 'curiosidad']
                }
              }
            }],
            tool_choice: { type: 'function', function: { name: 'generate_trivia' } },
            messages: [{
              role: 'user',
              content: `Genera una pregunta de trivia sobre el videojuego "${game}" para un chat de Twitch. La respuesta debe estar en minúsculas, 1-3 palabras.${dificultadHint}`
            }]
          });
          const toolCall = response.choices[0]?.message?.tool_calls?.[0];
          const args = JSON.parse(toolCall.function.arguments);
          if (args.pregunta && args.respuesta_correcta) {
            q = {
              question: args.pregunta,
              answer: args.respuesta_correcta.toLowerCase(),
              pistas: Array.isArray(args.opciones) ? args.opciones.slice(0, 2) : [],
              curiosidad: args.curiosidad || '',
              game,
              ts: Date.now()
            };
            lastGeneratedQuestion = q;
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
  client.say(channel, `🧠 TRIVIA: ${q.question} (${hasPistas ? '15s — habrá pistas si nadie responde' : '30 segundos para responder'})`);
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
      client.say(channel, `💡 Pista ${triviaHintStage + 1}: ${pistas[triviaHintStage]}`);
      triviaHintStage++;
      scheduleNextTriviaPhase(client, channel);
    } else {
      const curiosidadTimeout = activeTriviaQuestion.curiosidad ? ` 💡 ${activeTriviaQuestion.curiosidad}` : '';
      client.say(channel, `⏰ ¡Tiempo! La respuesta era: ${activeTriviaQuestion.answer}${curiosidadTimeout}`);
      activeTriviaQuestion = null;
      triviaHintStage = 0;
      registrarFallo();
      setTriviaActive(false);
    }
  }, pistas.length > 0 ? 15000 : 30000);
}

function checkTriviaAnswer(client, channel, tags, message) {
  if (!activeTriviaQuestion) return;

  const normalizedMsg = message.toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normalizedAnswer = activeTriviaQuestion.answer.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');

  if (normalizedMsg === normalizedAnswer) {
    const username = tags['display-name'];
    clearTimeout(triviaTimeout);
    const curiosidadWin = activeTriviaQuestion.curiosidad ? ` 💡 ${activeTriviaQuestion.curiosidad}` : '';
    client.say(channel, `🎉 ¡@${username} ha acertado! ¡Enhorabuena! 🏆${curiosidadWin}`);
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

module.exports = { handle, checkTriviaAnswer };
