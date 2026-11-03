const Groq = require('groq-sdk');
const channelConfig = require('../../config/channel.json');
const { cutAtSentence } = require('../ai/quality');

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

// Modelos de reserva (GROQ_MODEL_FALLBACKS, separados por comas). Por defecto, el modelo rápido.
// Las cadenas por tipo de llamada y el reparto con Gemini viven en ai-router.js.
const GROQ_MODEL_FALLBACKS = (process.env.GROQ_MODEL_FALLBACKS || GROQ_MODEL_FAST)
  .split(',').map(m => m.trim()).filter(Boolean);

// Petición única al SDK: los reintentos y el salto de modelo los decide el router, no el SDK
function groqCreate(params, { timeoutMs = 20000 } = {}) {
  return groq.chat.completions.create(params, { timeout: timeoutMs, maxRetries: 0 });
}

// 404 model_not_found / model_decommissioned: el modelo ya no existe en Groq
function isModelGone(err) {
  const text = `${err?.code || ''} ${err?.error?.error?.code || ''} ${err?.message || ''}`;
  return err?.status === 404 || /model_not_found|model_decommissioned|decommissioned/i.test(text);
}

function retryAfterMs(err) {
  const sec = parseInt(err?.headers?.['retry-after'] || '0', 10);
  return sec > 0 ? sec * 1000 : 0;
}

// Cupo diario (tokens/peticiones por día) en vez del de por minuto: el mensaje del proveedor lo dice, o la espera pedida es larga
function isDailyQuota(err) {
  return /per ?day|TPD|RPD/i.test(`${err?.message || ''} ${err?.error?.error?.message || ''}`) || retryAfterMs(err) > 120000;
}

// Modelos con razonamiento visible (qwen...) devuelven <think>…</think> dentro del contenido: fuera del chat
function stripThinking(result) {
  for (const c of result?.choices || []) {
    if (typeof c?.message?.content === 'string' && c.message.content.includes('</think>')) {
      c.message.content = c.message.content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
    }
  }
  return result;
}

function truncate(msg, limit = TWITCH_MAX_LENGTH) {
  if (!msg) return '';
  let clean = msg.replace(/\*+/g, '').replace(/  +/g, ' ').trim();
  if (_emoteBeforeRe) clean = clean.replace(_emoteBeforeRe, '$1 $2');
  if (_emoteAfterRe)  clean = clean.replace(_emoteAfterRe,  '$1 $2');
  clean = clean.replace(/  +/g, ' ').trim();
  return cutAtSentence(clean, limit);
}

module.exports = { groqCreate, isModelGone, isDailyQuota, retryAfterMs, stripThinking, truncate, isReasoningModel, REASONING_HEADROOM, TWITCH_MAX_LENGTH, GROQ_MODEL, GROQ_MODEL_FAST, GROQ_MODEL_COMPOUND, GROQ_MODEL_FALLBACKS };
