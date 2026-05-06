const channelConfig = require('../../config/channel.json');

function getToken() {
  return (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
}

function getHeaders() {
  return {
    'Client-ID': process.env.CLIENT_ID,
    'Authorization': `Bearer ${getToken()}`
  };
}

// Obtener número de seguidores del canal
async function getFollowerCount(broadcasterId) {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}`,
      { headers: getHeaders() }
    );
    const data = await res.json();
    return data.total ?? null;
  } catch (e) {
    console.error('⚠️ Error al obtener seguidores:', e.message);
    return null;
  }
}

// Obtener info del canal de un raider
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
    console.error('⚠️ Error al obtener info del raider:', e.message);
    return null;
  }
}

// --- Obtener juego actual (cache de 3 minutos) ---
let currentGameCache = null;
let lastGameCheck = 0;
const GAME_CACHE_TTL = 3 * 60 * 1000;

async function getCurrentGame() {
  const now = Date.now();

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
      currentGameCache = {
        game: channel.game_name || null,
        title: channel.title || null
      };
      if (currentGameCache.game) {
        console.log(`🎮 Juego actual: ${currentGameCache.game}`);
      }
    }

    lastGameCheck = now;
    return currentGameCache;
  } catch (e) {
    console.error('⚠️ Error al obtener juego actual:', e.message);
    return currentGameCache || { game: null };
  }
}

module.exports = { getFollowerCount, getChannelInfo, getCurrentGame };
