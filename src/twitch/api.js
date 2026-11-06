const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');
const { classifyGameMatch } = require('../utils/game-match');
const { searchGame: searchIgdb } = require('./igdb');

function getToken() {
  return (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
}

function getHeaders() {
  return {
    'Client-ID': process.env.CLIENT_ID,
    'Authorization': `Bearer ${getToken()}`
  };
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshBroadcasterToken() {
  const refreshToken = process.env.BROADCASTER_REFRESH_TOKEN;
  if (!refreshToken) {
    logger.error('🔴 BROADCASTER_REFRESH_TOKEN no configurado — regenera el token manualmente.');
    return false;
  }
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
      })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      logger.error(`🔴 Refresh de BROADCASTER_TOKEN fallido (${res.status}: ${data.message || 'sin detalle'}) — regenera el token manualmente.`);
      return false;
    }
    process.env.BROADCASTER_TOKEN = data.access_token;
    process.env.BROADCASTER_REFRESH_TOKEN = data.refresh_token || refreshToken;
    logger.info('🔄 BROADCASTER_TOKEN refrescado exitosamente.');
    const { saveTokens } = require('../utils/supabase');
    await saveTokens({
      broadcaster_token: data.access_token,
      broadcaster_refresh_token: data.refresh_token || refreshToken,
    }).catch(e => logger.warn(`No se pudieron persistir tokens: ${e.message}`));
    return true;
  } catch (e) {
    logger.error(`Error en refreshBroadcasterToken: ${e.message}`);
    return false;
  }
}

async function helixFetch(url, options = {}) {
  const headers = { ...getHeaders(), ...(options.headers || {}) };
  let res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    const refreshed = await refreshBroadcasterToken();
    if (refreshed) {
      res = await fetch(url, { ...options, headers: { ...getHeaders(), ...(options.headers || {}) } });
    }
  }
  return res;
}

async function loadBroadcasterTokens() {
  const { loadTokens } = require('../utils/supabase');
  const tokens = await loadTokens().catch(() => null);
  if (!tokens) return;
  if (tokens.broadcaster_token) {
    process.env.BROADCASTER_TOKEN = tokens.broadcaster_token;
    logger.info('🔄 BROADCASTER_TOKEN cargado desde Supabase (más fresco que .env)');
  }
  if (tokens.broadcaster_refresh_token) {
    process.env.BROADCASTER_REFRESH_TOKEN = tokens.broadcaster_refresh_token;
  }
}

// ─── Token del bot (IRC) ──────────────────────────────────────────────────────

const BOT_TOKEN_MIN_REMAINING_S = 3600;

function stripOauth(token) {
  return (token || '').replace(/^oauth:/, '');
}

// Devuelve { valid, expiresIn, login } sin exponer el token.
async function validateBotToken(token = process.env.BOT_TOKEN) {
  const clean = stripOauth(token);
  if (!clean) return { valid: false, expiresIn: 0, login: null };
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { 'Authorization': `OAuth ${clean}` } });
    if (!res.ok) return { valid: false, expiresIn: 0, login: null };
    const data = await res.json();
    return { valid: true, expiresIn: data.expires_in || 0, login: data.login || null };
  } catch (e) {
    logger.warn(`No se pudo validar BOT_TOKEN: ${e.message}`);
    return { valid: false, expiresIn: 0, login: null, networkError: true };
  }
}

async function refreshBotToken() {
  const refreshToken = process.env.BOT_REFRESH_TOKEN;
  if (!refreshToken) {
    logger.error('🔴 BOT_REFRESH_TOKEN no configurado — ejecuta scripts/get-bot-token.js para generar uno nuevo.');
    return false;
  }
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
      })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      logger.error(`🔴 Refresh de BOT_TOKEN fallido (${res.status}: ${data.message || 'sin detalle'}) — regenera el token con scripts/get-bot-token.js.`);
      return false;
    }
    process.env.BOT_TOKEN = data.access_token;
    process.env.BOT_REFRESH_TOKEN = data.refresh_token || refreshToken;
    logger.info('🔄 BOT_TOKEN refrescado exitosamente.');
    const { saveTokens } = require('../utils/supabase');
    await saveTokens({
      bot_token: data.access_token,
      bot_refresh_token: data.refresh_token || refreshToken,
    }).catch(e => logger.warn(`No se pudieron persistir tokens del bot: ${e.message}`));
    return true;
  } catch (e) {
    logger.error(`Error en refreshBotToken: ${e.message}`);
    return false;
  }
}

// Carga el refresh token (y el token) del bot desde Supabase si existen.
// Devuelve el token de Supabase para que el llamador decida cuál usar.
async function loadBotTokens() {
  const { loadTokens } = require('../utils/supabase');
  const tokens = await loadTokens().catch(() => null);
  if (!tokens) return null;
  if (tokens.bot_refresh_token) process.env.BOT_REFRESH_TOKEN = tokens.bot_refresh_token;
  return tokens.bot_token || null;
}

