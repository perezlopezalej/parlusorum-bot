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

const EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'parlusorum-bot-secret-2026';

// --- Estado del stream en tiempo real (via EventSub) ---
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

// --- Verificar firma ---
function verifySignature(req, body) {
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

// --- Mensajes de bienvenida a nuevos seguidores ---
const followMessages = [
  '🎉 ¡@{username} acaba de seguir el canal! ¡Bienvenid@ a la familia! ¡FUA! 💜',
  '💜 ¡Nuevo seguidor! ¡@{username} se une a ParLusorum! ¡Gracias! 🔥',
  '🔔 ¡@{username} ha dado follow! ¡El FUA te da la bienvenida! 💪',
  '⭐ ¡@{username} se une al canal! ¡Gracias por el follow! 💜🎉',
  '🚀 ¡@{username} acaba de seguirnos! ¡Bienvenid@ al caos! ¡FUA! 🔥',
];

function getFollowMessage(username) {
  return followMessages[Math.floor(Math.random() * followMessages.length)].replace('{username}', username);
}

// --- Obtener App Access Token ---
async function getAppAccessToken() {
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
    return data.access_token || null;
  } catch (e) {
    logger.error(`Error obteniendo app token: ${e.message}`);
    return null;
  }
}

// --- Registrar suscripciones EventSub ---
async function registerSubscriptions(broadcasterId) {
  const callbackUrl = `${process.env.PUBLIC_URL}/eventsub`;

  if (!callbackUrl || callbackUrl.startsWith('undefined')) {
    logger.warn('⚠️ EventSub: PUBLIC_URL no configurada.');
    return false;
  }

  const appToken = await getAppAccessToken();
  if (!appToken) {
    logger.warn('⚠️ EventSub: no se pudo obtener app token.');
    return false;
  }

  const headers = {
    'Client-ID': process.env.CLIENT_ID,
    'Authorization': `Bearer ${appToken}`,
    'Content-Type': 'application/json'
  };

  // Tipos de suscripción a registrar
  const subscriptions = [
    {
      type: 'channel.follow',
      version: '2',
      condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId }
    },
    {
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId }
    },
    {
      type: 'stream.offline',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId }
    }
  ];

  try {
    // Limpiar suscripciones antiguas
    const listRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', { headers });
    const listData = await listRes.json();
    const oldSubs = listData.data?.filter(s =>
      subscriptions.some(sub => sub.type === s.type)
    ) || [];

    for (const sub of oldSubs) {
      await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, {
        method: 'DELETE', headers
      });
    }

    // Registrar nuevas suscripciones
    let success = 0;
    for (const sub of subscriptions) {
      const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...sub,
          transport: {
            method: 'webhook',
            callback: callbackUrl,
            secret: EVENTSUB_SECRET
          }
        })
      });
      const data = await res.json();
      if (data.data?.[0]?.status === 'webhook_callback_verification_pending') {
        logger.info(`✅ EventSub: ${sub.type} registrado.`);
        success++;
      } else {
        logger.warn(`⚠️ EventSub ${sub.type}: ${JSON.stringify(data.message || data)}`);
      }
    }

    return success > 0;
  } catch (e) {
    logger.error(`EventSub error: ${e.message}`);
    return false;
  }
}

// --- Intentar obtener viewers con app token ---
async function getViewersWithAppToken(broadcasterId) {
  try {
    const appToken = await getAppAccessToken();
    if (!appToken) return null;
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`,
      {
        headers: {
          'Client-ID': process.env.CLIENT_ID,
          'Authorization': `Bearer ${appToken}`
        }
      }
    );
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
      res.writeHead(403);
      res.end();
      return;
    }

    let body;
    try { body = JSON.parse(rawBody); }
    catch { res.writeHead(400); res.end(); return; }

    if (messageType === MESSAGE_TYPE_VERIFICATION) {
      logger.info(`✅ EventSub: webhook verificado (${body.subscription?.type})`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body.challenge);
      return;
    }

    if (messageType === MESSAGE_TYPE_NOTIFICATION) {
      const type = body.subscription?.type;
      const event = body.event;

      if (type === 'channel.follow' && event?.user_name) {
        logger.info(`👤 Nuevo seguidor: ${event.user_name}`);
        client.say(channel, getFollowMessage(event.user_name));
      }

      if (type === 'stream.online') {
        streamIsLive = true;
        streamStartedAt = event?.started_at ? new Date(event.started_at).getTime() : Date.now();
        logger.info(`🔴 Stream en directo detectado via EventSub`);
      }

      if (type === 'stream.offline') {
        streamIsLive = false;
        streamStartedAt = null;
        logger.info(`⚫ Stream offline detectado via EventSub`);
      }

      res.writeHead(204);
      res.end();
      return;
    }

    if (messageType === MESSAGE_TYPE_REVOCATION) {
      logger.warn(`⚠️ EventSub revocado: ${body.subscription?.type}`);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(204);
    res.end();
  };
}

module.exports = {
  createEventSubHandler,
  registerSubscriptions,
  getStreamUptime,
  isLiveViaEventSub,
  getViewersWithAppToken
};
