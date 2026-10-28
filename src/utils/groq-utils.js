const Groq = require('groq-sdk');
const channelConfig = require('../../config/channel.json');
const logger = require('./logger');
const { recordGroqFallback } = require('./state');
const chatlog = require('./chatlog');

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

// Modelos de reserva (GROQ_MODEL_FALLBACKS, separados por comas) para cuando el
// modelo pedido ha sido retirado. Por defecto, el modelo rápido.
const GROQ_MODEL_FALLBACKS = (process.env.GROQ_MODEL_FALLBACKS || GROQ_MODEL_FAST)
  .split(',').map(m => m.trim()).filter(Boolean);

// 404 model_not_found / model_decommissioned: el modelo ya no existe en Groq
function isModelGone(err) {
  const text = `${err?.code || ''} ${err?.error?.error?.code || ''} ${err?.message || ''}`;
  return err?.status === 404 || /model_not_found|model_decommissioned|decommissioned/i.test(text);
}

function buildModelChain(model, fallbacks = GROQ_MODEL_FALLBACKS) {
  return [...new Set([model, ...fallbacks])];
}

async function requestWithRetry(create, params, maxRetries) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await create(params); }
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

async function runWithFallback(create, params, maxRetries = 2, fallbacks = GROQ_MODEL_FALLBACKS) {
  const requested = params.model || GROQ_MODEL;
  const chain = buildModelChain(requested, fallbacks);
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const p = { ...params, model };
    // Los parámetros de razonamiento dependen del modelo, no se arrastran al de reserva
    if (isReasoningModel(model)) {
      p.reasoning_effort = params.reasoning_effort || 'low';
      if (params.max_tokens) p.max_tokens = params.max_tokens + REASONING_HEADROOM;
    } else if (model !== requested) {
      delete p.reasoning_effort;
    }
    try {
      const t0 = Date.now();
      const result = await requestWithRetry(create, p, maxRetries);
      chatlog.noteAiCall(result?.model || model, Date.now() - t0);
      if (model !== requested) recordGroqFallback(requested, model);
      return result;
    } catch (err) {
      if (!isModelGone(err) || i === chain.length - 1) throw err;
      logger.warn(`⚠️ Groq: modelo ${model} retirado (${err.status || 'sin status'}), probando ${chain[i + 1]}. Actualiza GROQ_MODEL*.`);
      lastErr = err;
    }
  }
  throw lastErr;
}

function groqWithRetry(params, maxRetries = 2) {
  return runWithFallback(p => groq.chat.completions.create(p), params, maxRetries);
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

module.exports = { groqWithRetry, runWithFallback, isModelGone, buildModelChain, truncate, TWITCH_MAX_LENGTH, GROQ_MODEL, GROQ_MODEL_FAST, GROQ_MODEL_COMPOUND };
