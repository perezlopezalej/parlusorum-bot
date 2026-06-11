const Groq = require('groq-sdk');
const channelConfig = require('../../config/channel.json');

// FIX #3: modelo configurable via env var.
// llama-4-maverick (meta-llama/llama-4-maverick-17b-128e-instruct) deprecado en Groq feb/2026.
// Cambia GROQ_MODEL en .env si quieres probarlo, pero tiene la mitad de rate limit.
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const TWITCH_MAX_LENGTH = 490;

// Regex para separar emotes del canal de puntuación adyacente.
// Construida una vez al cargar el módulo para no repetirla en cada mensaje.
const _channelEmotes = channelConfig.channel_emotes || [];
const _emotePattern = _channelEmotes.length > 0
  ? _channelEmotes.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  : null;
const _emoteBeforeRe = _emotePattern ? new RegExp(`(\\S)(${_emotePattern})`, 'g') : null;
const _emoteAfterRe  = _emotePattern ? new RegExp(`(${_emotePattern})(\\S)`, 'g') : null;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function groqWithRetry(params, maxRetries = 2) {
  params.model = GROQ_MODEL;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await groq.chat.completions.create(params); }
    catch (err) {
      if ((err.status === 429 || err.message?.includes('rate')) && attempt < maxRetries) {
        const retryAfterSec = parseInt(err.headers?.['retry-after'] || '0');
        const delay = retryAfterSec > 0
          ? retryAfterSec * 1000
          : 2 ** attempt * 1000 + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function truncate(msg, limit = TWITCH_MAX_LENGTH) {
  let clean = msg.replace(/\*+/g, '').replace(/  +/g, ' ').trim();
  if (_emoteBeforeRe) clean = clean.replace(_emoteBeforeRe, '$1 $2');
  if (_emoteAfterRe)  clean = clean.replace(_emoteAfterRe,  '$1 $2');
  clean = clean.replace(/  +/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 3) + '...';
}

module.exports = { groqWithRetry, truncate };
