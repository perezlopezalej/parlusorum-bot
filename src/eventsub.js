const crypto = require('crypto');
const logger = require('./utils/logger');
const channelConfig = require('../config/channel.json');
const { groqWithRetry, truncate, GROQ_MODEL_FAST } = require('./utils/groq-utils');
const { restoreOpenSession, restoreSessionNarrative, saveSessionNarrative } = require('./utils/supabase');
const { throttleSay } = require('./alerts/handler');
const {
  setStreamStartedAt, getStreamStartedAt,
  setStreamIsLive, getStreamIsLive, isSilenced,
  setSessionStarting, getSessionStarting, clearSessionStarting,
  getDeathCount, setDeathCount,
  resetStreamNarrative, setStreamNarrative, getStreamNarrative, onNarrativeChange, resetBotHistory, resetReinforceCounter, clearProphecy,
  getActivePrediction, setActivePrediction, clearActivePrediction,
  getGroqFallbackUse, resetGroqFallbackUse,
} = require('./utils/state');

// La narrativa de la sesión se persiste en Supabase en cada cambio (escritura diferida)
onNarrativeChange(saveSessionNarrative);

const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const MESSAGE_TYPE = 'twitch-eventsub-message-type';
const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';

// EVENTSUB_SECRET es obligatorio — validado en index.js (process.exit si falta)
const EVENTSUB_SECRET = process.env.EVENTSUB_SECRET;

// Deduplicación de notificaciones — Twitch puede reenviar el mismo evento
const MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;
const processedEventIds = new Map(); // message-id → expiresAt

setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of processedEventIds) if (exp < now) processedEventIds.delete(id);
}, 60 * 1000).unref();

function getStreamUptime() {
  const streamStartedAt = getStreamStartedAt();
  if (!streamStartedAt) return null;
  const mins = Math.floor((Date.now() - streamStartedAt) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function isLiveViaEventSub() { return getStreamIsLive(); }

// URL pública del servicio. En Render, RENDER_EXTERNAL_URL se inyecta sola;
// PUBLIC_URL solo hace falta con dominio propio o en local con ngrok.
function getPublicBaseUrl() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
}

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
      setStreamIsLive(true);
      setStreamStartedAt(stream.started_at ? new Date(stream.started_at).getTime() : Date.now());
      logger.info(`📺 Stream en directo al arrancar (uptime: ${getStreamUptime()})`);
      const deaths = await restoreOpenSession(getStreamStartedAt());
      if (deaths) { setDeathCount(deaths); logger.info(`💀 Muertes recuperadas: ${deaths}`); }
      if (deaths !== null) {
        setStreamNarrative(await restoreSessionNarrative());
        logger.info(`📖 Narrativa recuperada: ${getStreamNarrative().length} eventos`);
      }
    } else {
      setStreamIsLive(false);
      setStreamStartedAt(null);
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

// Borra (con paginación) toda suscripción que no esté "enabled" (p. ej. webhook_callback_verification_failed)
// y las "enabled" de los tipos que gestionamos, para recrearlas sin acumular duplicados.
async function deleteStaleSubscriptions(headers, managedTypes) {
  let cursor = null;
  let deleted = 0;
  do {
    const url = 'https://api.twitch.tv/helix/eventsub/subscriptions' + (cursor ? `?after=${encodeURIComponent(cursor)}` : '');
    const res = await fetch(url, { headers });
    const data = await res.json();
    const stale = (data.data || []).filter(s => s.status !== 'enabled' || managedTypes.has(s.type));
    for (const sub of stale) {
      const del = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, { method: 'DELETE', headers });
      if (del.ok) deleted++;
      else logger.warn(`⚠️ EventSub: no se pudo borrar ${sub.type} (${sub.status}): HTTP ${del.status}`);
    }
    cursor = data.pagination?.cursor || null;
  } while (cursor);
  logger.info(`🧹 EventSub: ${deleted} suscripciones antiguas/fallidas borradas`);
}

