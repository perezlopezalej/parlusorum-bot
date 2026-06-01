const crypto = require('crypto');
const logger = require('./utils/logger');
const channelConfig = require('../config/channel.json');

const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const MESSAGE_TYPE = 'twitch-eventsub-message-type';
const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';

// EVENTSUB_SECRET es obligatorio — validado en index.js (process.exit si falta)
const EVENTSUB_SECRET = process.env.EVENTSUB_SECRET;

// --- Estado del stream via EventSub ---
let streamStartedAt = null;
let streamIsLive = false;
// Serializa startStreamSession y onStreamEnd para evitar carrera online/offline
let _sessionStarting = null;

// Deduplicación de notificaciones — Twitch puede reenviar el mismo evento
const processedEventIds = new Set();

function getStreamUptime() {
  if (!streamStartedAt) return null;
  const mins = Math.floor((Date.now() - streamStartedAt) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function isLiveViaEventSub() { return streamIsLive; }

// --- App Access Token con cache ---
let appTokenCache = null;
let appTokenExpiry = 0;

async function getAppAccessToken() {
  const now = Date.now();
  if (appTokenCache && now < appTokenExpiry) return appTokenCache;

  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    });
    const data = await res.json();
    if (data.access_token) {
      appTokenCache = data.access_token;
      // Cacha 23 horas (token dura 60 días, renovamos mucho antes)
      appTokenExpiry = now + 23 * 60 * 60 * 1000;
      logger.info('✅ App Access Token generado y cacheado');
    }
    return appTokenCache || null;
  } catch (e) {
    logger.error(`Error obteniendo app token: ${e.message}`);
    return null;
  }
}

// --- Inicializar estado del stream al arrancar ---
async function initStreamState() {
  try {
    const appToken = await getAppAccessToken();
    if (!appToken) return;

    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_id=${channelConfig.broadcaster_id}`,
      {
        headers: {
          'Client-ID': process.env.CLIENT_ID,
          'Authorization': `Bearer ${appToken}`
        }
      }
    );
    const data = await res.json();
    const stream = data.data?.[0];

    if (stream) {
      streamIsLive = true;
      streamStartedAt = stream.started_at ? new Date(stream.started_at).getTime() : Date.now();
      logger.info(`📺 Stream en directo al arrancar (uptime: ${getStreamUptime()})`);
    } else {
      streamIsLive = false;
      streamStartedAt = null;
      logger.info(`📺 Canal offline al arrancar`);
    }
  } catch (e) {
    logger.error(`Error inicializando estado del stream: ${e.message}`);
  }
}

// --- Verificar firma ---
function verifySignature(req, body) {
  if (!EVENTSUB_SECRET) return false;
  const messageId = req.headers[TWITCH_MESSAGE_ID];
  const timestamp = req.headers[TWITCH_MESSAGE_TIMESTAMP];
  const signature = req.headers[TWITCH_MESSAGE_SIGNATURE];
  if (!messageId || !timestamp || !signature) return false;
  const hmac = 'sha256=' + crypto.createHmac('sha256', EVENTSUB_SECRET)
    .update(messageId + timestamp + body)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch { return false; }
}

// --- Mensajes variados de nuevos seguidores ---
const followMessages = [
  '🎉 ¡@{username} acaba de seguir el canal! ¡Bienvenid@ a la familia! ¡FUA! 💜',
  '💜 ¡Nuevo seguidor! ¡@{username} se une a ParLusorum! ¡Gracias! 🔥',
  '🔔 ¡@{username} ha dado follow! ¡El FUA te da la bienvenida! 💪',
  '⭐ ¡@{username} se une al canal! ¡Gracias por el follow! 💜🎉',
  '🚀 ¡@{username} acaba de seguirnos! ¡Bienvenid@ al caos! ¡FUA! 🔥',
];

// --- Registrar suscripciones EventSub ---
async function registerSubscriptions(broadcasterId) {
  if (!EVENTSUB_SECRET) {
    logger.warn('⚠️ EventSub: EVENTSUB_SECRET no configurado — suscripciones no registradas.');
    return false;
  }
  const callbackUrl = `${process.env.PUBLIC_URL}/eventsub`;
  if (!callbackUrl || callbackUrl.startsWith('undefined')) {
    logger.warn('⚠️ EventSub: PUBLIC_URL no configurada.');
    return false;
  }

  const appToken = await getAppAccessToken();
  if (!appToken) { logger.warn('⚠️ EventSub: no se pudo obtener app token.'); return false; }

  const headers = {
    'Client-ID': process.env.CLIENT_ID,
    'Authorization': `Bearer ${appToken}`,
    'Content-Type': 'application/json'
  };

  const subscriptions = [
    { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
    { type: 'stream.online', version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: broadcasterId } }
  ];

  try {
    const listRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', { headers });
    const listData = await listRes.json();
    const oldSubs = listData.data?.filter(s => subscriptions.some(sub => sub.type === s.type)) || [];
    for (const sub of oldSubs) {
      await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, { method: 'DELETE', headers });
    }

    for (const sub of subscriptions) {
      const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST', headers,
        body: JSON.stringify({ ...sub, transport: { method: 'webhook', callback: callbackUrl, secret: EVENTSUB_SECRET } })
      });
      const data = await res.json();
      if (data.data?.[0]?.status === 'webhook_callback_verification_pending') {
        logger.info(`✅ EventSub: ${sub.type} registrado.`);
      } else {
        logger.warn(`⚠️ EventSub ${sub.type}: ${JSON.stringify(data.message || data.error || data)}`);
      }
    }
    return true;
  } catch (e) {
    logger.error(`EventSub error: ${e.message}`);
    return false;
  }
}

// --- Viewers via app token ---
async function getViewersWithAppToken(broadcasterId) {
  try {
    const appToken = await getAppAccessToken();
    if (!appToken) return null;
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`, {
      headers: { 'Client-ID': process.env.CLIENT_ID, 'Authorization': `Bearer ${appToken}` }
    });
    const data = await res.json();
    return data.data?.[0]?.viewer_count ?? null;
  } catch { return null; }
}

