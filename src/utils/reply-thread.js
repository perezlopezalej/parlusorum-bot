// Respuestas en hilo (Send Chat Message con reply_parent_message_id): en vez de abrir el mensaje con «@usuario», el bot responde
// al mensaje de quien escribió y Twitch muestra «Replying to @usuario». Así un lector de voz no lee la arroba.
// Solo con CHAT_SEND=api y CHAT_REPLY_THREAD=1 (apagado por defecto: Twitch no documenta si añade él la arroba al texto; hay
// que verlo en directo antes de activarlo). Por IRC no se hace hilo: tmi.js 1.8.5 no tiene reply() y el mensaje sale con la arroba.
// Módulo puro, sin estado ni I/O.

// Orígenes que responden a un mensaje concreto de un usuario
const REPLY_ORIGINS = new Set(['comando', 'dios_fua', 'mencion', 'chiste', 'quemeperdi']);

const enabled = (env = process.env) => /^(1|true|on|si|sí)$/i.test(String(env.CHAT_REPLY_THREAD || '').trim());

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Quita la arroba inicial de quien se contesta. → { text, replied }.
// Vale «@nick texto», «@nick, texto», «@nick: texto» y con un emoji delante («⏳ @nick, texto»). No toca el mensaje si la
// arroba es de otra persona, si no está al principio o si no queda nada más que decir.
function stripLeadingMention(msg, nick) {
  const text = String(msg ?? '');
  if (!nick) return { text, replied: false };
  const re = new RegExp(`^([^\\p{L}\\p{N}@]*)@${escape(nick)}(?![\\p{L}\\p{N}_])\\s*[,:]?\\s*`, 'iu');
  const m = re.exec(text);
  if (!m) return { text, replied: false };
  const rest = text.slice(m[0].length);
  if (!/[\p{L}\p{N}]/u.test(rest)) return { text, replied: false };
  return { text: `${m[1]}${rest}`.trim(), replied: true };
}

// ¿Este mensaje sale en hilo? → { text, replyTo } con el texto sin la arroba, o null (sale tal cual, con su arroba).
// meta.replyTo: { id, nick } del mensaje al que se contesta (lo pone index.js con runWithOrigin).
function planReply(msg, meta, { env = process.env, hasApi = true } = {}) {
  if (!hasApi || !enabled(env) || !meta?.replyTo?.id || !REPLY_ORIGINS.has(meta.origin)) return null;
  const { text, replied } = stripLeadingMention(msg, meta.replyTo.nick);
  return replied ? { text, replyTo: meta.replyTo.id } : null;
}

module.exports = { REPLY_ORIGINS, enabled, stripLeadingMention, planReply };
