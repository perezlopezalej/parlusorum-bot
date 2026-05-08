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

// EVENTSUB_SECRET es obligatorio — sin fallback hardcodeado (seguridad)
const EVENTSUB_SECRET = process.env.EVENTSUB_SECRET;
if (!EVENTSUB_SECRET) {
  logger.warn('⚠️ EVENTSUB_SECRET no configurado. EventSub no verificará firmas correctamente.');
}

// --- Estado del stream via EventSub ---
let streamStartedAt = null;
let streamIsLive = false;

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
  if (!EVENTSUB_SECRET) return true; // Sin secreto configurado, aceptar todo (advertido al inicio)
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
        body: JSON.stringify({ ...sub, transport: { method: 'webhook', callback: callbackUrl, secret: EVENTSUB_SECRET || 'fallback' } })
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
function createEventSubHandler(client, channel) {
  return function handleEventSub(req, res, rawBody) {
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
      const type = body.subscription?.type;
      const event = body.event;

      if (type === 'channel.follow' && event?.user_name) {
        logger.info(`👤 Nuevo seguidor: ${event.user_name}`);
        const msg = followMessages[Math.floor(Math.random() * followMessages.length)].replace('{username}', event.user_name);
        client.say(channel, msg);
      }

      if (type === 'stream.online') {
        streamIsLive = true;
        streamStartedAt = event?.started_at ? new Date(event.started_at).getTime() : Date.now();
        logger.info(`🔴 Stream online via EventSub`);
        // FIX #2: notificar al handler de alertas para limpiar lurkerMap
        try { require('./alerts/handler').onStreamOnline(); } catch {}
      }

      if (type === 'stream.offline') {
        streamIsLive = false;
        streamStartedAt = null;
        logger.info(`⚫ Stream offline via EventSub`);
      }

      res.writeHead(204); res.end(); return;
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
