const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

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
      if (currentGameCache.game) logger.info(`🎮 Juego actual: ${currentGameCache.game}`);
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

// --- Info del juego via RAWG ---
// 24h: los datos de RAWG (géneros, rating) son estables pero pueden actualizarse ocasionalmente
const RAWG_CACHE_TTL = 24 * 60 * 60 * 1000;
const gameInfoCache = new Map(); // valores: { data, ts }

// Purga entradas expiradas cada 6h para evitar memory leak de juegos que ya no se streamean
const rawgCacheCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of gameInfoCache) {
    if (now - cached.ts > RAWG_CACHE_TTL) gameInfoCache.delete(key);
  }
}, 6 * 60 * 60 * 1000);
rawgCacheCleanupInterval.unref();

// detail=true hace una 2ª llamada a /games/{id} (el listado no trae descripción
// ni desarrolladora). Solo la usan !dios_fua y la trivia; el resto sigue rápido.
async function getGameInfo(gameName, { detail = false } = {}) {
  if (!gameName) return null;
  const cacheKey = detail ? `${gameName}|detail` : gameName;
  if (gameInfoCache.has(cacheKey)) {
    const cached = gameInfoCache.get(cacheKey);
    if (Date.now() - cached.ts <= RAWG_CACHE_TTL) return cached.data;
    gameInfoCache.delete(cacheKey);
  }

  const apiKey = process.env.RAWG_API_KEY;
  if (!apiKey) return null;

  try {
    const query = encodeURIComponent(gameName);
    const res = await fetch(
      `https://api.rawg.io/api/games?key=${apiKey}&search=${query}&search_precise=true&page_size=1`,
      { headers: { 'Accept': 'application/json' } }
    );
    const data = await res.json();
    let game = data.results?.[0];
    if (!game) return null;

    if (detail && game.id) {
      const detRes = await fetch(
        `https://api.rawg.io/api/games/${game.id}?key=${apiKey}`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (detRes.ok) game = { ...game, ...(await detRes.json()) };
    }

    const info = {
      name: game.name,
      description: game.description_raw?.slice(0, detail ? 600 : 300) || null,
      genres: game.genres?.map(g => g.name).join(', ') || null,
      released: game.released || null,
      rating: game.rating || null,
      developers: game.developers?.map(d => d.name).join(', ') || null
    };

    gameInfoCache.set(cacheKey, { data: info, ts: Date.now() });
    return info;
  } catch (e) {
    logger.error(`Error RAWG: ${e.message.replace(apiKey, '[REDACTED]')}`);
    return null;
  }
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
  createClip, createStreamMarker, getGameInfo, getFollowerCount, getChannelInfo,
  refreshBroadcasterToken, loadBroadcasterTokens,
  validateBotToken, refreshBotToken, ensureBotToken, refreshBotTokenIfNeeded,
};
