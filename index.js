require('dotenv').config();
const tmi = require('tmi.js');
const http = require('http');
const config = require('./config/commands.json');
const channelConfig = require('./config/channel.json');
const logger = require('./src/utils/logger');

// --- Validar variables de entorno obligatorias ---
const REQUIRED_ENV = ['BOT_USERNAME', 'BOT_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'CHANNEL', 'GROQ_API_KEY', 'BROADCASTER_TOKEN'];
const missing = REQUIRED_ENV.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`❌ Variables de entorno faltantes: ${missing.join(', ')}`);
  process.exit(1);
}

const { createEventSubHandler, registerSubscriptions, initStreamState } = require('./src/eventsub');
const commands = require('./src/commands/handler');
const { resetSessionCounters } = commands;
const games = require('./src/games/handler');
const alerts = require('./src/alerts/handler');
const timers = require('./src/timers/handler');
const ai = require('./src/ai/handler');
const { getStreamInfo, getCurrentGame } = require('./src/twitch/api');
const { trackMessage, updatePeakViewers, getSummary } = require('./src/utils/metrics');
const { startStreamSession } = require('./src/utils/supabase');
const memory = require('./src/memory/handler');
const { wrapClientSay } = require('./src/utils/irc-ratelimit');

const PORT = process.env.PORT || 3000;
const CHANNEL = `#${process.env.CHANNEL}`;
const BOT_NAME = (process.env.BOT_USERNAME || '').toLowerCase();

let eventSubHandler = null;

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  if (req.url === '/eventsub' && req.method === 'POST') {
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk);
    req.on('end', () => {
      if (eventSubHandler) eventSubHandler(req, res, rawBody);
      else { res.writeHead(503); res.end(); }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => logger.info(`🌐 Servidor HTTP en puerto ${PORT}`));

// --- Validar token broadcaster ---
async function validateBroadcasterToken() {
  const token = (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { 'Authorization': `OAuth ${token}` } });
    const data = await res.json();
    if (data.status === 401) logger.warn('⚠️ BROADCASTER_TOKEN caducado. Regenera el token.');
    else logger.info(`✅ Token broadcaster válido. Expira en ${Math.floor(data.expires_in / 86400)} días.`);
  } catch (e) { logger.error(`No se pudo validar el token: ${e.message}`); }
}

// --- Cliente Twitch ---
const client = new tmi.Client({
  options: { debug: process.env.NODE_ENV !== 'production' },
  connection: { reconnect: true, secure: true, port: 443 },
  identity: { username: process.env.BOT_USERNAME, password: process.env.BOT_TOKEN },
  channels: [process.env.CHANNEL]
});

wrapClientSay(client);
client.connect().catch(err => logger.error(`IRC connect error: ${err.message || err}`));

let timersStarted = false;
let lastMessageTime = Date.now();

// BUG FIX #1: deduplicación de mensajes para evitar doble respuesta en reconexiones
const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 60 * 1000);

// --- Watchdog ---
const WATCHDOG_TIMEOUT = parseInt(process.env.WATCHDOG_TIMEOUT_MS || '1800000', 10);
setInterval(async () => {
  const { isLiveViaEventSub } = require('./src/eventsub');
  if (!isLiveViaEventSub()) return;
  if (Date.now() - lastMessageTime > WATCHDOG_TIMEOUT) {
    logger.warn('⚠️ Watchdog: reconectando...');
    client.connect().catch(logger.error);
    lastMessageTime = Date.now();
  }
}, 5 * 60 * 1000);

