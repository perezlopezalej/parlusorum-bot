require('dotenv').config();
const tmi = require('tmi.js');
const config = require('./config/commands.json');

// Módulos
const commands = require('./src/commands/handler');
const games = require('./src/games/handler');
const alerts = require('./src/alerts/handler');
const timers = require('./src/timers/handler');
const ai = require('./src/ai/handler');

// Cliente de Twitch con reconexión nativa (evita duplicar timers)
const client = new tmi.Client({
  options: { debug: process.env.NODE_ENV !== 'production' },
  connection: { reconnect: true }, // tmi.js gestiona la reconexión automáticamente
  identity: {
    username: process.env.BOT_USERNAME,
    password: process.env.BOT_TOKEN
  },
  channels: [process.env.CHANNEL]
});

// Conexión
client.connect().catch(console.error);

// Los timers solo se inician una vez en la primera conexión
let timersStarted = false;

client.on('connected', (addr, port) => {
  console.log(`✅ Bot conectado a #${process.env.CHANNEL}`);
  if (!timersStarted) {
    timers.start(client, config);
    timersStarted = true;
  }
});

client.on('disconnected', (reason) => {
  console.log(`⚠️ Bot desconectado: ${reason || 'sin motivo'} — reconectando automáticamente...`);
});

// Escuchar mensajes del chat
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  alerts.handleMessage(client, channel, tags);

  const msg = message.trim();
  const isMod = tags.mod || tags['user-type'] === 'mod';
  const isBroadcaster = tags.badges?.broadcaster === '1';

  // Detector de hype
  ai.detectHype(client, channel, tags, msg, config);

  // Comprobar respuestas de trivia
  games.checkTriviaAnswer(client, channel, tags, msg);

  // Si no empieza por ! no es un comando
  if (!msg.startsWith(process.env.PREFIX)) return;

  const args = msg.slice(1).split(' ');
  const command = args[0].toLowerCase();
  const username = tags['display-name'];

  console.log(`💬 [${username}] !${command}`);

  // Comandos de juegos
  if (['ruleta', 'trivia', 'moneda'].includes(command)) {
    return games.handle(client, channel, tags, command, args);
  }

  // Comandos de IA
  if (command === 'pregunta') {
    return ai.handleQuestion(client, channel, tags, args);
  }

  // Comandos de personalidad
  if (['cita', 'chiste', 'consejo', 'meme'].includes(command)) {
    return ai.handlePersonality(client, channel, tags, command);
  }

  // Comandos generales
  commands.handle(client, channel, tags, command, args, config, isMod || isBroadcaster);
});

// Alertas de subs y raids
client.on('subscription', (channel, username, method, message, tags) => {
  alerts.onSub(client, channel, username);
});

client.on('raided', (channel, username, viewers) => {
  alerts.onRaid(client, channel, username, viewers);
});
