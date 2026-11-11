const crypto = require('crypto');
const logger = require('./utils/logger');
const channelConfig = require('../config/channel.json');
const { truncate } = require('./utils/groq-utils');
const { template } = require('./utils/plantillas');
const { restoreOpenSession, restoreSessionBosses, restoreSessionNarrative, saveSessionNarrative, getCurrentSessionId } = require('./utils/supabase');
const chatlog = require('./utils/chatlog');
const { persistBotState } = require('./utils/bot-state');
const { throttleSay } = require('./alerts/handler');
const { getAppAccessToken } = require('./twitch/app-token');
const {
  setStreamStartedAt, getStreamStartedAt,
  setStreamIsLive, getStreamIsLive, getFilterStats, resetFilterStats, isSilenced, setSilenceMode, setMuteUntil, setBotMode, setBrbMode, setStreamEndGraceUntil,
  setSessionStarting, getSessionStarting, clearSessionStarting,
  getDeathCount, setDeathCount, setBossCount,
  resetStreamNarrative, setStreamNarrative, getStreamNarrative, onNarrativeChange, resetBotHistory,
  getActivePrediction, setActivePrediction, clearActivePrediction,
  getGroqFallbackUse, resetGroqFallbackUse, getGroqTokenUse, resetGroqTokenUse, getAiUsage, resetAiStreamUsage, getCohostStats, resetCohostStats, resetPlayer, resetFreeCohostPause,
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
const END_OF_STREAM_GRACE_MS = 15 * 60 * 1000; // margen para el resumen de fin de stream (memoria IA incluida)
const processedEventIds = new Map(); // message-id | tipo:event.id → expiresAt

const DEDUPE_BY_EVENT_ID = /^channel\.(poll|prediction)\./;

// true si ya se vio este evento (tipo + id); lo registra si es nuevo. Solo encuestas y predicciones.
function isRepeatedEvent(seen, type, eventId, now = Date.now(), ttl = 60 * 60 * 1000) {
  if (!type || !eventId || !DEDUPE_BY_EVENT_ID.test(type)) return false;
  const key = `${type}:${eventId}`;
  if (seen.has(key)) return true;
  seen.set(key, now + ttl);
  return false;
}

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

// Resumen del cohost para el log: intentados/enviados por tipo, motivos de descarte y 429 del proveedor
// Tokens de Groq por modelo: este stream y acumulado del día UTC frente al cupo diario de cada modelo
const GROQ_DAILY_TOKEN_LIMIT = parseInt(process.env.GROQ_DAILY_TOKEN_LIMIT || '200000', 10);
function formatTokenUse({ stream, day }, limit = GROQ_DAILY_TOKEN_LIMIT) {
  const models = [...new Set([...Object.keys(stream), ...Object.keys(day)])];
  if (!models.length) return 'tokens de Groq: sin llamadas';
  return 'tokens de Groq — ' + models.map(m => {
    const s = stream[m]?.total || 0;
    const d = day[m]?.total || 0;
    const pct = limit > 0 ? Math.round(d / limit * 100) : 0;
    return `${m}: ${s} este stream (${stream[m]?.calls || 0} llamadas), ${d} hoy (${pct}% de ${limit}, quedan ~${Math.max(0, limit - d)})`;
  }).join('; ');
}

// Peticiones por modelo: este stream y hoy (UTC)
function formatAiUsage(usage) {
  const keys = Object.keys(usage);
  if (!keys.length) return 'peticiones de IA: ninguna';
  return 'peticiones de IA — ' + keys.map(k => {
    const u = usage[k];
    return `${k}: ${u.stream.requests} este stream, ${u.day.requests} hoy`;
  }).join('; ');
}

// Tasa de descarte por filtro: descartados / (descartados + enviados) por origen, con los motivos más frecuentes
function formatFilterStats(stats) {
  const parts = Object.entries(stats || {}).map(([origin, s]) => {
    const total = s.discarded + s.sent;
    if (!total) return null;
    const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ');
    return `${origin} ${s.discarded}/${total} (${Math.round((100 * s.discarded) / total)} %)${reasons ? ` [${reasons}]` : ''}`;
  }).filter(Boolean);
  return `descarte por filtro: ${parts.join('; ') || 'sin mensajes'}`;
}

function formatCohostStats({ attempts, sent, discards, groq429 }) {
  const reasons = Object.entries(discards).map(([k, n]) => `${k}: ${n}`).join(', ') || 'ninguno';
  const total = attempts.event + attempts.free;
  return `cohost: ${total} comentarios intentados (${attempts.event} eventos, ${attempts.free} libres), ${sent.event + sent.free} enviados (${sent.event} eventos, ${sent.free} libres); SKIP del modelo: ${discards.skip || 0}; descartes: ${reasons}; 429 de Groq: ${groq429}`;
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
        const bosses = await restoreSessionBosses();
        if (bosses) { setBossCount(bosses); logger.info(`👹 Jefes recuperados: ${bosses}`); }
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

// Consulta puntual a Twitch: { live, startedAt } o null si la consulta falla (un fallo nunca equivale a "offline")
async function checkLiveNow() {
  try {
    const appToken = await getAppAccessToken();
    if (!appToken) return null;
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${channelConfig.broadcaster_id}`, {
      headers: { 'Client-ID': process.env.CLIENT_ID, 'Authorization': `Bearer ${appToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.data)) return null;
    const stream = data.data[0];
    return { live: !!stream, startedAt: stream?.started_at ? new Date(stream.started_at).getTime() : null };
  } catch { return null; }
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

// Suscripciones que gestiona el bot. `broadcasterAuth` necesitan que el broadcaster haya autorizado la app (BROADCASTER_SCOPES)
function subscriptionDefs(broadcasterId) {
  const cond = { broadcaster_user_id: broadcasterId };
  return {
    basic: [
      { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
      { type: 'stream.online', version: '1', condition: cond },
      { type: 'stream.offline', version: '1', condition: cond },
    ],
    broadcasterAuth: [
      { type: 'channel.hype_train.begin', version: '2', condition: cond },
      { type: 'channel.hype_train.progress', version: '2', condition: cond },
      { type: 'channel.hype_train.end', version: '2', condition: cond },
      { type: 'channel.prediction.begin', version: '1', condition: cond },
      { type: 'channel.prediction.lock', version: '1', condition: cond },
      { type: 'channel.prediction.end', version: '1', condition: cond },
      { type: 'channel.poll.begin', version: '1', condition: cond },
      { type: 'channel.poll.end', version: '1', condition: cond },
      { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: cond },
    ],
  };
}

// --- Revocaciones: volver a suscribir lo que Twitch revoca por motivos recuperables ---
// notification_failures_exceeded (el webhook falló demasiadas veces, p. ej. Render dormido) y version_removed.
// authorization_revoked / user_removed NO se reintentan: daría 403 hasta que el broadcaster repita /auth/broadcaster.
const RESUBSCRIBE_STATUSES = new Set(['notification_failures_exceeded', 'version_removed']);
const MAX_RESUBSCRIBE_PER_HOUR = 3;
const resubscribeLog = new Map(); // tipo → marcas de tiempo de los reintentos de la última hora

function shouldResubscribe(status, recentAttempts = 0) {
  return RESUBSCRIBE_STATUSES.has(status) && recentAttempts < MAX_RESUBSCRIBE_PER_HOUR;
}

async function handleRevocation(subscription, { fetchFn = fetch, getToken = getAppAccessToken, now = Date.now(), broadcasterId = channelConfig.broadcaster_id } = {}) {
  const { type, status, id } = subscription || {};
  if (!type) return false;
  if (!RESUBSCRIBE_STATUSES.has(status)) {
    logger.error(`⚠️ EventSub ${type} revocado (${status || '?'}): no se reintenta. Si es authorization_revoked, repite /auth/broadcaster.`);
    return false;
  }
  const recent = (resubscribeLog.get(type) || []).filter(t => now - t < 60 * 60 * 1000);
  if (!shouldResubscribe(status, recent.length)) {
    logger.error(`⚠️ EventSub ${type}: ya se reintentó ${recent.length} veces en la última hora; no se reintenta más.`);
    return false;
  }
  resubscribeLog.set(type, [...recent, now]);

  const defs = subscriptionDefs(broadcasterId);
  const def = [...defs.basic, ...defs.broadcasterAuth].find(d => d.type === type && d.version === subscription.version)
    || [...defs.basic, ...defs.broadcasterAuth].find(d => d.type === type);
  const publicBase = getPublicBaseUrl();
  if (!def || !publicBase || !EVENTSUB_SECRET) {
    logger.warn(`⚠️ EventSub ${type} revocado y no se puede recrear (tipo desconocido o sin URL pública).`);
    return false;
  }
  const appToken = await getToken();
  if (!appToken) { logger.warn(`⚠️ EventSub ${type}: sin app token para volver a suscribir.`); return false; }
  const headers = { 'Client-ID': process.env.CLIENT_ID, 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' };

  // Se borra la suscripción revocada para que no bloquee a la nueva (si ya no existe, da igual)
  if (id) {
    try { await fetchFn(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers }); } catch { /* ya no existe */ }
  }
  const res = await fetchFn('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST', headers,
    body: JSON.stringify({ ...def, transport: { method: 'webhook', callback: `${publicBase}/eventsub`, secret: EVENTSUB_SECRET } })
  });
  const data = await res.json().catch(() => ({}));
  if (data.data?.[0]?.status === 'webhook_callback_verification_pending') {
    logger.info(`✅ EventSub: ${type} vuelto a registrar tras revocación (${status}).`);
    return true;
  }
  logger.warn(`⚠️ EventSub ${type}: no se pudo volver a suscribir: HTTP ${res.status} ${data.message || data.error || ''}`.trim());
  return false;
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

  const defs = subscriptionDefs(broadcasterId);
  const subscriptions = defs.basic;
  const broadcasterAuthTypes = defs.broadcasterAuth.map(d => d.type);
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
  const broadcasterAuthSubs = defs.broadcasterAuth;

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
    postStreamEnd,
    getSummary,
    onStreamEnd,
    getStreamChatBuffer,
    resetStreamChatBuffer,
    getActiveUsers,
    getActiveUserIds,
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

      // Encuestas y predicciones: además del Message-Id, un mismo evento (tipo + id) se narra una sola vez
      if (isRepeatedEvent(processedEventIds, type, event?.id)) {
        logger.info(`ℹ️ EventSub: evento repetido ignorado → 204 (${type} ${event.id})`);
        return;
      }
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
        setStreamEndGraceUntil(0);
        logger.info(`🔴 Stream online via EventSub`);
        try { onStreamOnline(); } catch {}
        try { resetSessionCounters(); } catch {}
        try { resetStreamChatBuffer(); } catch {}
        try { resetStreamNarrative(); } catch {}
        try { resetBotHistory(); resetPlayer(); resetFreeCohostPause(); } catch {}
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
        // El silencio y el BRB no pasan al siguiente directo; el bot aún puede despedirse unos minutos
        setSilenceMode(false); setMuteUntil(0); setBotMode('normal'); setBrbMode(false, null, null);
        setStreamEndGraceUntil(endedAt + END_OF_STREAM_GRACE_MS);
        persistBotState();
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
          const tokenUse = getGroqTokenUse();
          logger.info(`📊 Fin de stream — ${formatTokenUse(tokenUse)}`);
          resetGroqTokenUse();
          const aiUsage = getAiUsage();
          logger.info(`📊 Fin de stream — ${formatAiUsage(aiUsage)}`);
          resetAiStreamUsage();
          const cohost = getCohostStats();
          resetCohostStats();
          // Métricas del stream para el registro de calidad (se capturan aquí porque se resetean arriba)
          const streamMetrics = {
            durationMinutes,
            fallbackUse,
            tokens: tokenUse.stream,
            requests: Object.fromEntries(Object.entries(aiUsage).map(([k, u]) => [k, u.stream.requests])),
            cohost,
          };
          logger.info(`📊 Fin de stream — ${formatCohostStats(cohost)}`);
          const filters = getFilterStats();
          resetFilterStats();
          streamMetrics.filters = filters;
          logger.info(`📊 Fin de stream — ${formatFilterStats(filters)}`);
          try {
            const gameInfo = await getCurrentGame().catch(() => null);
            const metrics = getSummary();
            const chatSample = typeof getStreamChatBuffer === 'function' ? getStreamChatBuffer() : '';
            const activeUsers = getActiveUsers();
            const activeUserIds = getActiveUserIds();
            resetActiveUsers();
            const reviewSessionId = getCurrentSessionId();
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
              activeUsers: activeUsers,
              activeUserIds
            }, chatSample);
            postStreamEnd(client, channel, memory?.summary || null);
            // Autorrevisión: solo log y Supabase, nunca el chat. Espera a que el chat registrado esté volcado.
            setTimeout(() => {
              chatlog.flush()
                .then(() => require('./ai/self-review').reviewStream({ sessionId: reviewSessionId, metrics: streamMetrics }))
                .catch(err => logger.warn(`Autorrevisión: ${err.message}`));
            }, 15000).unref?.();
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


      if (type === 'channel.prediction.begin') {
        const { title, outcomes } = event || {};
        const opcionesTexto = (outcomes || []).map((o, i) => `${i+1}) ${o.title}`).join(' | ');
        setActivePrediction({ title, outcomes });
        logger.info(`🔮 Predicción comenzada: "${title}"`);
        throttleSay(client, channel, truncate(template('prediction_begin', { title, options: opcionesTexto })));
      }

      if (type === 'channel.prediction.lock') {
        const pred = getActivePrediction();
        const titulo = pred?.title || 'la predicción';
        logger.info(`🔒 Predicción cerrada: "${titulo}"`);
        throttleSay(client, channel, truncate(template('prediction_lock', { title: titulo })));
      }

      if (type === 'channel.prediction.end') {
        const { winning_outcome_id, outcomes, title } = event || {};
        clearActivePrediction();
        const ganadorPred = (outcomes || []).find(o => o.id === winning_outcome_id);
        if (ganadorPred) {
          const totalPuntos = ganadorPred.channel_points || 0;
          const numGanadores = ganadorPred.top_predictors?.length ?? 0;
          logger.info(`🏆 Predicción terminada: ganó "${ganadorPred.title}"`);
          throttleSay(client, channel, truncate(template('prediction_end', { winner: ganadorPred.title, winners: numGanadores > 0 ? `¡${numGanadores} acertaron!` : '' })));
        }
      }

      if (type === 'channel.poll.begin') {
        const { title, choices } = event || {};
        const opcionesTexto = (choices || []).map((c, i) => `${i+1}) ${c.title}`).join(' | ');
        logger.info(`📊 Poll comenzado: "${title}"`);
        throttleSay(client, channel, truncate(template('poll_begin', { title, options: opcionesTexto })));
      }

      if (type === 'channel.poll.end') {
        const { title, choices } = event || {};
        if (choices && choices.length > 0) {
          const ganadorPoll = choices.reduce((a, b) => (b.votes > a.votes ? b : a));
          const totalVotos = choices.reduce((sum, c) => sum + c.votes, 0);
          const pct = totalVotos > 0 ? Math.round((ganadorPoll.votes / totalVotos) * 100) : 0;
          const esAjustado = pct < 40;
          logger.info(`📊 Poll terminado: ganó "${ganadorPoll.title}" con ${pct}%`);
          throttleSay(client, channel, truncate(template(esAjustado ? 'poll_end_close' : 'poll_end', { winner: ganadorPoll.title, pct, votes: totalVotos })));
        }
      }

      if (type === 'channel.channel_points_custom_reward_redemption.add') {
        try {
          const { user_name, user_id, reward, user_input } = event || {};
          const rewardTitle = reward?.title?.toLowerCase() || '';
          logger.info(`🎁 Canje: ${user_name} → "${reward?.title}"`);
          // Solo se atienden los canjes de pregunta (se contestan como !dios_fua); el resto no se narra
          if (rewardTitle.includes('pregunta') && user_input?.trim() && handleQuestion) {
            const fakeTags = { 'display-name': user_name, 'user-id': user_id || user_name, username: user_name };
            await handleQuestion(client, channel, fakeTags, ['!dios_fua', ...user_input.trim().split(' ')]);
          }
        } catch (err) {
          logger.warn(`Canje: ${err.message}`);
        }
      }

      return;
    }

    if (messageType === MESSAGE_TYPE_REVOCATION) {
      logger.warn(`⚠️ EventSub revocado → 204 (${body.subscription?.type}, motivo=${body.subscription?.status || '?'})`);
      const revoked = body.subscription;
      setImmediate(() => handleRevocation(revoked).catch(err => logger.error(`EventSub revocación: ${err.message}`)));
    } else {
      logger.warn(`⚠️ EventSub: tipo de mensaje desconocido → 204 [tipo=${messageType || '?'}]`);
    }

    res.writeHead(204); res.end();
  };
}

module.exports = {
  createEventSubHandler,
  formatCohostStats, formatFilterStats, formatTokenUse, formatAiUsage,
  registerSubscriptions,
  subscriptionDefs, shouldResubscribe, handleRevocation,
  initStreamState,
  checkLiveNow,
  isLiveViaEventSub,
  getStreamUptime,
  getViewersWithAppToken,
  getAppAccessToken,
  getPublicBaseUrl,
  isRepeatedEvent
};
