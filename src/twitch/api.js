const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

function getToken() {
  return (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
}

function getBotToken() {
  return (process.env.BOT_TOKEN || '').replace('oauth:', '');
}

function getHeaders() {
  return {
    'Client-ID': process.env.CLIENT_ID,
    'Authorization': `Bearer ${getToken()}`
  };
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
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`,
      { headers: getHeaders() }
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
    const res = await fetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`,
      { headers: getHeaders() }
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
    const res = await fetch(
      `https://api.twitch.tv/helix/videos?user_id=${broadcasterId}&type=archive&first=${limit}`,
      { headers: getHeaders() }
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
    const res = await fetch(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`,
      {
        method: 'POST',
        headers: getHeaders()
      }
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
const gameInfoCache = new Map();

async function getGameInfo(gameName) {
  if (!gameName) return null;
  if (gameInfoCache.has(gameName)) return gameInfoCache.get(gameName);

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

    gameInfoCache.set(gameName, info);
    return info;
  } catch (e) {
    logger.error(`Error RAWG: ${e.message}`);
    return null;
  }
}

// --- Seguidores ---
async function getFollowerCount(broadcasterId) {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}`,
      { headers: getHeaders() }
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
    const userRes = await fetch(
      `https://api.twitch.tv/helix/users?login=${username}`,
      { headers: getHeaders() }
    );
    const userData = await userRes.json();
    const userId = userData.data?.[0]?.id;
    if (!userId) return null;

    const channelRes = await fetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${userId}`,
      { headers: getHeaders() }
    );
    const channelData = await channelRes.json();
    return channelData.data?.[0] || null;
  } catch (e) {
    logger.error(`Error al obtener info del raider: ${e.message}`);
    return null;
  }
}

module.exports = {
  getStreamInfo, isStreamLive, getCurrentGame, getRecentGames,
  createClip, getGameInfo, getFollowerCount, getChannelInfo
};