// Garantiza un BOT_TOKEN válido con al menos 1 h de vida; refresca si hace falta.
async function ensureBotToken() {
  const envToken = process.env.BOT_TOKEN;
  const dbToken = await loadBotTokens();
  for (const candidate of [dbToken, envToken]) {
    if (!candidate) continue;
    const v = await validateBotToken(candidate);
    if (v.valid) {
      process.env.BOT_TOKEN = candidate;
      if (v.expiresIn >= BOT_TOKEN_MIN_REMAINING_S) return true;
      break;
    }
  }
  return refreshBotToken();
}

// Refresca solo si el token actual caduca pronto o ya no es válido.
async function refreshBotTokenIfNeeded() {
  const v = await validateBotToken();
  if (v.networkError) return false;
  if (v.valid && v.expiresIn >= BOT_TOKEN_MIN_REMAINING_S) return true;
  return refreshBotToken();
}

// --- Estado del stream en tiempo real ---
let streamCache = null;
let lastStreamCheck = 0;
const STREAM_CACHE_TTL = 60 * 1000;

async function getStreamInfo() {
  const now = Date.now();
  if (streamCache !== null && now - lastStreamCheck < STREAM_CACHE_TTL) {
    return streamCache;
  }

  try {
    const broadcasterId = channelConfig.broadcaster_id;
    const res = await helixFetch(
      `https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`
    );
    const data = await res.json();
    const stream = data.data?.[0];

    streamCache = stream ? {
      live: true,
      viewers: stream.viewer_count || 0,
      game: stream.game_name || null,
      title: stream.title || null,
      startedAt: stream.started_at || null,
      streamId: stream.id || null
    } : { live: false, viewers: 0, game: null, title: null, startedAt: null, streamId: null };

    lastStreamCheck = now;
    return streamCache;
  } catch (e) {
    logger.error(`Error al obtener estado del stream: ${e.message}`);
    return streamCache || { live: false, viewers: 0, game: null };
  }
}

function isStreamLive() {
  return streamCache?.live === true;
}

// --- Juego actual ---
let currentGameCache = null;
let lastGameCheck = 0;
const GAME_CACHE_TTL = 3 * 60 * 1000;

async function getCurrentGame() {
  const now = Date.now();
  if (streamCache?.live && streamCache?.game && now - lastStreamCheck < STREAM_CACHE_TTL) {
    return { game: streamCache.game, title: streamCache.title };
  }
  if (currentGameCache && now - lastGameCheck < GAME_CACHE_TTL) {
    return currentGameCache;
  }

  try {
    const broadcasterId = channelConfig.broadcaster_id;
    const res = await helixFetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`
    );
    const data = await res.json();
    const channel = data.data?.[0];

    if (channel) {
      currentGameCache = { game: channel.game_name || null, title: channel.title || null };
      if (currentGameCache.game) {
        logger.info(`🎮 Juego actual: ${currentGameCache.game}`);
        // Ficha precalentada (con detalle): si las fuentes caen después, el juego actual sigue respondiendo
        if (!gameInfoCache.has(`${currentGameCache.game}|detail`)) lookupGameInfo(currentGameCache.game, { detail: true }).catch(() => {});
      }
    }
    lastGameCheck = now;
    return currentGameCache;
  } catch (e) {
    logger.error(`Error al obtener juego actual: ${e.message}`);
    return currentGameCache || { game: null };
  }
}

// --- Historial de juegos recientes via API ---
async function getRecentGames(limit = 10) {
  try {
    const broadcasterId = channelConfig.broadcaster_id;
    const res = await helixFetch(
      `https://api.twitch.tv/helix/videos?user_id=${broadcasterId}&type=archive&first=${limit}`
    );
    const data = await res.json();
    const games = [...new Set(
      data.data?.map(v => v.game_name || null).filter(Boolean) || []
    )];
    return games;
  } catch (e) {
    logger.error(`Error al obtener juegos recientes: ${e.message}`);
    return channelConfig.games_played || [];
  }
}