client.on('connected', async (addr, port) => {
  logger.info(`✅ Bot conectado a #${process.env.CHANNEL}`);
  eventSubHandler = createEventSubHandler(client, CHANNEL, {
    getCurrentGame,
    startStreamSession,
    invalidateMemoryCache: memory.invalidateMemoryCache,
    onWarmupMode: ai.onWarmupMode,
    postStreamEnd: ai.postStreamEnd,
    getSummary,
    onStreamEnd: memory.onStreamEnd,
    getDeathCount: commands.getDeathCount,
    resetSessionCounters,
    getRecentHistory: ai.getRecentHistory,
    getActiveUsers: ai.getActiveUsers,
    resetActiveUsers: ai.resetActiveUsers,
    onStreamOnline: alerts.onStreamOnline
  });

  if (!timersStarted) {
    timers.start(client, config);
    timersStarted = true;

    await validateBroadcasterToken();

    // Migración automática npoint → Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      const { migrateFromNpoint } = require('./src/utils/supabase');
      await migrateFromNpoint().catch(e => logger.warn(`Migración: ${e.message}`));
    }

    await initStreamState();
    await ai.initStreamStatus();

    const broadcasterId = channelConfig.broadcaster_id;
    if (broadcasterId) {
      try {
        await alerts.initFollowerTracking(client, CHANNEL, broadcasterId);
        setInterval(() => alerts.checkFollowerMilestones(client, CHANNEL), 5 * 60 * 1000);
        logger.info(`✅ Seguimiento de seguidores iniciado`);
        await registerSubscriptions(broadcasterId);
      } catch (err) { logger.error(`Error init: ${err.message}`); }
    }

    const { setTriviaActive } = require('./src/utils/state');
    setTriviaActive(false);

    setInterval(async () => {
      const info = await getStreamInfo().catch(() => null);
      if (info?.viewers) updatePeakViewers(info.viewers);
      await ai.checkStreamStatus(client, CHANNEL);
    }, 60 * 1000);

    setInterval(() => ai.checkChatHook(client, CHANNEL), 60 * 1000);
  }
});

client.on('disconnected', (reason) => {
  logger.warn(`⚠️ Desconectado: ${reason || 'sin motivo'}`);
  const { setTriviaActive } = require('./src/utils/state');
  setTriviaActive(false);
});

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if (tags['username']?.toLowerCase() === BOT_NAME) return;
  if (tags['display-name']?.toLowerCase() === BOT_NAME) return;
  // Fix doble respuesta: el bot a veces recibe sus propios mensajes sin self=true
  if ((tags['username'] || '').toLowerCase().includes(BOT_NAME)) return;

  // BUG FIX #1: ignorar mensajes ya procesados (evita doble respuesta en reconexiones)
  const msgId = tags['id'];
  if (msgId) {
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
  }

  lastMessageTime = Date.now();
  trackMessage();

  const msg = message.trim();
  const username = tags['display-name'];

  try {
    ai.addToHistory(username, msg);
    ai.updateLastChatTime();
    alerts.handleMessage(client, channel, tags).catch(err =>
      logger.warn(`alerts.handleMessage error: ${err.message}`)
    );

    const PREFIX = process.env.PREFIX || '!';
    if (!msg.startsWith(PREFIX)) {
      ai.checkForHighlight(client, channel, msg).catch(err =>
        logger.warn(`checkForHighlight error: ${err.message}`)
      );
      const patternHandled = await ai.checkPatternMatch(client, channel, tags, msg);
      if (!patternHandled) {
        ai.handleCohost(client, channel).catch(err =>
          logger.warn(`handleCohost error: ${err.message}`)
        );
      }
      ai.checkEmoteSpam(client, channel, tags, msg).catch(err =>
        logger.warn(`checkEmoteSpam error: ${err.message}`)
      );
      ai.checkCapsRage(client, channel, tags, msg).catch(err =>
        logger.warn(`checkCapsRage error: ${err.message}`)
      );
    }

    games.checkTriviaAnswer(client, channel, tags, msg);

    if (!msg.startsWith(PREFIX)) return;

    const args = msg.slice(PREFIX.length).split(' ');
    const command = args[0].toLowerCase();

    logger.debug(`💬 [${username}] !${command}`);

    if (['trivia', 'moneda'].includes(command)) return games.handle(client, channel, tags, command, args);
    if (command === 'dios_fua') return ai.handleQuestion(client, channel, tags, args);
    if (command === 'chiste') return ai.handleChiste(client, channel, tags);

    await commands.handle(client, channel, tags, command, args, config);
  } catch (err) {
    logger.error(`Message handler error [${username}]: ${err.message}`);
  }
});

client.on('subscription', (channel, username) => alerts.onSub(client, channel, username));
client.on('cheer', (channel, userstate) => {
  const username = userstate['display-name'];
  const bits = parseInt(userstate.bits, 10);
  if (username && bits > 0) alerts.onBits(client, channel, username, bits);
});
client.on('raided', (channel, username, viewers) => alerts.onRaid(client, channel, username, viewers));

process.on('unhandledRejection', (reason) => {
  if (reason?.message === 'Not connected to server.') {
    logger.warn('IRC: mensaje descartado por reconexión en curso');
    return;
  }
  logger.error(`UnhandledRejection: ${reason}`);
});