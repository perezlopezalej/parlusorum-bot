require('dotenv').config();
const tmi = require('tmi.js');
const config = require('./config/commands.json');
const channelConfig = require('./config/channel.json');

const commands = require('./src/commands/handler');
const games = require('./src/games/handler');
const alerts = require('./src/alerts/handler');
const timers = require('./src/timers/handler');
const ai = require('./src/ai/handler');

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

    const broadcasterId = channelConfig.broadcaster_id;
    if (broadcasterId) {
      try {
        await alerts.initFollowerTracking(client, `#${process.env.CHANNEL}`, broadcasterId);
        setInterval(() => {
          alerts.checkFollowerMilestones(client, `#${process.env.CHANNEL}`);
        }, 5 * 60 * 1000);
        console.log(`✅ Seguimiento de seguidores iniciado para ${channelConfig.streamer}`);
      } catch (err) {
        console.error('⚠️ No se pudo iniciar el seguimiento de seguidores:', err.message);
      }
    }
  }
});

client.on('disconnected', (reason) => {
  console.log(`⚠️ Bot desconectado: ${reason || 'sin motivo'} — reconectando...`);
});

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const msg = message.trim();
  const username = tags['display-name'];
  const isMod = tags.mod || tags['user-type'] === 'mod';
  const isBroadcaster = tags.badges?.broadcaster === '1';

  ai.addToHistory(username, msg);
  alerts.handleMessage(client, channel, tags);
  ai.detectHype(client, channel, tags, msg, config);

  // Co-host solo en mensajes no comandos
  if (!msg.startsWith(process.env.PREFIX)) {
    ai.handleCohost(client, channel);
  }

  games.checkTriviaAnswer(client, channel, tags, msg);

  if (!msg.startsWith(process.env.PREFIX)) return;

  const args = msg.slice(1).split(' ');
  const command = args[0].toLowerCase();

  console.log(`💬 [${username}] !${command}`);

  if (['ruleta', 'trivia', 'moneda'].includes(command)) {
    return games.handle(client, channel, tags, command, args);
  }

  if (command === 'pregunta') return ai.handleQuestion(client, channel, tags, args);
  if (command === 'lurk') return ai.handleLurk(client, channel, tags);
  if (command === 'chiste') return ai.handleChiste(client, channel, tags);

  if (['cita', 'consejo', 'meme'].includes(command)) {
    return ai.handlePersonality(client, channel, tags, command);
  }

  commands.handle(client, channel, tags, command, args, config, isMod || isBroadcaster);
});

client.on('subscription', (channel, username, method, message, tags) => {
  alerts.onSub(client, channel, username);
});

client.on('raided', (channel, username, viewers) => {
  alerts.onRaid(client, channel, username, viewers);
});
