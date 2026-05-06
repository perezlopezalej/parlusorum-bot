require('dotenv').config();
const tmi = require('tmi.js');
const http = require('http');
const config = require('./config/commands.json');
const channelConfig = require('./config/channel.json');
const logger = require('./src/utils/logger');

const commands = require('./src/commands/handler');
const games = require('./src/games/handler');
const alerts = require('./src/alerts/handler');
const timers = require('./src/timers/handler');
const ai = require('./src/ai/handler');
const { getStreamInfo, getRecentGames } = require('./src/twitch/api');
const { trackMessage, updatePeakViewers } = require('./src/utils/metrics');
const { votePrediction } = require('./src/games/prediccion');

// --- Health check ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else { res.writeHead(404); res.end(); }
}).listen(PORT, () => logger.info(`🌐 Health check en http://localhost:${PORT}/health`));

async function validateBroadcasterToken() {
  const token = (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { 'Authorization': `OAuth ${token}` } });
    const data = await res.json();
    if (data.status === 401) { logger.warn('⚠️ BROADCASTER_TOKEN caducado. Regenera el token.'); }
    else { logger.info(`✅ Token broadcaster válido. Expira en ${Math.floor(data.expires_in / 86400)} días.`); }
  } catch (e) { logger.error(`No se pudo validar el token: ${e.message}`); }
}

const client = new tmi.Client({
  options: { debug: process.env.NODE_ENV !== 'production' },
  connection: { reconnect: true },
  identity: { username: process.env.BOT_USERNAME, password: process.env.BOT_TOKEN },
  channels: [process.env.CHANNEL]
});

client.connect().catch(console.error);

let timersStarted = false;
let lastMessageTime = Date.now();

const WATCHDOG_TIMEOUT = parseInt(process.env.WATCHDOG_TIMEOUT_MS || '1800000', 10);
setInterval(async () => {
  const info = await getStreamInfo().catch(() => null);
  if (!info?.live) return;
  if (Date.now() - lastMessageTime > WATCHDOG_TIMEOUT) {
    logger.warn('⚠️ Watchdog: reconectando...');
    client.connect().catch(logger.error);
    lastMessageTime = Date.now();
  }
}, 5 * 60 * 1000);

client.on('connected', async (addr, port) => {
  logger.info(`✅ Bot conectado a #${process.env.CHANNEL}`);

  if (!timersStarted) {
    timers.start(client, config);
    timersStarted = true;
    await validateBroadcasterToken();

    const broadcasterId = channelConfig.broadcaster_id;
    if (broadcasterId) {
      try {
        await alerts.initFollowerTracking(client, `#${process.env.CHANNEL}`, broadcasterId);
        setInterval(() => alerts.checkFollowerMilestones(client, `#${process.env.CHANNEL}`), 5 * 60 * 1000);
        logger.info(`✅ Seguimiento de seguidores iniciado`);
      } catch (err) { logger.error(`Error seguidores: ${err.message}`); }
    }

    setInterval(async () => {
      const info = await getStreamInfo().catch(() => null);
      if (info?.viewers) updatePeakViewers(info.viewers);
    }, 60 * 1000);

    setInterval(() => ai.checkChatHook(client, `#${process.env.CHANNEL}`), 60 * 1000);
  }
});

client.on('disconnected', (reason) => logger.warn(`⚠️ Desconectado: ${reason || 'sin motivo'}`));

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  lastMessageTime = Date.now();
  trackMessage();

  const msg = message.trim();
  const username = tags['display-name'];

  ai.addToHistory(username, msg);
  ai.updateLastChatTime();
  alerts.handleMessage(client, channel, tags);

  if (!msg.startsWith(process.env.PREFIX)) {
    ai.handleCohost(client, channel);
  }

  games.checkTriviaAnswer(client, channel, tags, msg);

  if (!msg.startsWith(process.env.PREFIX)) return;

  const args = msg.slice(1).split(' ');
  const command = args[0].toLowerCase();

  logger.debug(`💬 [${username}] !${command}`);

  // !votar si/no — solo aquí, sin duplicar
  if (command === 'votar') {
    const vote = args[1]?.toLowerCase();
    if (vote === 'si' || vote === 'no') votePrediction(client, channel, tags, vote);
    return;
  }

  if (['trivia', 'moneda'].includes(command)) return games.handle(client, channel, tags, command, args);
  if (command === 'dios_fua') return ai.handleQuestion(client, channel, tags, args);
  if (command === 'chiste') return ai.handleChiste(client, channel, tags);
  if (['cita', 'consejo', 'meme'].includes(command)) return ai.handlePersonality(client, channel, tags, command);

  // handle() es async ahora
  await commands.handle(client, channel, tags, command, args, config);
});

client.on('subscription', (channel, username, method, message, tags) => alerts.onSub(client, channel, username));
client.on('cheer', (channel, userstate, message) => {
  const username = userstate['display-name'];
  const bits = parseInt(userstate.bits, 10);
  if (username && bits > 0) alerts.onBits(client, channel, username, bits);
});
client.on('raided', (channel, username, viewers) => alerts.onRaid(client, channel, username, viewers));