// --- Registrar suscripciones EventSub ---
async function registerSubscriptions(broadcasterId) {
  if (!EVENTSUB_SECRET) {
    logger.warn('⚠️ EventSub: EVENTSUB_SECRET no configurado — suscripciones no registradas.');
    return false;
  }
  const publicBase = getPublicBaseUrl();
  if (!publicBase) {
    logger.warn('⚠️ EventSub: ni PUBLIC_URL ni RENDER_EXTERNAL_URL configuradas.');
    return false;
  }
  const callbackUrl = `${publicBase}/eventsub`;
  logger.info(`🔗 EventSub callback: ${callbackUrl}`);

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

  const broadcasterAuthTypes = [
    'channel.hype_train.begin', 'channel.hype_train.progress', 'channel.hype_train.end',
    'channel.prediction.begin', 'channel.prediction.lock', 'channel.prediction.end',
    'channel.poll.begin', 'channel.poll.end',
    'channel.channel_points_custom_reward_redemption.add',
  ];
  const managedTypes = new Set([...subscriptions.map(s => s.type), ...broadcasterAuthTypes]);

  try {
    await deleteStaleSubscriptions(headers, managedTypes);

    for (const sub of subscriptions) {
      const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST', headers,
        body: JSON.stringify({ ...sub, transport: { method: 'webhook', callback: callbackUrl, secret: EVENTSUB_SECRET } })
      });
      const data = await res.json();
      if (data.data?.[0]?.status === 'webhook_callback_verification_pending') {
        logger.info(`✅ EventSub: ${sub.type} registrado.`);
      } else {
        logger.warn(`⚠️ EventSub ${sub.type}: HTTP ${res.status} ${data.message || data.error || ''}`.trim());
      }
    }
  } catch (e) {
    logger.error(`EventSub error: ${e.message}`);
    return false;
  }

  // Subs por webhook que requieren que el broadcaster haya autorizado la app (BROADCASTER_SCOPES), pero se crean con el app access token:
  // channel:read:hype_train, channel:read:predictions, channel:read:polls, channel:read:redemptions
  const broadcasterAuthSubs = [
    { type: 'channel.hype_train.begin',    version: '2', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.hype_train.progress', version: '2', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.hype_train.end',      version: '2', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.prediction.begin',    version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.prediction.lock',     version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.prediction.end',      version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.poll.begin',          version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.poll.end',            version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: broadcasterId } },
  ];

  try {
    for (const sub of broadcasterAuthSubs) {
      const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST', headers: headers,
        body: JSON.stringify({ ...sub, transport: { method: 'webhook', callback: callbackUrl, secret: EVENTSUB_SECRET } })
      });
      const data = await res.json();
      if (data.data?.[0]?.status === 'webhook_callback_verification_pending') {
        logger.info(`✅ EventSub: ${sub.type} registrado.`);
      } else {
        logger.warn(`⚠️ EventSub ${sub.type}: HTTP ${res.status} ${data.message || data.error || ''}`.trim());
      }
    }
    return true;
  } catch (e) {
    logger.error(`EventSub user-token subs error: ${e.message}`);
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
    onProphecy,
    postStreamEnd,
    getSummary,
    onStreamEnd,
    getStreamChatBuffer,
    resetStreamChatBuffer,
    getActiveUsers,
    resetActiveUsers,
    onStreamOnline,
    resetSessionCounters,
    clearUserFactsCache,
    handleQuestion
  } = deps;

  return async function handleEventSub(req, res, rawBody) {
    const messageType = req.headers[MESSAGE_TYPE];

    if (!verifySignature(req, rawBody)) {
      const missing = [TWITCH_MESSAGE_ID, TWITCH_MESSAGE_TIMESTAMP, TWITCH_MESSAGE_SIGNATURE].filter(h => !req.headers[h]);
      const reason = missing.length ? `faltan cabeceras (${missing.length})` : 'HMAC no coincide';
      logger.warn(`⚠️ EventSub: firma inválida → 403 [tipo=${messageType || '?'}, ${reason}]`);
      res.writeHead(403); res.end(); return;
    }

    const sentAt = Date.parse(req.headers[TWITCH_MESSAGE_TIMESTAMP]);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MESSAGE_MAX_AGE_MS) {
      logger.warn(`⚠️ EventSub: timestamp fuera de ventana (>10 min) → 403 [tipo=${messageType || '?'}]`);
      res.writeHead(403); res.end(); return;
    }

    let body;
    try { body = JSON.parse(rawBody); } catch {
      logger.warn(`⚠️ EventSub: JSON inválido → 400 [tipo=${messageType || '?'}]`);
      res.writeHead(400); res.end(); return;
    }

    if (messageType === MESSAGE_TYPE_VERIFICATION) {
      logger.info(`✅ EventSub: challenge respondido → 200 (${body.subscription?.type})`);
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
        if (processedEventIds.has(eventMsgId)) {
          logger.info(`ℹ️ EventSub: notificación duplicada ignorada → 204 (${body.subscription?.type})`);
          return;
        }
        processedEventIds.set(eventMsgId, Date.now() + MESSAGE_MAX_AGE_MS);
      }

      const type = body.subscription?.type;
      const event = body.event;
      logger.info(`📨 EventSub: notificación aceptada → 204 (${type})`);

      if (type === 'channel.follow' && event?.user_name) {
        logger.info(`👤 Nuevo seguidor: ${event.user_name}`);
        const msg = followMessages[Math.floor(Math.random() * followMessages.length)].replace('{username}', event.user_name);
        if (!isSilenced()) client.say(channel, msg);
      }

      if (type === 'stream.online') {
        // Cambios de estado en memoria: síncronos e inmediatos
        setStreamIsLive(true);
        setStreamStartedAt(event?.started_at ? new Date(event.started_at).getTime() : Date.now());
        logger.info(`🔴 Stream online via EventSub`);
        try { onStreamOnline(); } catch {}
        try { resetSessionCounters(); } catch {}
        try { resetStreamChatBuffer(); } catch {}
        try { resetStreamNarrative(); } catch {}
        try { clearProphecy(); } catch {}
        try { resetBotHistory(); } catch {}
        try { resetReinforceCounter(); } catch {}
        try { clearUserFactsCache(); } catch {}
        // I/O asíncrono en background — no bloquea la respuesta a Twitch
        setImmediate(async () => {
          setSessionStarting((async () => {
            try {
              const gameInfo = await getCurrentGame().catch(() => null);
              await startStreamSession(gameInfo?.game || null);
              invalidateMemoryCache();

              // Warmup mode: una sola consulta a los 60s — activa si < 5 viewers
              const warmupGame = gameInfo?.game || null;
              setTimeout(async () => {
                try {
                  if (!isLiveViaEventSub()) return;
                  const startedAt = getStreamStartedAt();
                  if (startedAt && Date.now() - startedAt > 10 * 60 * 1000) return;
                  if (client.readyState() !== 'OPEN') return;
                  const viewers = await getViewersWithAppToken(channelConfig.broadcaster_id);
                  if (viewers !== null && viewers < 5) {
                    await onWarmupMode(client, channel, warmupGame);
                  }
                } catch (e) { logger.warn(`Warmup check: ${e.message}`); }
              }, 60 * 1000);

              // Profecía de muertes: tras el warmup (60s), a los 90s
              setTimeout(async () => {
                try {
                  if (!isLiveViaEventSub() || client.readyState() !== 'OPEN') return;
                  await onProphecy(client, channel, warmupGame);
                } catch (e) { logger.warn(`Profecía: ${e.message}`); }
              }, 90 * 1000);
            } catch (e) { logger.warn(`Supabase session start: ${e.message}`); }
          })());
          await getSessionStarting().finally(() => { clearSessionStarting(); });
        });
      }

      if (type === 'stream.offline') {
        // Cambios de estado en memoria: síncronos e inmediatos
        setStreamIsLive(false);
        const endedAt = Date.now();
        const streamStartedAt = getStreamStartedAt();
        const durationMinutes = streamStartedAt
          ? Math.floor((endedAt - streamStartedAt) / 60000)
          : 0;
        setStreamStartedAt(null);
        logger.info(`⚫ Stream offline via EventSub`);
        // I/O asíncrono en background — no bloquea la respuesta a Twitch
        setImmediate(async () => {
          const pending = getSessionStarting();
          if (pending) await pending.catch(() => {});
          // Resumen de modelos de reserva solo en el log (no en el chat)
          const fallbackUse = getGroqFallbackUse();
          resetGroqFallbackUse();
          const fallbackLines = Object.entries(fallbackUse).map(([k, n]) => `${k}: ${n}`).join(', ');
          logger.info(`📊 Fin de stream — modelos de reserva de Groq: ${fallbackLines || 'ninguno usado'}`);
          try {
            const gameInfo = await getCurrentGame().catch(() => null);
            const metrics = getSummary();
            const chatSample = typeof getStreamChatBuffer === 'function' ? getStreamChatBuffer() : '';
            const activeUsers = getActiveUsers();
            resetActiveUsers();
            const memory = await onStreamEnd({
              game: gameInfo?.game || null,
              durationMinutes,
              deathCount: getDeathCount(),
              peakViewers: metrics.peakViewers || 0,
              totalMessages: metrics.totalMessages || 0,
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

      if (type === 'channel.hype_train.begin') {
        const { level = 1, is_golden_kappa_train = false } = event || {};
        const goldenNote = is_golden_kappa_train ? ' ¡¡Es un GOLDEN KAPPA TRAIN!! 🏆' : '';
        logger.info(`🚂 Hype Train begin: nivel ${level}${is_golden_kappa_train ? ' (golden kappa)' : ''}`);
        if (!isSilenced()) client.say(channel, `🚂 ¡HYPE TRAIN nivel ${level} ha comenzado!${goldenNote} ¡Contribuye con bits o subs! FUA 🔥`);
      }

      if (type === 'channel.hype_train.progress') {
        const { level = '?', total = '?' } = event || {};
        logger.info(`🚂 Hype Train progreso: nivel ${level}, total ${total}`);
      }

      if (type === 'channel.hype_train.end') {
        const { level = 1, is_golden_kappa_train = false, winner_count = null } = event || {};
        const winners = winner_count ? ` ¡${winner_count} ganadores!` : '';
        const golden = is_golden_kappa_train ? ' 🏆 ¡GOLDEN KAPPA!' : '';
        logger.info(`🏁 Hype Train end: nivel ${level}${is_golden_kappa_train ? ' (golden kappa)' : ''}`);
        if (!isSilenced()) client.say(channel, `🏁 ¡Hype Train terminado en nivel ${level}!${winners} ¡Gracias por el hype!${golden} 💜`);
      }

      const { getBotPersonality } = require('./ai/handler'); // lazy: circular dep eventsub↔ai

      if (type === 'channel.prediction.begin') {
        const { title, outcomes } = event || {};
        const opcionesTexto = (outcomes || []).map((o, i) => `${i+1}) ${o.title}`).join(' | ');
        setActivePrediction({ title, outcomes });
        logger.info(`🔮 Predicción comenzada: "${title}"`);
        try {
          const response = await groqWithRetry({
            model: GROQ_MODEL_FAST,
            max_tokens: 120,
            messages: [
              { role: 'system', content: `${getBotPersonality()} Narra con energía de comentarista deportivo. Máx 400 caracteres. Sin presentarte.` },
              { role: 'user', content: `El streamer ha abierto una predicción: '${title}'. Opciones: ${opcionesTexto}. Narra esto en 1-2 frases.` }
            ]
          });
          throttleSay(client, channel, truncate(response.choices[0].message.content));
        } catch {
          throttleSay(client, channel, truncate(`🔮 ¡PREDICCIÓN! "${title}" — ${opcionesTexto} — ¡Apuesta tus puntos! 🎯`));
        }
      }

      if (type === 'channel.prediction.lock') {
        const pred = getActivePrediction();
        const titulo = pred?.title || 'la predicción';
        logger.info(`🔒 Predicción cerrada: "${titulo}"`);
        throttleSay(client, channel, truncate(`🔒 ¡Predicción cerrada! Ya no se pueden hacer apuestas en "${titulo}". ¡A esperar el resultado! 👀`));
      }

      if (type === 'channel.prediction.end') {
        const { winning_outcome_id, outcomes, title } = event || {};
        clearActivePrediction();
        const ganadorPred = (outcomes || []).find(o => o.id === winning_outcome_id);
        if (ganadorPred) {
          const totalPuntos = ganadorPred.channel_points || 0;
          const numGanadores = ganadorPred.top_predictors?.length ?? 0;
          logger.info(`🏆 Predicción terminada: ganó "${ganadorPred.title}"`);
          try {
            const response = await groqWithRetry({
              model: GROQ_MODEL_FAST,
              max_tokens: 120,
              messages: [
                { role: 'system', content: `${getBotPersonality()} Anuncia resultados con dramatismo. Máx 400 caracteres. Sin presentarte.` },
                { role: 'user', content: `La predicción '${title}' terminó. Ganó: '${ganadorPred.title}' con ${numGanadores} acertantes y ${totalPuntos} puntos en juego. Anuncia el resultado en 1-2 frases.` }
              ]
            });
            throttleSay(client, channel, truncate(response.choices[0].message.content));
          } catch {
            throttleSay(client, channel, truncate(`🏆 ¡Ganó "${ganadorPred.title}"! ${numGanadores > 0 ? `¡${numGanadores} acertaron!` : ''} 🎉`));
          }
        }
      }

      if (type === 'channel.poll.begin') {
        const { title, choices } = event || {};
        const opcionesTexto = (choices || []).map((c, i) => `${i+1}) ${c.title}`).join(' | ');
        logger.info(`📊 Poll comenzado: "${title}"`);
        try {
          const response = await groqWithRetry({
            model: GROQ_MODEL_FAST,
            max_tokens: 120,
            messages: [
              { role: 'system', content: `${getBotPersonality()} Comenta encuestas con energía. Máx 400 caracteres. Sin presentarte.` },
              { role: 'user', content: `El streamer ha abierto una encuesta: '${title}'. Opciones: ${opcionesTexto}. Comenta esto en 1-2 frases.` }
            ]
          });
          throttleSay(client, channel, truncate(response.choices[0].message.content));
        } catch {
          throttleSay(client, channel, truncate(`📊 ¡ENCUESTA! "${title}" — ${opcionesTexto} — ¡Vota en el chat!`));
        }
      }

      if (type === 'channel.poll.end') {
        const { title, choices } = event || {};
        if (choices && choices.length > 0) {
          const ganadorPoll = choices.reduce((a, b) => (b.votes > a.votes ? b : a));
          const totalVotos = choices.reduce((sum, c) => sum + c.votes, 0);
          const pct = totalVotos > 0 ? Math.round((ganadorPoll.votes / totalVotos) * 100) : 0;
          const esAjustado = pct < 40;
          logger.info(`📊 Poll terminado: ganó "${ganadorPoll.title}" con ${pct}%`);
          try {
            const response = await groqWithRetry({
              model: GROQ_MODEL_FAST,
              max_tokens: 120,
              messages: [
                { role: 'system', content: `${getBotPersonality()} Anuncia resultados de encuestas con energía. Máx 400 caracteres. Sin presentarte.` },
                { role: 'user', content: `La encuesta '${title}' terminó. Ganó '${ganadorPoll.title}' con ${pct}% de ${totalVotos} votos.${esAjustado ? ' ¡Fue muy reñido!' : ''} Anuncia el resultado en 1-2 frases.` }
              ]
            });
            throttleSay(client, channel, truncate(response.choices[0].message.content));
          } catch {
            throttleSay(client, channel, truncate(`📊 Encuesta terminada: ganó "${ganadorPoll.title}" con ${pct}% de los votos${esAjustado ? ' (¡muy reñido!)' : ''}`));
          }
        }
      }

      if (type === 'channel.channel_points_custom_reward_redemption.add') {
        try {
          const { user_name, reward, user_input } = event || {};
          const rewardTitle = reward?.title?.toLowerCase() || '';
          const esPreguntaAlBot = ['bot', 'pregunta', 'dios'].some(kw => rewardTitle.includes(kw));
          logger.info(`🎁 Canje: ${user_name} → "${reward?.title}"`);
          if (esPreguntaAlBot && user_input?.trim() && handleQuestion) {
            const fakeTags = { 'display-name': user_name, 'user-id': user_name, username: user_name };
            await handleQuestion(client, channel, fakeTags, ['!dios_fua', ...user_input.trim().split(' ')]);
          } else {
            const response = await groqWithRetry({
              model: GROQ_MODEL_FAST,
              max_tokens: 60,
              messages: [
                { role: 'system', content: `${getBotPersonality()} Agradece con humor y energía. Máx 200 caracteres. Sin presentarte.` },
                { role: 'user', content: `El usuario ${user_name} canjeó la recompensa '${reward?.title}'. Agradécelo en 1 frase.` }
              ]
            });
            throttleSay(client, channel, truncate(response.choices[0].message.content));
          }
        } catch {
          const { user_name, reward } = event || {};
          throttleSay(client, channel, truncate(`🎁 ¡@${user_name} canjeó "${reward?.title}"! ¡Gracias! 💜`));
        }
      }

      return;
    }

    if (messageType === MESSAGE_TYPE_REVOCATION) {
      logger.warn(`⚠️ EventSub revocado → 204 (${body.subscription?.type}, motivo=${body.subscription?.status || '?'})`);
    } else {
      logger.warn(`⚠️ EventSub: tipo de mensaje desconocido → 204 [tipo=${messageType || '?'}]`);
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
  getAppAccessToken,
  getPublicBaseUrl
};
