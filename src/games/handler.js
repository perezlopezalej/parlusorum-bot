const { setTriviaActive } = require('../ai/handler');

// --- Trivia (30 preguntas sin repetición) ---
const triviaQuestions = [
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
  { question: '¿Cuál es el metal más abundante en la corteza terrestre?', answer: 'aluminio' },
  { question: '¿Cuántos segundos tiene un minuto?', answer: '60' },
  { question: '¿Qué empresa creó Xbox?', answer: 'microsoft' },
  { question: '¿En qué país se inventó el ajedrez?', answer: 'india' },
  { question: '¿Cuántos jugadores tiene un equipo de voleibol?', answer: '6' },
  { question: '¿Cuál es el río más largo del mundo?', answer: 'nilo' },
  { question: '¿En qué año salió Counter-Strike: GO?', answer: '2012' },
  { question: '¿Cuántos planetas hay en el sistema solar?', answer: '8' },
  { question: '¿Qué empresa creó la Nintendo Switch?', answer: 'nintendo' },
  { question: '¿En qué año salió Among Us?', answer: '2018' },
  { question: '¿Cuál es la capital de Japón?', answer: 'tokio' },
  { question: '¿Cuántos jugadores hay en un equipo de béisbol?', answer: '9' },
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
  setTriviaActive(true); // Bloquear co-host

  client.say(channel, `🧠 TRIVIA: ${q.question} (tienes 30 segundos para responder)`);

  triviaTimeout = setTimeout(() => {
    if (activeTriviaQuestion) {
      client.say(channel, `⏰ ¡Tiempo! La respuesta era: ${q.answer}`);
      activeTriviaQuestion = null;
      setTriviaActive(false); // Desbloquear co-host
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
    setTriviaActive(false); // Desbloquear co-host
  }
}

// --- Ruleta ---
const ruletaOutcomes = [
  '💀 ¡Mala suerte total! La ruleta no te quiere hoy.',
  '😅 Casi... pero no. Intenta otra vez.',
  '😐 Nada. La ruleta no se mueve hoy.',
  '🎲 ¡Algo es algo! Pequeña victoria.',
  '✨ ¡Buena jugada! La suerte está de tu lado.',
  '🎰 ¡JACKPOT! ¡Eres el elegido de la ruleta! 🔥',
];

const ruletaCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of ruletaCooldowns) {
    if (now > expiry) ruletaCooldowns.delete(key);
  }
}, 30 * 60 * 1000);

function handleRuleta(client, channel, tags) {
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const now = Date.now();
  const cooldown = 60000;

  if (ruletaCooldowns.has(userId) && now < ruletaCooldowns.get(userId)) {
    const remaining = Math.ceil((ruletaCooldowns.get(userId) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para volver a jugar a la ruleta.`);
    return;
  }

  ruletaCooldowns.set(userId, now + cooldown);
  const outcome = ruletaOutcomes[Math.floor(Math.random() * ruletaOutcomes.length)];
  client.say(channel, `🎰 @${username} ${outcome}`);
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
  const cooldown = 30000;

  if (monedaCooldowns.has(userId) && now < monedaCooldowns.get(userId)) {
    const remaining = Math.ceil((monedaCooldowns.get(userId) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para lanzar la moneda de nuevo.`);
    return;
  }

  monedaCooldowns.set(userId, now + cooldown);
  const result = Math.random() < 0.5 ? '🌕 CARA' : '🌑 CRUZ';
  client.say(channel, `🪙 @${username} ha lanzado la moneda... ¡${result}!`);
}

// --- Handler principal ---
function handle(client, channel, tags, command, args) {
  switch (command) {
    case 'ruleta': return handleRuleta(client, channel, tags);
    case 'trivia': return handleTrivia(client, channel);
    case 'moneda': return handleMoneda(client, channel, tags);
  }
}

module.exports = { handle, checkTriviaAnswer };