// --- Crear clip automático ---
async function createClip() {
  try {
    const broadcasterId = channelConfig.broadcaster_id;
    const res = await helixFetch(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`,
      { method: 'POST' }
    );
    const data = await res.json();
    const clip = data.data?.[0];
    if (clip?.edit_url) {
      const clipUrl = clip.edit_url.replace('/edit', '');
      logger.info(`📎 Clip creado: ${clipUrl}`);
      return clipUrl;
    }
    return null;
  } catch (e) {
    logger.error(`Error al crear clip: ${e.message}`);
    return null;
  }
}

// --- Info del juego (IGDB) ---
// 24h: los datos (géneros, fecha, estudio) son estables pero pueden actualizarse ocasionalmente
const GAME_INFO_TTL = 24 * 60 * 60 * 1000;
// La ficha del juego actual del stream dura más: así las fuentes caídas no dejan sin datos al juego que se está jugando
const CURRENT_GAME_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const gameInfoCache = new Map(); // valores: { data, ts, ttl }

// Purga entradas expiradas cada 6h para evitar memory leak de juegos que ya no se streamean
const gameCacheCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of gameInfoCache) {
    if (now - cached.ts > (cached.ttl || GAME_INFO_TTL)) gameInfoCache.delete(key);
  }
}, 6 * 60 * 60 * 1000);
gameCacheCleanupInterval.unref();

// detail=true recorta la descripción a 600 en vez de 300 (solo !dios_fua y la trivia lo usan).
// { info, error }: error=true solo si IGDB no pudo responder (5xx, timeout, respuesta ilegible);
// "no encontrado" es info null con error false.
// Si IGDB falla, sirve la ficha en caché aunque haya caducado.
async function lookupGameInfo(gameName, { detail = false } = {}) {
  if (!gameName) return { info: null, error: false };
  const cacheKey = detail ? `${gameName}|detail` : gameName;
  const cached = gameInfoCache.get(cacheKey);
  if (cached && Date.now() - cached.ts <= (cached.ttl || GAME_INFO_TTL)) return { info: cached.data, error: false };

  let info = null;
  let answered = false;
  try {
    info = await searchIgdb(gameName, { detail });
    answered = true;
  } catch (e) {
    logger.error(`Error IGDB: ${e.message}`);
  }

  if (info) {
    const current = currentGameName();
    const isCurrent = current && (info.name.toLowerCase() === current.toLowerCase() || gameName.toLowerCase() === current.toLowerCase());
    gameInfoCache.set(cacheKey, { data: info, ts: Date.now(), ttl: isCurrent ? CURRENT_GAME_CACHE_TTL : GAME_INFO_TTL });
    return { info, error: false };
  }
  if (answered) return { info: null, error: false };
  // Caducada o la ficha del juego actual (el nombre buscado puede ser una variante): mejor eso que nada
  if (cached) return { info: cached.data, error: false };
  const stale = staleCurrentGame(gameName, detail);
  return stale ? { info: stale, error: false } : { info: null, error: true };
}

// Nombre del juego actual del stream según las cachés de Helix (sin llamar a la API)
function currentGameName() {
  return (streamCache?.live && streamCache?.game) || currentGameCache?.game || null;
}

// Ficha en caché del juego actual si el nombre buscado es ese juego (p. ej. "phantom blade 0")
function staleCurrentGame(query, detail) {
  const current = currentGameName();
  if (!current || classifyGameMatch(query, current) !== 'match') return null;
  return (gameInfoCache.get(detail ? `${current}|detail` : current) || gameInfoCache.get(`${current}|detail`))?.data || null;
}

async function getGameInfo(gameName, opts) {
  return (await lookupGameInfo(gameName, opts)).info;
}

// --- Seguidores ---
async function getFollowerCount(broadcasterId) {
  try {
    const res = await helixFetch(
      `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}`
    );
    const data = await res.json();
    return data.total ?? null;
  } catch (e) {
    logger.error(`Error al obtener seguidores: ${e.message}`);
    return null;
  }
}

// --- Info del canal de un raider ---
async function getChannelInfo(username) {
  try {
    const userRes = await helixFetch(
      `https://api.twitch.tv/helix/users?login=${username}`
    );
    const userData = await userRes.json();
    const userId = userData.data?.[0]?.id;
    if (!userId) return null;

    const channelRes = await helixFetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${userId}`
    );
    const channelData = await channelRes.json();
    return channelData.data?.[0] || null;
  } catch (e) {
    logger.error(`Error al obtener info del raider: ${e.message}`);
    return null;
  }
}

// --- Crear stream marker --- FIX #10
// Requiere scope user:edit:broadcast en el broadcaster token
async function createStreamMarker(description = 'Momento epico') {
  const broadcasterId = channelConfig.broadcaster_id;
  try {
    const res = await helixFetch(
      'https://api.twitch.tv/helix/streams/markers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: broadcasterId,
          description: description.slice(0, 140)
        })
      }
    );
    const data = await res.json();
    if (data.data && data.data[0] && data.data[0].id) {
      logger.info('Marker creado: ' + data.data[0].id + ' - ' + description);
      return data.data[0];
    }
    if (data.error) logger.warn('Marker error: ' + data.error + ' - ' + data.message);
    return null;
  } catch (e) {
    logger.error('Error al crear marker: ' + e.message);
    return null;
  }
}

module.exports = {
  getStreamInfo, isStreamLive, getCurrentGame, getRecentGames,
  createClip, createStreamMarker, getGameInfo, lookupGameInfo, getFollowerCount, getChannelInfo,
  refreshBroadcasterToken, loadBroadcasterTokens,
  validateBotToken, refreshBotToken, ensureBotToken, refreshBotTokenIfNeeded,
};
