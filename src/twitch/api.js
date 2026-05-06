// --- Twitch API helper ---
// Node 24 tiene fetch nativo, no necesita librería externa

function getToken() {
  return (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
}

// Obtener info del broadcaster (incluye su ID)
async function getBroadcasterInfo() {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/users?login=${process.env.CHANNEL}`,
      {
        headers: {
          'Client-ID': process.env.CLIENT_ID,
          'Authorization': `Bearer ${getToken()}`
        }
      }
    );
    const data = await res.json();
    return data.data?.[0] || null;
  } catch (e) {
    console.error('⚠️ Error al obtener info del broadcaster:', e.message);
    return null;
  }
}

// Obtener número de seguidores del canal
async function getFollowerCount(broadcasterId) {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}`,
      {
        headers: {
          'Client-ID': process.env.CLIENT_ID,
          'Authorization': `Bearer ${getToken()}`
        }
      }
    );
    const data = await res.json();
    return data.total || 0;
  } catch (e) {
    console.error('⚠️ Error al obtener seguidores:', e.message);
    return null;
  }
}

// Obtener info del canal de un raider (para raid contextual)
async function getChannelInfo(username) {
  try {
    // Primero obtenemos el user ID
    const userRes = await fetch(
      `https://api.twitch.tv/helix/users?login=${username}`,
      {
        headers: {
          'Client-ID': process.env.CLIENT_ID,
          'Authorization': `Bearer ${getToken()}`
        }
      }
    );
    const userData = await userRes.json();
    const userId = userData.data?.[0]?.id;
    if (!userId) return null;

    // Luego obtenemos el canal
    const channelRes = await fetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${userId}`,
      {
        headers: {
          'Client-ID': process.env.CLIENT_ID,
          'Authorization': `Bearer ${getToken()}`
        }
      }
    );
    const channelData = await channelRes.json();
    return channelData.data?.[0] || null;
  } catch (e) {
    console.error('⚠️ Error al obtener info del raider:', e.message);
    return null;
  }
}

module.exports = { getBroadcasterInfo, getFollowerCount, getChannelInfo };
