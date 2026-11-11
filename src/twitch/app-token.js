// App Access Token de Twitch (client_credentials) con caché. Lo usan EventSub e IGDB (mismo CLIENT_ID/secret).
const logger = require('../utils/logger');

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
        grant_type: 'client_credentials',
      }),
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

// Tras un 401: el siguiente getAppAccessToken pide uno nuevo
function invalidateAppAccessToken() {
  appTokenCache = null;
  appTokenExpiry = 0;
}

module.exports = { getAppAccessToken, invalidateAppAccessToken };
