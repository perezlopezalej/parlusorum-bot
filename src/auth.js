const crypto = require('crypto');
const logger = require('./utils/logger');
const { saveTokens } = require('./utils/supabase');

// Scopes que usan las llamadas con BROADCASTER_TOKEN:
//  clips:edit                    → !clip (helix/clips)
//  user:edit:broadcast           → !marker y auto-highlights (helix/streams/markers)
//  moderator:manage:banned_users → auto-ban de bots (helix/moderation/bans)
//  moderator:read:followers      → helix/channels/followers y EventSub channel.follow v2
//  channel:read:hype_train / predictions / polls / redemptions → EventSub por webhook
const BROADCASTER_SCOPES = [
  'clips:edit',
  'user:edit:broadcast',
  'channel:manage:broadcast',
  'moderator:manage:banned_users',
  'moderator:read:followers',
  'channel:read:hype_train',
  'channel:read:predictions',
  'channel:read:polls',
  'channel:read:redemptions',
];

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map(); // state → expiresAt

setInterval(() => {
  const now = Date.now();
  for (const [s, exp] of pendingStates) if (exp < now) pendingStates.delete(s);
}, 60 * 1000).unref();

function getRedirectUri() {
  const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/auth/callback` : null;
}

function page(res, status, title, msg) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center"><h1>${title}</h1><p>${msg}</p></body></html>`);
}

function handleAuthStart(req, res) {
  const redirectUri = getRedirectUri();
  if (!redirectUri) return page(res, 500, 'Error', 'Falta PUBLIC_URL (o RENDER_EXTERNAL_URL) en el servidor.');
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: BROADCASTER_SCOPES.join(' '),
    state,
    force_verify: 'true',
  }).toString();
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

async function handleAuthCallback(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const state = params.get('state');
  const code = params.get('code');
  const exp = state ? pendingStates.get(state) : null;
  if (state) pendingStates.delete(state);
  if (!exp || exp < Date.now()) return page(res, 400, 'Enlace caducado', 'Vuelve a empezar desde /auth/broadcaster.');
  if (params.get('error') || !code) return page(res, 400, 'Autorización cancelada', 'No se concedieron los permisos.');

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: getRedirectUri(),
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token || !tokens.refresh_token) {
      logger.error(`Auth callback: canje fallido (${tokenRes.status}: ${tokens.message || 'sin detalle'})`);
      return page(res, 502, 'Error', 'Twitch rechazó el código de autorización.');
    }

    const valRes = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${tokens.access_token}` } });
    const val = await valRes.json();
    if (!valRes.ok || (val.login || '').toLowerCase() !== process.env.CHANNEL.toLowerCase()) {
      logger.warn(`Auth callback: login ${val.login || '?'} no coincide con el canal configurado — rechazado.`);
      return page(res, 403, 'Cuenta incorrecta', 'Debes autorizar con la cuenta del canal.');
    }

    process.env.BROADCASTER_TOKEN = tokens.access_token;
    process.env.BROADCASTER_REFRESH_TOKEN = tokens.refresh_token;
    await saveTokens({ broadcaster_token: tokens.access_token, broadcaster_refresh_token: tokens.refresh_token });
    logger.info('🔐 Broadcaster reautorizado vía /auth/broadcaster.');
    page(res, 200, 'Autorizado correctamente', 'Ya puedes cerrar esta pestaña. Reinicia el servicio para re-registrar las suscripciones de EventSub.');
  } catch (e) {
    logger.error(`Auth callback error: ${e.message}`);
    page(res, 500, 'Error', 'Fallo inesperado en el servidor.');
  }
}

module.exports = { BROADCASTER_SCOPES, handleAuthStart, handleAuthCallback };
