require('dotenv').config();
const tmi = require('tmi.js');
const http = require('http');
const config = require('./config/commands.json');
const channelConfig = require('./config/channel.json');
const logger = require('./src/utils/logger');

// --- Validar variables de entorno obligatorias ---
const REQUIRED_ENV = ['BOT_USERNAME', 'BOT_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'CHANNEL', 'GROQ_API_KEY', 'BROADCASTER_TOKEN', 'EVENTSUB_SECRET'];
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
const { getStreamInfo, getCurrentGame, loadBroadcasterTokens, ensureBotToken, refreshBotToken, refreshBotTokenIfNeeded } = require('./src/twitch/api');
const { trackMessage, updatePeakViewers, getSummary } = require('./src/utils/metrics');
const { startStreamSession } = require('./src/utils/supabase');
const memory = require('./src/memory/handler');
const { wrapClientSay } = require('./src/utils/irc-ratelimit');
const { checkNewUser } = require('./src/moderation/bot-detector');
const chatlog = require('./src/utils/chatlog');
const { runWithOrigin, withOrigin } = chatlog;
const { handleAuthStart, handleAuthCallback } = require('./src/auth');

const PORT = process.env.PORT || 3000;
const CHANNEL = `#${process.env.CHANNEL}`;
const BOT_NAME = (process.env.BOT_USERNAME || '').toLowerCase();

let eventSubHandler = null;

// Estado de la conexión al chat (GET /status solo expone si está conectado)
const chatStatus = { connected: false, lastError: null, lastErrorAt: null, lastConnectedAt: null, retryAttempts: 0 };

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  if (req.url === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ chat: chatStatus.connected ? 'connected' : 'disconnected' }));
    return;
  }
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath === '/auth/broadcaster' && req.method === 'GET') { handleAuthStart(req, res); return; }
  if (urlPath === '/auth/callback' && req.method === 'GET') { handleAuthCallback(req, res); return; }
  if (req.url === '/eventsub' && req.method === 'POST') {
    let rawBody = '';
    let bodyOverflow = false;
    res.on('error', () => {});
    req.on('data', chunk => {
      rawBody += chunk;
      if (rawBody.length > 65536) { bodyOverflow = true; req.destroy(); }
    });
    req.on('end', () => {
      if (bodyOverflow) {
        logger.warn('⚠️ EventSub: cuerpo demasiado grande (413)');
        if (!res.headersSent && !res.writableEnded) { res.writeHead(413); res.end(); }
        return;
      }
      if (eventSubHandler) runWithOrigin('alerta', () => eventSubHandler(req, res, rawBody));
      else {
        logger.warn('⚠️ EventSub: handler no listo (503)');
        res.writeHead(503); res.end();
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => logger.info(`🌐 Servidor HTTP en puerto ${PORT}`));

// Self-ping to keep Render free tier alive
const SELF_PING_URL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
if (SELF_PING_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_PING_URL}/health`);
      if (!res.ok) logger.warn(`Self-ping failed: HTTP ${res.status}`);
    } catch (e) {
      logger.warn(`Self-ping error: ${e.message}`);
    }
  }, 10 * 60 * 1000);
}

// --- Validar token broadcaster ---
async function validateBroadcasterToken() {
  const token = (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { 'Authorization': `OAuth ${token}` } });
    const data = await res.json();
    if (data.status === 401) logger.warn('⚠️ BROADCASTER_TOKEN caducado. Regenera el token.');
    else {
      const hours = Math.floor(data.expires_in / 3600);
      const days = Math.floor(hours / 24);
      const timeMsg = hours < 48 ? `${hours} horas` : `${days} días`;
      logger.info(`✅ Token broadcaster válido. Expira en ${timeMsg}.`);
    }
  } catch (e) { logger.error(`No se pudo validar el token: ${e.message}`); }
}

// --- Cliente Twitch ---
// password como función: cada intento de conexión usa el BOT_TOKEN vigente (refrescado o no)
const client = new tmi.Client({
  options: { debug: false },
  connection: { reconnect: true, secure: true, port: 443 },
  identity: { username: process.env.BOT_USERNAME, password: () => `oauth:${(process.env.BOT_TOKEN || '').replace(/^oauth:/, '')}` },
  channels: [process.env.CHANNEL]
});

wrapClientSay(client);

const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 10 * 60 * 1000;
let chatConnecting = false;

// Conecta al chat; ante fallo de login refresca el token del bot y reintenta con backoff.
async function connectChat() {
  if (chatConnecting) return;
  chatConnecting = true;
  let delay = RETRY_MIN_MS;
  try {
    while (!chatStatus.connected) {
      try {
        // tmi.js no protege connect(): un segundo socket dejaría el primero huérfano
        const state = client.readyState();
        if (state === 'OPEN' || state === 'CONNECTING') return;
        await client.connect();
        return;
      } catch (err) {
        const msg = String(err?.message || err);
        chatStatus.lastError = msg;
        chatStatus.lastErrorAt = new Date().toISOString();
        chatStatus.retryAttempts++;
        const isAuth = /login|auth/i.test(msg);
        logger.error(`🔴 Fallo al conectar al chat de Twitch: "${msg}"${isAuth ? ' (token del bot rechazado)' : ''}. Reintento en ${Math.round(delay / 1000)}s.`);
        if (isAuth) await refreshBotToken();
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, RETRY_MAX_MS);
        client.reconnect = true; // tmi lo desactiva tras un fallo de login
      }
    }
  } finally {
    chatConnecting = false;
  }
}

// El handler de EventSub no depende de la conexión al chat: si se creara en 'connected',
// Twitch recibiría 503 en la verificación del webhook mientras el login IRC falla o reintenta.
eventSubHandler = createEventSubHandler(client, CHANNEL, {
  getCurrentGame,
  startStreamSession,
  invalidateMemoryCache: memory.invalidateMemoryCache,
  onWarmupMode: ai.onWarmupMode,
  onProphecy: ai.onProphecy,
  postStreamEnd: ai.postStreamEnd,
  getSummary,
  onStreamEnd: memory.onStreamEnd,
  resetSessionCounters,
  getStreamChatBuffer: ai.getStreamChatBuffer,
  resetStreamChatBuffer: ai.resetStreamChatBuffer,
  getActiveUsers: ai.getActiveUsersWithMinMessages,
  resetActiveUsers: ai.resetActiveUsers,
  onStreamOnline: alerts.onStreamOnline,
  clearUserFactsCache: ai.clearUserFactsCache,
  handleQuestion: ai.handleQuestion
});

(async () => {
  const ok = await ensureBotToken();
  if (!ok) logger.warn('⚠️ No se pudo garantizar un BOT_TOKEN válido; se intentará conectar igualmente.');
  await connectChat();
})();

// Renovación preventiva del token del bot (cada hora)
setInterval(() => {
  refreshBotTokenIfNeeded().catch(e => logger.warn(`Renovación BOT_TOKEN: ${e.message}`));
}, 60 * 60 * 1000);

let timersStarted = false;

// BUG FIX #1: deduplicación de mensajes para evitar doble respuesta en reconexiones
const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 60 * 1000);

// --- Watchdog ---
// Solo actúa si el estado real de la conexión es "caída" (en directo o no); un chat callado no cuenta.
setInterval(() => {
  if (chatStatus.connected) return;
  logger.warn('⚠️ Watchdog: chat desconectado, reconectando...');
  connectChat();
}, 5 * 60 * 1000);

client.on('connected', async (addr, port) => {
  chatStatus.connected = true;
  chatStatus.lastConnectedAt = new Date().toISOString();
  chatStatus.retryAttempts = 0;
  logger.info(`✅ Bot conectado a #${process.env.CHANNEL}`);
  if (!timersStarted) {
    timers.start(client, config);
    chatlog.start();
    timersStarted = true;

    await loadBroadcasterTokens();
    await validateBroadcasterToken();

    // Migración automática npoint → Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      const { migrateFromNpoint, loadActiveCooldowns } = require('./src/utils/supabase');
      await migrateFromNpoint().catch(e => logger.warn(`Migración: ${e.message}`));
      loadActiveCooldowns().then(cd => {
        ai.restoreCooldowns(cd);
        commands.restoreCooldowns(cd);
      }).catch(e => logger.warn(`Cooldowns no restaurados: ${e.message}`));
    }

    await initStreamState();
    await ai.initStreamStatus();
    ai.startEventCohost(client, CHANNEL);

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
      await runWithOrigin('alerta', () => ai.checkStreamStatus(client, CHANNEL));
    }, 60 * 1000);

    setInterval(withOrigin('hook', () => ai.checkChatHook(client, CHANNEL)), 60 * 1000);
  }
});

