// Router de IA: elige proveedor y modelo según el tipo de llamada, con cadenas de reserva.
//   aiChat(kind, params, opts)  → respuesta estilo OpenAI (choices[], usage) + result._ai = { provider, model, kind }
// params: messages, max_tokens, temperature, tools… (sin model ni penalties de Gemini: el adaptador los quita).
// opts: { maxRetries, maxDelayMs, timeoutMs, names }  (names: nicks extra a seudonimizar si va a Gemini)
//
// Reparto por defecto (ver logs/investigacion-ia.md, secciones 5 y 8). Se cambia con AI_CHAIN_<TIPO>=proveedor:modelo,…
//   groq (120b → reservas, nunca Gemini): mention, provocation, diosfua, trivia, quemeperdi, command
//   gemini (Flash Lite → Groq):           cohost, timer, hook, alert, reaction, endstream
//   review (Groq 20b → reservas → Flash Lite)
const logger = require('./logger');
const state = require('./state');
const chatlog = require('./chatlog');
const gemini = require('./ai-gemini');
const { pseudonymize, restoreResult } = require('./ai-pseudonym');
const groqUtils = require('./groq-utils');

const { GROQ_MODEL, GROQ_MODEL_FAST, GROQ_MODEL_COMPOUND, GROQ_MODEL_FALLBACKS, isReasoningModel, REASONING_HEADROOM } = groqUtils;

const GROUP = {
  mention: 'groq', provocation: 'groq', diosfua: 'groq', trivia: 'groq', quemeperdi: 'groq', command: 'groq',
  cohost: 'gemini', timer: 'gemini', hook: 'gemini', alert: 'gemini', reaction: 'gemini', endstream: 'gemini',
  review: 'review',
};
const PROVIDERS = new Set(['groq', 'gemini']);

const num = (name, def) => { const v = parseInt(process.env[name] || '', 10); return v > 0 ? v : def; };
const BLOCK_MAX_MS = 30 * 60 * 1000;     // tope de los bloqueos que no son por cupo diario de Gemini
const BLOCK_MINUTE_MS = 60 * 1000;
const BLOCK_DAILY_GROQ_MS = 10 * 60 * 1000;
const EST_CHARS_PER_TOKEN = 3.2;

const unique = list => [...new Set(list)];
const link = (provider, model) => ({ provider, model, key: `${provider}:${model}` });
const geminiModel = () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const hasGemini = () => !!process.env.GEMINI_API_KEY;

