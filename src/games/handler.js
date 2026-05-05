const fs = require('fs');
const path = './data/points.json';

// --- Utilidades de puntos ---
function loadPoints() {
  if (!fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function savePoints(data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function addPoints(username, amount) {
  const { isDoublePoints } = require('../commands/handler');
  const points = loadPoints();
  if (!points[username]) points[username] = { points: 0, achievements: [] };
  const multiplier = isDoublePoints() ? 2 : 1;
  points[username].points += amount * multiplier;
  savePoints(points);
  return points[username].points;
}

function getPoints(username) {
  const points = loadPoints();
  return points[username]?.points || 0;
}

// --- Trivia ---
const triviaQuestions = [
  { question: '¿En qué año salió Minecraft?', answer: '2011' },
  { question: '¿Cuántos jugadores tiene un equipo de fútbol?', answer: '11' },
  { question: '¿Cuál es el planeta más grande del sistema solar?', answer: 'jupiter' },
  { question: '¿Cuántos colores tiene el arcoíris?', answer: '7' },
  { question: '¿En qué país se inventó el videojuego Tetris?', answer: 'rusia' },
  { question: '¿Cuál es el juego más vendido de la historia?', answer: 'minecraft' },
  { question: '¿Cuántos bits tiene un byte?', answer: '8' },
];

let activeTriviaQuestion = null;
let triviaTimeout = null;

function handleTrivia(client, channel) {
  if (activeTriviaQuestion) {
    client.say(channel, `❓ Ya hay una pregunta activa: "${activeTriviaQuestion.question}"`);
    return;
  }

  const q = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
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
  if (message.toLowerCase().trim() === activeTriviaQuestion.answer.toLowerCase()) {
    const username = tags['display-name'];
    clearTimeout(triviaTimeout);
    const total = addPoints(username, 50);
    client.say(channel, `🎉 ¡@${username} ha acertado! +50 puntos (Total: ${total} pts)`);
    activeTriviaQuestion = null;
  }
}

// --- Ruleta ---
const ruletaOutcomes = [
  { text: '💀 ¡Has perdido todo! -100 puntos', points: -100 },
  { text: '😅 Mala suerte... -50 puntos', points: -50 },
  { text: '😐 Nada. La ruleta no se mueve hoy.', points: 0 },
  { text: '🎲 Pequeña ganancia +30 puntos', points: 30 },
  { text: '✨ ¡Buena jugada! +75 puntos', points: 75 },
  { text: '🎰 ¡JACKPOT! +200 puntos 🔥', points: 200 },
];

const ruletaCooldowns = new Map();

function handleRuleta(client, channel, tags) {
  const username = tags['display-name'];
  const now = Date.now();
  const cooldown = 60000; // 1 minuto

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

// --- Moneda ---
const monedaCooldowns = new Map();

function handleMoneda(client, channel, tags) {
  const username = tags['display-name'];
  const now = Date.now();
  const cooldown = 30000; // 30 segundos

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