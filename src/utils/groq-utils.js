const Groq = require('groq-sdk');
const channelConfig = require('../../config/channel.json');

// Modelos configurables via env var. Groq retira modelos con frecuencia:
// toda la familia llama-3.x/llama-4 y los groq/compound devuelven 404 model_not_found
// desde sep/2026. Verificar los vivos con: GET https://api.groq.com/openai/v1/models
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_MODEL_FAST = process.env.GROQ_MODEL_FAST || 'openai/gpt-oss-20b';
// groq/compound traia busqueda web integrada y no tiene sustituto en la API.
// !dios_fua responde ahora con el modelo normal, sin busqueda.
const GROQ_MODEL_COMPOUND = process.env.GROQ_MODEL_COMPOUND || GROQ_MODEL;

// Los gpt-oss son modelos de razonamiento: gastan tokens "pensando" antes de escribir.
// Con los max_tokens cortos del bot (60-150) el razonamiento se come el presupuesto
// entero y content vuelve vacio con finish_reason 'length'. Con effort 'low' el
// razonamiento baja a ~15 tokens, y ademas se le suma holgura al presupuesto.
const REASONING_HEADROOM = 64;
const isReasoningModel = (model) => /gpt-oss/i.test(model || '');

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
  params.model = params.model || GROQ_MODEL;
  if (isReasoningModel(params.model)) {
    params.reasoning_effort = params.reasoning_effort || 'low';
    if (params.max_tokens) params.max_tokens += REASONING_HEADROOM;
  }
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
  if (!msg) return '';
  let clean = msg.replace(/\*+/g, '').replace(/  +/g, ' ').trim();
  if (_emoteBeforeRe) clean = clean.replace(_emoteBeforeRe, '$1 $2');
  if (_emoteAfterRe)  clean = clean.replace(_emoteAfterRe,  '$1 $2');
  clean = clean.replace(/  +/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 3) + '...';
}

module.exports = { groqWithRetry, truncate, TWITCH_MAX_LENGTH, GROQ_MODEL, GROQ_MODEL_FAST, GROQ_MODEL_COMPOUND };