// "groq:openai/gpt-oss-120b,gemini:gemini-3.5-flash-lite" → [{ provider, model, key }]
function parseChain(text) {
  const out = [];
  for (const part of String(text || '').split(',').map(p => p.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const provider = i > 0 ? part.slice(0, i).trim().toLowerCase() : '';
    const model = i > 0 ? part.slice(i + 1).trim() : '';
    if (!PROVIDERS.has(provider) || !model) { logger.warn(`⚠️ AI_CHAIN: eslabón no válido "${part}" (se espera groq:modelo o gemini:modelo)`); continue; }
    out.push(link(provider, model));
  }
  return out;
}

function defaultChain(kind) {
  const groqMain = first => unique([first, GROQ_MODEL, ...GROQ_MODEL_FALLBACKS]).map(m => link('groq', m));
  const lite = link('gemini', geminiModel());
  switch (GROUP[kind]) {
    case 'gemini': return [lite, ...groqMain(GROQ_MODEL)];
    case 'review': return [...unique([GROQ_MODEL_FAST, ...GROQ_MODEL_FALLBACKS, GROQ_MODEL]).map(m => link('groq', m)), lite];
    default: return groqMain(kind === 'diosfua' ? GROQ_MODEL_COMPOUND : GROQ_MODEL);
  }
}

// Cadena efectiva: AI_CHAIN_<TIPO> o la de por defecto; sin GEMINI_API_KEY se quitan los eslabones de Gemini
function getChain(kind) {
  if (!GROUP[kind]) throw new Error(`Tipo de llamada de IA desconocido: ${kind}`);
  const custom = process.env[`AI_CHAIN_${kind.toUpperCase()}`];
  let chain = custom ? parseChain(custom) : [];
  if (!chain.length) chain = defaultChain(kind);
  chain = chain.filter(l => l.provider !== 'gemini' || hasGemini());
  return chain.length ? chain : defaultChain('mention');
}

// --- Errores: cuáles justifican pasar al siguiente eslabón y cuánto se bloquea el modelo ---
const isQuota = err => err?.status === 429;
const isServerError = err => [500, 502, 503, 504].includes(err?.status);
const isTimeout = err => err?.code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(`${err?.name || ''} ${err?.message || ''}`);
const isDaily = err => groqUtils.isDailyQuota(err);

function blockDuration(link_, err, now) {
  if (isQuota(err)) {
    if (link_.provider === 'gemini' && isDaily(err)) return state.msUntilPacificMidnight(now) + 60 * 1000;
    const wait = groqUtils.retryAfterMs(err) || (isDaily(err) ? BLOCK_DAILY_GROQ_MS : BLOCK_MINUTE_MS);
    return Math.min(wait, BLOCK_MAX_MS);
  }
  if (groqUtils.isModelGone(err)) return BLOCK_MAX_MS;
  return Math.min(num('AI_BLOCK_ERROR_MS', 3 * 60 * 1000), BLOCK_MAX_MS); // 5xx y timeouts
}
const shouldFallThrough = err => isQuota(err) || isServerError(err) || isTimeout(err) || groqUtils.isModelGone(err);

function blockLink(l, err, now = Date.now()) { state.blockAi(l.key, now + blockDuration(l, err, now)); }

// --- Presupuesto: saltar ANTES del 429 cuando el contador propio dice que no cabe ---
function overBudget(l, estTokens, now = Date.now()) {
  const minute = state.getAiMinuteUsage(l.key, now);
  if (l.provider === 'gemini') {
    return state.getAiDayUsage(l.key, now).requests >= num('AI_GEMINI_RPD_SOFT', 450) || minute.requests >= num('AI_GEMINI_RPM', 15) - 1;
  }
  return minute.requests >= Math.floor(num('AI_GROQ_RPM', 30) * 0.9) || minute.tokens + estTokens > num('AI_GROQ_TPM', 8000) * 0.85;
}

// Primero los que tienen hueco; luego los sin presupuesto; los bloqueados, como último recurso
function orderChain(chain, estTokens = 0, now = Date.now()) {
  const blocked = chain.filter(l => state.isAiBlocked(l.key, now));
  const open = chain.filter(l => !blocked.includes(l));
  return [...open.filter(l => !overBudget(l, estTokens, now)), ...open.filter(l => overBudget(l, estTokens, now)), ...blocked];
}

// --- Transportes (sustituibles en tests y en scripts/compare-models.js) ---
const transports = {
  groq: (p, { timeoutMs }) => groqUtils.groqCreate(p, { timeoutMs }),
  gemini: (p, { timeoutMs }) => gemini.create(p, { timeoutMs }),
};
function setTransport(provider, fn) { transports[provider] = fn; }

function buildRequest(l, params) {
  const { model: _ignored, ...rest } = params;
  if (l.provider === 'gemini') return gemini.buildBody(rest, l.model);
  const p = { ...rest, model: l.model };
  // Los parámetros de razonamiento dependen del modelo, no se arrastran a los de reserva
  if (isReasoningModel(l.model)) {
    p.reasoning_effort = rest.reasoning_effort || 'low';
    if (rest.max_tokens) p.max_tokens = rest.max_tokens + REASONING_HEADROOM;
  } else delete p.reasoning_effort;
  return p;
}

function timeoutFor(l, kind, opts) {
  if (opts.timeoutMs) return opts.timeoutMs;
  if (l.provider === 'gemini') return kind === 'endstream' ? num('AI_GEMINI_TIMEOUT_END_MS', 30000) : num('AI_GEMINI_TIMEOUT_MS', 15000);
  return num('AI_GROQ_TIMEOUT_MS', 20000);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Una petición a un eslabón. En el último, un 429 reintenta con espera (si no supera maxDelayMs)
async function attempt(l, params, { kind, maxRetries, maxDelayMs, timeoutMs, names }, hasNext) {
  let p = buildRequest(l, params);
  let aliasMap = null;
  if (l.provider === 'gemini') {
    // Los nicks no salen a Gemini: user1, user2… y se restauran en la respuesta
    const ps = pseudonymize(p.messages, unique([...state.getChatterNames(), ...(names || [])]));
    aliasMap = ps.map;
    p = { ...p, messages: ps.messages };
  }
  for (let n = 0; ; n++) {
    const est = Math.ceil(JSON.stringify(p.messages || []).length / EST_CHARS_PER_TOKEN) + (p.max_tokens || 100);
    const handle = state.startAiRequest(l.provider, l.model, est);
    const t0 = Date.now();
    try {
      const result = await transports[l.provider](p, { timeoutMs: timeoutFor(l, kind, { timeoutMs }) });
      state.finishAiRequest(handle, result?.usage);
      if (l.provider === 'groq') state.recordGroqTokens(l.model, result?.usage);
      chatlog.noteAiCall(l.model, Date.now() - t0);
      if (l.provider === 'groq') groqUtils.stripThinking(result);
      restoreResult(result, aliasMap);
      if (result && typeof result === 'object') result._ai = { provider: l.provider, model: l.model, kind };
      return result;
    } catch (err) {
      if (isQuota(err) && l.provider === 'groq') state.recordGroq429();
      if (isQuota(err) && !hasNext && n < maxRetries && !isDaily(err)) {
        const delay = groqUtils.retryAfterMs(err) || 2 ** n * 1000 + Math.random() * 500;
        if (delay <= maxDelayMs) { await sleep(delay); continue; }
      }
      throw err;
    }
  }
}

// Recorre la cadena: pasa al siguiente ante 429, 5xx, timeout o modelo retirado; otros errores (p. ej. 400) se lanzan
async function runChain(chain, kind, params, opts = {}) {
  const o = { kind, maxRetries: 2, maxDelayMs: Infinity, ...opts };
  const est = Math.ceil(JSON.stringify(params.messages || []).length / EST_CHARS_PER_TOKEN) + (params.max_tokens || 100);
  const ordered = orderChain(chain, est);
  let lastErr;
  for (let i = 0; i < ordered.length; i++) {
    const l = ordered[i];
    const hasNext = i < ordered.length - 1;
    try {
      const result = await attempt(l, params, o, hasNext);
      if (l.key !== chain[0].key) state.recordGroqFallback(chain[0].key, l.key);
      return result;
    } catch (err) {
      lastErr = err;
      if (!hasNext || !shouldFallThrough(err)) throw err;
      blockLink(l, err);
      const why = isQuota(err) ? `cupo ${isDaily(err) ? 'diario' : 'por minuto'} agotado` : groqUtils.isModelGone(err) ? 'modelo retirado' : isTimeout(err) ? 'timeout' : `error ${err.status}`;
      logger.warn(`⚠️ IA (${kind}): ${l.key} ${why}, probando ${ordered[i + 1].key}.`);
    }
  }
  throw lastErr;
}

function aiChat(kind, params, opts) { return runChain(getChain(kind), kind, params, opts); }

module.exports = { aiChat, runChain, getChain, defaultChain, parseChain, orderChain, overBudget, blockLink, blockDuration, setTransport, GROUP };