client.on('disconnected', (reason) => {
  logger.warn(`⚠️ Desconectado: ${reason || 'sin motivo'}`);
  chatStatus.connected = false;
  if (reason) { chatStatus.lastError = String(reason); chatStatus.lastErrorAt = new Date().toISOString(); }
  // Si tmi dejó de reconectar por fallo de login, retomamos nosotros con refresh + backoff
  if (/login|auth/i.test(String(reason || ''))) connectChat();
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

  checkNewUser(tags);
  trackMessage();

  const msg = message.trim();
  const username = tags['display-name'];
  chatlog.logUserMessage(username, msg);

  try {
    ai.addToHistory(username, msg);
    ai.updateLastChatTime();
    runWithOrigin('alerta', () => alerts.handleMessage(client, channel, tags)).catch(err =>
      logger.warn(`alerts.handleMessage error: ${err.message}`)
    );

    const PREFIX = process.env.PREFIX || '!';
    if (!msg.startsWith(PREFIX)) {
      runWithOrigin('highlight', () => ai.checkForHighlight(client, channel, msg, tags['user-id'] || username)).catch(err =>
        logger.warn(`checkForHighlight error: ${err.message}`)
      );
      await runWithOrigin('mencion', () => ai.checkPatternMatch(client, channel, tags, msg)); // el cohost libre va por reloj (ai.startEventCohost)
      runWithOrigin('emote_spam', () => ai.checkEmoteSpam(client, channel, tags, msg)).catch(err =>
        logger.warn(`checkEmoteSpam error: ${err.message}`)
      );
      runWithOrigin('caps_rage', () => ai.checkCapsRage(client, channel, tags, msg)).catch(err =>
        logger.warn(`checkCapsRage error: ${err.message}`)
      );
    }

    runWithOrigin('trivia', () => games.checkTriviaAnswer(client, channel, tags, msg));

    if (!msg.startsWith(PREFIX)) return;

    const args = msg.slice(PREFIX.length).split(' ');
    const command = args[0].toLowerCase();

    logger.debug(`💬 [${username}] !${command}`);

    if (command === 'trivia' || command === 'top') return runWithOrigin('trivia', () => games.handle(client, channel, tags, command, args));
    if (command === 'dios_fua') return runWithOrigin('dios_fua', () => ai.handleQuestion(client, channel, tags, args));
    if (command === 'chiste') return runWithOrigin('chiste', () => ai.handleChiste(client, channel, tags));
    if (command === 'quemeperdi') return runWithOrigin('quemeperdi', () => ai.handleQueMePerdi(client, channel, tags));

    await runWithOrigin('comando', () => commands.handle(client, channel, tags, command, args, config));
  } catch (err) {
    logger.error(`Message handler error [${username}]: ${err.message}`);
  }
});

