// Envío de mensajes con la API Send Chat Message de Twitch (POST helix/chat/messages) y token de aplicación.
// Es lo que da la insignia oficial de "Chat Bot" (IRC no la da). El chat se sigue LEYENDO por IRC (tmi.js).
//
// Requisitos de autorización (documentación de Twitch, Send Chat Message):
//   · la cuenta del bot autorizó a la app los scopes user:write:chat y user:bot (npm run bot-token)
//   · el canal autorizó channel:bot, salvo que el bot sea moderador del canal (entonces no hace falta)
//   · el bot no puede ser el propio streamer
// La API tiene su propio cubo de límites y no gasta el del IRC; el mensaje máx. es de 500 caracteres.
const logger = require('../utils/logger');
const channelConfig = require('../../config/channel.json');
const { getAppAccessToken, invalidateAppAccessToken } = require('./app-token');

const HELIX = 'https://api.twitch.tv/helix';
const DISABLE_ON_AUTH_MS = 10 * 60 * 1000; // tras un 400/401/403 de autorización no se insiste durante un rato (se usa IRC)

let botUserId = process.env.BOT_USER_ID || null;
let disabledUntil = 0;
let deps = { fetch: (...a) => fetch(...a), now: () => Date.now() };

// Solo para tests
function _setDeps(d) { deps = { ...deps, ...d }; botUserId = d.botUserId !== undefined ? d.botUserId : botUserId; if (d.reset) { disabledUntil = 0; } }

class ChatApiError extends Error {
  constructor(message, { status, auth = false } = {}) { super(message); this.name = 'ChatApiError'; this.status = status; this.auth = auth; }
}

async function helix(path, { method = 'GET', body, retry = true } = {}) {
  const token = await getAppAccessToken();
  if (!token) throw new ChatApiError('sin app token');
  const res = await deps.fetch(`${HELIX}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': process.env.CLIENT_ID, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) { invalidateAppAccessToken(); return helix(path, { method, body, retry: false }); }
  return res;
}

// ID del bot: BOT_USER_ID o consulta de users?login= (se cachea)
async function resolveBotUserId() {
  if (botUserId) return botUserId;
  const res = await helix(`/users?login=${encodeURIComponent(process.env.BOT_USERNAME || '')}`);
  if (!res.ok) throw new ChatApiError(`users HTTP ${res.status}`, { status: res.status });
  const json = await res.json();
  botUserId = json?.data?.[0]?.id || null;
  if (!botUserId) throw new ChatApiError('no se pudo resolver el ID del bot');
  return botUserId;
}

// Devuelve { sent: true, id } | { sent: false, reason } (Twitch lo recibió pero lo descartó: automod, duplicado...).
// Lanza ChatApiError si no se pudo usar la API (el llamador recurre a IRC).
async function sendChatMessage(message, { replyTo } = {}) {
  if (deps.now() < disabledUntil) throw new ChatApiError('API desactivada temporalmente por autorización', { auth: true });
  const sender = await resolveBotUserId();
  const res = await helix('/chat/messages', {
    method: 'POST',
    body: { broadcaster_id: String(channelConfig.broadcaster_id), sender_id: String(sender), message: String(message).slice(0, 500), ...(replyTo ? { reply_parent_message_id: replyTo } : {}) },
  });
  if (res.status === 429) throw new ChatApiError('límite de la API de chat', { status: 429 });
  if (!res.ok) {
    const auth = [400, 401, 403].includes(res.status);
    if (auth) {
      disabledUntil = deps.now() + DISABLE_ON_AUTH_MS;
      logger.warn(`Chat API: HTTP ${res.status}; faltan permisos (bot: user:write:chat + user:bot; canal: channel:bot o bot moderador). Uso IRC ${DISABLE_ON_AUTH_MS / 60000} min.`);
    }
    throw new ChatApiError(`HTTP ${res.status}`, { status: res.status, auth });
  }
  const json = await res.json();
  const item = json?.data?.[0];
  if (item?.is_sent) return { sent: true, id: item.message_id };
  return { sent: false, reason: item?.drop_reason?.code || 'desconocido', detail: item?.drop_reason?.message };
}

const enabled = () => String(process.env.CHAT_SEND || 'irc').toLowerCase() === 'api';

module.exports = { sendChatMessage, resolveBotUserId, enabled, ChatApiError, _setDeps };
