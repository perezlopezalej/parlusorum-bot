require('dotenv').config();
const tmi = require('tmi.js');
const config = require('./config/commands.json');
const { getBroadcasterInfo } = require('./src/twitch/api');

// Módulos
const commands = require('./src/commands/handler');
const games = require('./src/games/handler');
const alerts = require('./src/alerts/handler');
const timers = require('./src/timers/handler');
const ai = require('./src/ai/handler');

// Cliente de Twitch
const client = new tmi.Client({
  options: { debug: process.env.NODE_ENV !== 'production' },
  connection: { reconnect: true },
  identity: {
    username: process.env.BOT_USERNAME,
    password: process.env.BOT_TOKEN
  },
  channels: [process.env.CHANNEL]
});

client.connect().catch(console.error);

let timersStarted = false;

client.on('connected', async (addr, port) => {
  console.log(`✅ Bot conectado a #${process.env.CHANNEL}`);

  if (!timersStarted) {
    timers.start(client, config);
    timersStarted = true;

    // Inicializar seguimiento de seguidores con la API del broadcaster
    try {
      const info = await getBroadcasterInfo();
      if (info?.id) {
        await alerts.initFollowerTracking(client, `#${process.env.CHANNEL}`, info.id);
        // Comprobar hitos cada 5 minutos
        setInterval(() => {
          alerts.checkFollowerMilestones(client, `#${process.env.CHANNEL}`);
        }, 5 * 60 * 1000);
        console.log(`✅ Seguimiento de seguidores iniciado para ${info.display_name}`);
      }
    } catch (err) {
      console.error('⚠️ No se pudo iniciar el seguimiento de seguidores:', err.message);
    }
  }
});

client.on('disconnected', (reason) => {
  console.log(`⚠️ Bot desconectado: ${reason || 'sin motivo'} — reconectando...`);
});

// Escuchar mensajes del chat
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const msg = message.trim();
  const username = tags['display-name'];
  const isMod = tags.mod || tags['user-type'] === 'mod';
  const isBroadcaster = tags.badges?.broadcaster === '1';

  // Añadir al historial de chat
  ai.addToHistory(username, msg);

  // Alertas de usuario
  alerts.handleMessage(client, channel, tags);

  // Detector de hype
  ai.detectHype(client, channel, tags, msg, config);

  // Narrador (detecta momentos épicos, graciosos o dramáticos)
  ai.detectNarratorMoment(client, channel, msg);

  // Co-host espontáneo (baja probabilidad)
  if (!msg.startsWith(process.env.PREFIX)) {
    ai.handleCohost(client, channel);
  }

  // Comprobar respuestas de trivia
  games.checkTriviaAnswer(client, channel, tags, msg);

  // Si no empieza por ! no es un comando
  if (!msg.startsWith(process.env.PREFIX)) return;

  const args = msg.slice(1).split(' ');
  const command = args[0].toLowerCase();

  console.log(`💬 [${username}] !${command}`);

  // Comandos de juegos
  if (['ruleta', 'trivia', 'moneda'].includes(command)) {
    return games.handle(client, channel, tags, command, args);
  }

  // Comandos de IA
  if (command === 'pregunta') return ai.handleQuestion(client, channel, tags, args);
  if (command === 'lurk') return ai.handleLurk(client, channel, tags);
  if (command === 'resumen') return ai.handleResumen(client, channel, tags);

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