const subSafe = (fn) => (...a) => Promise.resolve(runWithOrigin('alerta', () => fn(...a))).catch(err => logger.error(`Alerta de sub: ${err.message}`));
// Meses acumulados: msg-param-cumulative-months en los tags (streakMonths puede ser 0 sin racha compartida)
client.on('subscription', subSafe((channel, username, methods, msg) => alerts.onSub(client, channel, username, methods, msg)));
client.on('resub', subSafe((channel, username, streak, msg, tags, methods) =>
  alerts.onResub(client, channel, username, parseInt(tags?.['msg-param-cumulative-months'], 10) || streak || 1, methods, msg)));
client.on('subgift', subSafe((channel, username, streak, recipient, methods, tags) => alerts.onSubGift(client, channel, username, recipient, methods, tags)));
client.on('anonsubgift', subSafe((channel, streak, recipient, methods, tags) => alerts.onSubGift(client, channel, null, recipient, methods, tags)));
client.on('submysterygift', subSafe((channel, username, count, methods, tags) => alerts.onMysteryGift(client, channel, username, count, methods, tags)));
client.on('anonsubmysterygift', subSafe((channel, count, methods, tags) => alerts.onMysteryGift(client, channel, null, count, methods, tags)));
client.on('giftpaidupgrade', subSafe((channel, username, sender) => alerts.onGiftUpgrade(client, channel, username, sender)));
client.on('anongiftpaidupgrade', subSafe((channel, username) => alerts.onGiftUpgrade(client, channel, username, null)));
client.on('cheer', (channel, userstate) => {
  const username = userstate['display-name'];
  const bits = parseInt(userstate.bits, 10);
  if (username && bits > 0) runWithOrigin('alerta', () => alerts.onBits(client, channel, username, bits));
});
client.on('raided', (channel, username, viewers) => runWithOrigin('alerta', () => alerts.onRaid(client, channel, username, viewers)));

process.on('unhandledRejection', (reason) => {
  if (reason?.message === 'Not connected to server.') {
    logger.warn('IRC: mensaje descartado por reconexión en curso');
    return;
  }
  logger.error(`UnhandledRejection: ${reason}`);
});