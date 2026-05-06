const { setTriviaActive } = require('../utils/state');

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
  { question: '¿Cómo se llama el remake del juego del rey de los zombies que jugaron?', answer: 'the last of us part ii remastered' },
];

let activeTriviaQuestion = null;
let triviaTimeout = null;
const askedQuestions = new Set();

function handleTrivia(client, channel) {
  if (activeTriviaQuestion) {
    client.say(channel, `❓ Ya hay una pregunta activa: "${activeTriviaQuestion.question}"`);
    return;
  }

  if (askedQuestions.size >= triviaQuestions.length) askedQuestions.clear();

  let q;
  do {
    q = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
  } while (askedQuestions.has(q.question));

  askedQuestions.add(q.question);
  activeTriviaQuestion = q;
  setTriviaActive(true);

  client.say(channel, `🧠 TRIVIA: ${q.question} (30 segundos para responder)`);

  triviaTimeout = setTimeout(() => {
    if (activeTriviaQuestion) {
      client.say(channel, `⏰ ¡Tiempo! La respuesta era: ${q.answer}`);
      activeTriviaQuestion = null;
      setTriviaActive(false);
    }
  }, 30000);
}

function checkTriviaAnswer(client, channel, tags, message) {
  if (!activeTriviaQuestion) return;

  const normalizedMsg = message.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normalizedAnswer = activeTriviaQuestion.answer.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (normalizedMsg === normalizedAnswer) {
    const username = tags['display-name'];
    clearTimeout(triviaTimeout);
    client.say(channel, `🎉 ¡@${username} ha acertado! ¡Enhorabuena! 🏆`);
    activeTriviaQuestion = null;
    setTriviaActive(false);
  }
}

// --- Moneda ---
const monedaCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of monedaCooldowns) {
    if (now > expiry) monedaCooldowns.delete(key);
  }
}, 30 * 60 * 1000);

function handleMoneda(client, channel, tags) {
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const now = Date.now();

  if (monedaCooldowns.has(userId) && now < monedaCooldowns.get(userId)) {
    const remaining = Math.ceil((monedaCooldowns.get(userId) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para lanzar la moneda de nuevo.`);
    return;
  }

  monedaCooldowns.set(userId, now + 30000);
  const result = Math.random() < 0.5 ? '🌕 CARA' : '🌑 CRUZ';
  client.say(channel, `🪙 @${username} ha lanzado la moneda... ¡${result}!`);
}

function handle(client, channel, tags, command, args) {
  switch (command) {
    case 'trivia': return handleTrivia(client, channel);
    case 'moneda': return handleMoneda(client, channel, tags);
  }
}

module.exports = { handle, checkTriviaAnswer };
