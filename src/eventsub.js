const crypto = require('crypto');
const logger = require('./utils/logger');
const channelConfig = require('../config/channel.json');

const TWITCH_MESSAGE_ID = 'Twitch-Eventsub-Message-Id';
const TWITCH_MESSAGE_TIMESTAMP = 'Twitch-Eventsub-Message-Timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'Twitch-Eventsub-Message-Signature';
const MESSAGE_TYPE = 'Twitch-Eventsub-Message-Type';
const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';

const EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'parlusorum-bot-secret-2026';

// --- Verificar firma de Twitch ---
function verifySignature(req, body) {
  const messageId = req.headers[TWITCH_MESSAGE_ID.toLowerCase()];
  const timestamp = req.headers[TWITCH_MESSAGE_TIMESTAMP.toLowerCase()];
  const signature = req.headers[TWITCH_MESSAGE_SIGNATURE.toLowerCase()];
  if (!messageId || !timestamp || !signature) return false;

  const hmacMessage = messageId + timestamp + body;
  const hmac = 'sha256=' + crypto.createHmac('sha256', EVENTSUB_SECRET)
    .update(hmacMessage)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
}

// --- Mensajes variados de bienvenida a nuevos seguidores ---
const followMessages = [
  '🎉 ¡@{username} acaba de seguir el canal! ¡Bienvenid@ a la familia! ¡FUA! 💜',
  '💜 ¡Nuevo seguidor! ¡@{username} se une a ParLusorum! ¡Gracias! 🔥',
  '🔔 ¡@{username} ha dado follow! ¡El FUA te da la bienvenida! 💪',
  '⭐ ¡@{username} se une al canal! ¡Gracias por el follow! 💜🎉',
  '🚀 ¡@{username} acaba de seguirnos! ¡Bienvenid@ al caos! ¡FUA! 🔥',
];

function getFollowMessage(username) {
  const msg = followMessages[Math.floor(Math.random() * followMessages.length)];
  return msg.replace('{username}', username);
}

// --- Registrar suscripción EventSub ---
async function registerFollowSubscription(broadcasterId) {
  const token = (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
  const callbackUrl = `${process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL}/eventsub`;

  if (!callbackUrl || callbackUrl.startsWith('undefined')) {
    logger.warn('⚠️ EventSub: PUBLIC_URL no configurada, no se puede registrar el webhook.');
    return false;
  }

  try {
    // Eliminar suscripciones antiguas primero
    const listRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      headers: {
        'Client-ID': process.env.CLIENT_ID,
        'Authorization': `Bearer ${token}`
      }
    });
    const listData = await listRes.json();
    const oldSubs = listData.data?.filter(s =>
      s.type === 'channel.follow' &&
      s.condition?.broadcaster_user_id === broadcasterId
    ) || [];

    for (const sub of oldSubs) {
      await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, {
        method: 'DELETE',
        headers: {
          'Client-ID': process.env.CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      });
    }

    // Registrar nueva suscripción
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-ID': process.env.CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'channel.follow',
        version: '2',
        condition: {
          broadcaster_user_id: broadcasterId,
          moderator_user_id: broadcasterId
        },
        transport: {
          method: 'webhook',
          callback: callbackUrl,
          secret: EVENTSUB_SECRET
        }
      })
    });

    const data = await res.json();
    if (data.data?.[0]?.status === 'webhook_callback_verification_pending') {
      logger.info('✅ EventSub: suscripción de follows registrada correctamente.');
      return true;
    } else {
      logger.warn(`⚠️ EventSub: respuesta inesperada — ${JSON.stringify(data)}`);
      return false;
    }
  } catch (e) {
    logger.error(`EventSub registro error: ${e.message}`);
    return false;
  }
}

// --- Handler del webhook ---
function createEventSubHandler(client, channel) {
  return function handleEventSub(req, res, rawBody) {
    const messageType = req.headers[MESSAGE_TYPE.toLowerCase()];

    if (!verifySignature(req, rawBody)) {
      logger.warn('⚠️ EventSub: firma inválida — petición rechazada');
      res.writeHead(403);
      res.end();
      return;
    }

    let body;
    try { body = JSON.parse(rawBody); }
    catch { res.writeHead(400); res.end(); return; }

    if (messageType === MESSAGE_TYPE_VERIFICATION) {
      // Twitch verifica el webhook
      logger.info('✅ EventSub: webhook verificado por Twitch');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body.challenge);
      return;
    }

    if (messageType === MESSAGE_TYPE_NOTIFICATION) {
      const event = body.event;
      if (body.subscription?.type === 'channel.follow' && event?.user_name) {
        const username = event.user_name;
        logger.info(`👤 Nuevo seguidor: ${username}`);
        client.say(channel, getFollowMessage(username));
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

module.exports = { createEventSubHandler, registerFollowSubscription };