// --- Handler del webhook ---
// deps evita dependencias circulares: estas funciones se pasan desde index.js donde ya están cargadas
function createEventSubHandler(client, channel, deps) {
  const {
    getCurrentGame,
    startStreamSession,
    invalidateMemoryCache,
    onWarmupMode,
    postStreamEnd,
    getSummary,
    onStreamEnd,
    getDeathCount,
    getRecentHistory,
    getActiveUsers,
    resetActiveUsers,
    onStreamOnline,
    resetSessionCounters
  } = deps;

  return async function handleEventSub(req, res, rawBody) {
    const messageType = req.headers[MESSAGE_TYPE];

    if (!verifySignature(req, rawBody)) {
      logger.warn('⚠️ EventSub: firma inválida');
      res.writeHead(403); res.end(); return;
    }

    let body;
    try { body = JSON.parse(rawBody); } catch { res.writeHead(400); res.end(); return; }

    if (messageType === MESSAGE_TYPE_VERIFICATION) {
      logger.info(`✅ EventSub: webhook verificado (${body.subscription?.type})`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body.challenge); return;
    }

    if (messageType === MESSAGE_TYPE_NOTIFICATION) {
      // Responder a Twitch antes de procesar: Twitch exige 2xx en <10s o reintenta con backoff.
      // Trade-off: si el setImmediate falla silenciosamente, Twitch no reenviará la notificación.
      res.writeHead(204); res.end();

      // Deduplicar por message ID — Twitch puede reenviar la misma notificación
      const eventMsgId = req.headers[TWITCH_MESSAGE_ID];
      if (eventMsgId) {
        if (processedEventIds.has(eventMsgId)) return;
        processedEventIds.add(eventMsgId);
        if (processedEventIds.size > 200) {
          processedEventIds.delete(processedEventIds.keys().next().value);
        }
      }

      const type = body.subscription?.type;
      const event = body.event;

      if (type === 'channel.follow' && event?.user_name) {
        logger.info(`👤 Nuevo seguidor: ${event.user_name}`);
        const msg = followMessages[Math.floor(Math.random() * followMessages.length)].replace('{username}', event.user_name);
        client.say(channel, msg);
      }

      if (type === 'stream.online') {
        // Cambios de estado en memoria: síncronos e inmediatos
        streamIsLive = true;
        streamStartedAt = event?.started_at ? new Date(event.started_at).getTime() : Date.now();
        logger.info(`🔴 Stream online via EventSub`);
        try { onStreamOnline(); } catch {}
        try { resetSessionCounters(); } catch {}
        // I/O asíncrono en background — no bloquea la respuesta a Twitch
        setImmediate(async () => {
          _sessionStarting = (async () => {
            try {
              const gameInfo = await getCurrentGame().catch(() => null);
              await startStreamSession(gameInfo?.game || null);
              invalidateMemoryCache();

              // Warmup mode: una sola consulta a los 60s — activa si < 5 viewers
              const warmupGame = gameInfo?.game || null;
              setTimeout(async () => {
                try {
                  if (!isLiveViaEventSub()) return;
                  if (streamStartedAt && Date.now() - streamStartedAt > 10 * 60 * 1000) return;
                  if (client.readyState() !== 'OPEN') return;
                  const viewers = await getViewersWithAppToken(channelConfig.broadcaster_id);
                  if (viewers !== null && viewers < 5) {
                    await onWarmupMode(client, channel, warmupGame);
                  }
                } catch (e) { logger.warn(`Warmup check: ${e.message}`); }
              }, 60 * 1000);
            } catch (e) { logger.warn(`Supabase session start: ${e.message}`); }
          })();
          await _sessionStarting.finally(() => { _sessionStarting = null; });
        });
      }

      if (type === 'stream.offline') {
        // Cambios de estado en memoria: síncronos e inmediatos
        streamIsLive = false;
        const endedAt = Date.now();
        const durationMinutes = streamStartedAt
          ? Math.floor((endedAt - streamStartedAt) / 60000)
          : 0;
        streamStartedAt = null;
        logger.info(`⚫ Stream offline via EventSub`);
        // I/O asíncrono en background — no bloquea la respuesta a Twitch
        setImmediate(async () => {
          if (_sessionStarting) await _sessionStarting.catch(() => {});
          try {
            const gameInfo = await getCurrentGame().catch(() => null);
            const metrics = getSummary();
            const chatSample = typeof getRecentHistory === 'function' ? getRecentHistory(10) : '';
            const activeUsers = getActiveUsers();
            resetActiveUsers();
            const memory = await onStreamEnd({
              game: gameInfo?.game || null,
              durationMinutes,
              deathCount: getDeathCount(),
              peakViewers: metrics.peakViewers || 0,
              totalMessages: metrics.messagesLastHour || 0,
              topCommands: Object.fromEntries(
                (metrics.topCommands || '')
                  .split(' ')
                  .filter(Boolean)
                  .map(s => {
                    const m = s.match(/!(\w+)\((\d+)\)/);
                    return m ? [m[1], parseInt(m[2])] : null;
                  })
                  .filter(Boolean)
              ),
              activeUsers: activeUsers
            }, chatSample);
            postStreamEnd(client, channel, memory?.summary || null);
          } catch (e) {
            logger.warn(`Supabase session end: ${e.message}`);
            try {
              postStreamEnd(client, channel, null);
            } catch (e2) {
              logger.warn(`postStreamEnd fallback failed: ${e2.message}`);
            }
          }
        });
      }

      return;
    }

    if (messageType === MESSAGE_TYPE_REVOCATION) {
      logger.warn(`⚠️ EventSub revocado: ${body.subscription?.type}`);
    }

    res.writeHead(204); res.end();
  };
}

module.exports = {
  createEventSubHandler,
  registerSubscriptions,
  initStreamState,
  isLiveViaEventSub,
  getStreamUptime,
  getViewersWithAppToken,
  getAppAccessToken
};
