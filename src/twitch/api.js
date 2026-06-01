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

async function getGameInfo(gameName) {
  if (!gameName) return null;
  if (gameInfoCache.has(gameName)) {
    const cached = gameInfoCache.get(gameName);
    if (Date.now() - cached.ts <= RAWG_CACHE_TTL) return cached.data;
    gameInfoCache.delete(gameName);
  }

  const apiKey = process.env.RAWG_API_KEY;
  if (!apiKey) return null;

  try {
    const query = encodeURIComponent(gameName);
    const res = await fetch(
      `https://api.rawg.io/api/games?key=${apiKey}&search=${query}&page_size=1`,
      { headers: { 'Accept': 'application/json' } }
    );
    const data = await res.json();
    const game = data.results?.[0];
    if (!game) return null;

    const info = {
      name: game.name,
      description: game.description_raw?.slice(0, 300) || null,
      genres: game.genres?.map(g => g.name).join(', ') || null,
      released: game.released || null,
      rating: game.rating || null
    };

    gameInfoCache.set(gameName, { data: info, ts: Date.now() });
    return info;
  } catch (e) {
    logger.error(`Error RAWG: ${e.message}`);
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
};
