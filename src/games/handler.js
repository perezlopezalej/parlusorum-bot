const fs = require('fs');
const { isDoublePoints } = require('../utils/state');

const pointsPath = './data/points.json';

// --- Cache en memoria para puntos ---
let pointsCache = null;

function loadPoints() {
  if (pointsCache) return pointsCache;
  if (!fs.existsSync(pointsPath)) { pointsCache = {}; return {}; }
  pointsCache = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));
  return pointsCache;
}

function savePoints(data) {
  pointsCache = data;
  fs.writeFileSync(pointsPath, JSON.stringify(data, null, 2));
}

function addPoints(username, amount) {
  const points = loadPoints();
  if (!points[username]) points[username] = { points: 0, achievements: [] };
  const multiplier = isDoublePoints() ? 2 : 1;
  const finalAmount = amount > 0 ? amount * multiplier : amount; // No multiplicar pérdidas
  points[username].points = Math.max(0, points[username].points + finalAmount);
  savePoints(points);
  return points[username].points;
}

function getPoints(username) {
  const points = loadPoints();
  return points[username]?.points || 0;
}

// --- Trivia (ampliada a 30 preguntas) ---
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
const askedQuestions = new Set(); // Evitar repeticiones

function handleTrivia(client, channel) {
  if (activeTriviaQuestion) {
    client.say(channel, `❓ Ya hay una pregunta activa: "${activeTriviaQuestion.question}"`);
    return;
  }

  // Resetear preguntas usadas si se han agotado
  if (askedQuestions.size >= triviaQuestions.length) askedQuestions.clear();

  // Elegir pregunta no repetida
  let q;
  do {
    q = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
  } while (askedQuestions.has(q.question));

  askedQuestions.add(q.question);
  activeTriviaQuestion = q;

  client.say(channel, `🧠 TRIVIA: ${q.question} (tienes 30 segundos para responder)`);

  triviaTimeout = setTimeout(() => {
    if (activeTriviaQuestion) {
      client.say(channel, `⏰ ¡Tiempo! La respuesta era: ${q.answer}`);
      activeTriviaQuestion = null;
    }
  }, 30000);
}

function checkTriviaAnswer(client, channel, tags, message) {
  if (!activeTriviaQuestion) return;
  const normalizedMsg = message.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quitar tildes
  const normalizedAnswer = activeTriviaQuestion.answer.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (normalizedMsg === normalizedAnswer) {
    const username = tags['display-name'];
    clearTimeout(triviaTimeout);
    const total = addPoints(username, 50);
    client.say(channel, `🎉 ¡@${username} ha acertado! +50 puntos (Total: ${total} pts)`);
    activeTriviaQuestion = null;
  }
}

// --- Ruleta con cooldowns con limpieza ---
const ruletaOutcomes = [
  { text: '💀 ¡Has perdido todo! -100 puntos', points: -100 },
  { text: '😅 Mala suerte... -50 puntos', points: -50 },
  { text: '😐 Nada. La ruleta no se mueve hoy.', points: 0 },
  { text: '🎲 Pequeña ganancia +30 puntos', points: 30 },
  { text: '✨ ¡Buena jugada! +75 puntos', points: 75 },
  { text: '🎰 ¡JACKPOT! +200 puntos 🔥', points: 200 },
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
  const now = Date.now();
  const cooldown = 60000;

  if (ruletaCooldowns.has(username) && now < ruletaCooldowns.get(username)) {
    const remaining = Math.ceil((ruletaCooldowns.get(username) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para volver a jugar a la ruleta.`);
    return;
  }

  ruletaCooldowns.set(username, now + cooldown);
  const outcome = ruletaOutcomes[Math.floor(Math.random() * ruletaOutcomes.length)];
  const total = addPoints(username, outcome.points);
  client.say(channel, `🎰 @${username} ${outcome.text} | Total: ${total} pts`);
}

// --- Moneda con cooldowns con limpieza ---
const monedaCooldowns = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of monedaCooldowns) {
    if (now > expiry) monedaCooldowns.delete(key);
  }
}, 30 * 60 * 1000);

function handleMoneda(client, channel, tags) {
  const username = tags['display-name'];
  const now = Date.now();
  const cooldown = 30000;

  if (monedaCooldowns.has(username) && now < monedaCooldowns.get(username)) {
    const remaining = Math.ceil((monedaCooldowns.get(username) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para lanzar la moneda de nuevo.`);
    return;
  }

  monedaCooldowns.set(username, now + cooldown);
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

module.exports = { handle, checkTriviaAnswer, addPoints, getPoints, loadPoints, savePoints };
