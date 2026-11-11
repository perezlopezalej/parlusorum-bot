// Router de IA: elige el modelo de Groq según el tipo de llamada, con cadenas de reserva dentro de Groq.
//   aiChat(kind, params, opts)  → respuesta estilo OpenAI (choices[], usage) + result._ai = { provider, model, kind }
// params: messages, max_tokens, temperature, tools… (sin model: lo pone el eslabón)
// opts: { maxRetries, maxDelayMs, timeoutMs, names, generator }
//   names: nicks extra a seudonimizar; generator: modelo que generó el texto (solo 'pick': el selector es de otra familia)
//
// Reparto por defecto. Se cambia con AI_CHAIN_<TIPO>=groq:modelo,…
//   120b → 20b → qwen: los que necesitan más gracia (cohost, diosfua, quemeperdi)
//   20b → 120b → qwen:  menciones y provocaciones (mucho volumen, respuestas cortas)
//   qwen → 20b → 120b:  alert, timer, hook, endstream, trivia, command
//   Cada modelo tiene su cupo propio (8.000 tokens/min, 200.000/día): el reparto equilibra un directo de 6 horas (ver PROGRESS.md)
//   review (factcheck): 20b → reservas → 120b
//   pick (selector de candidatos): solo modelos de otra familia que el generador (gpt-oss ↔ qwen)
// Los nicks del chat salen a Groq como user1, user2… y se restauran en la respuesta (ai-pseudonym.js).
const logger = require('./logger');
const state = require('./state');
const chatlog = require('./chatlog');
const { pseudonymize, restoreResult } = require('./ai-pseudonym');
const groqUtils = require('./groq-utils');

const {
  GROQ_MODEL,
  GROQ_MODEL_FAST,
  GROQ_MODEL_LIGHT,
  GROQ_MODEL_PICK,
  GROQ_MODEL_COMPOUND,
  GROQ_MODEL_FALLBACKS,
  isReasoningModel,
  REASONING_HEADROOM,
} = groqUtils;

const GROUP = {
  diosfua: 'groq',
  quemeperdi: 'groq',
  cohost: 'groq',
  mention: 'mid',
  provocation: 'mid',
  timer: 'light',
  hook: 'light',
  alert: 'light',
  endstream: 'light',
  trivia: 'light',
  command: 'light',
  summary: 'light',
  review: 'review',
  pick: 'pick',
};
const PROVIDERS = new Set(['groq']);
// Tipos espontáneos: si el modelo principal no tiene cupo, el bot calla en vez de usar uno peor (y no espera a los 429).
// Lo que pide una persona (!dios_fua, menciones, comandos) conserva los modelos de reserva.
const SILENT_KINDS = new Set(['cohost', 'timer', 'hook', 'quemeperdi']);

class NoQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoQuotaError';
    this.code = 'NO_QUOTA';
  }
}

const num = (name, def) => {
  const v = parseInt(process.env[name] || '', 10);
  return v > 0 ? v : def;
};
const BLOCK_MAX_MS = 30 * 60 * 1000;
const BLOCK_MINUTE_MS = 60 * 1000;
const BLOCK_DAILY_GROQ_MS = 10 * 60 * 1000;
const EST_CHARS_PER_TOKEN = 3.2;

const unique = (list) => [...new Set(list)];
const link = (provider, model) => ({ provider, model, key: `${provider}:${model}` });

// Familia del modelo: gpt-oss (OpenAI) y qwen no comparten sesgos, por eso el selector no es de la del generador
const modelFamily = (model) =>
  /gpt-oss/i.test(model || '')
    ? 'gpt-oss'
    : /qwen/i.test(model || '')
      ? 'qwen'
      : String(model || '')
          .split(/[/:-]/)[0]
          .toLowerCase();

// "groq:openai/gpt-oss-120b,groq:qwen/qwen3.8-27b" → [{ provider, model, key }]
function parseChain(text) {
  const out = [];
  for (const part of String(text || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const i = part.indexOf(':');
    const provider = i > 0 ? part.slice(0, i).trim().toLowerCase() : '';
    const model = i > 0 ? part.slice(i + 1).trim() : '';
    if (!PROVIDERS.has(provider) || !model) {
      logger.warn(`⚠️ AI_CHAIN: eslabón no válido "${part}" (se espera groq:modelo)`);
      continue;
    }
    out.push(link(provider, model));
  }
  return out;
}

function defaultChain(kind, { generator } = {}) {
  const groq = (list) => unique(list).map((m) => link('groq', m));
  switch (GROUP[kind]) {
    case 'light':
      return groq([GROQ_MODEL_LIGHT, GROQ_MODEL_FAST, GROQ_MODEL, ...GROQ_MODEL_FALLBACKS]);
    case 'mid':
      return groq([GROQ_MODEL_FAST, GROQ_MODEL, GROQ_MODEL_LIGHT, ...GROQ_MODEL_FALLBACKS]);
    case 'review':
      return groq([GROQ_MODEL_FAST, ...GROQ_MODEL_FALLBACKS, GROQ_MODEL]);
    case 'pick':
      return groq([GROQ_MODEL_PICK, GROQ_MODEL_FAST, ...GROQ_MODEL_FALLBACKS, GROQ_MODEL]).filter(
        (l) => modelFamily(l.model) !== modelFamily(generator || GROQ_MODEL),
      );
    default:
      return groq([kind === 'diosfua' ? GROQ_MODEL_COMPOUND : GROQ_MODEL, GROQ_MODEL, ...GROQ_MODEL_FALLBACKS]);
  }
}

// Cadena efectiva: AI_CHAIN_<TIPO> o la de por defecto. En 'pick' nunca entra un modelo de la familia del generador
function getChain(kind, { generator } = {}) {
  if (!GROUP[kind]) throw new Error(`Tipo de llamada de IA desconocido: ${kind}`);
  const custom = process.env[`AI_CHAIN_${kind.toUpperCase()}`];
  let chain = custom ? parseChain(custom) : [];
  if (!chain.length) chain = defaultChain(kind, { generator });
  if (kind === 'pick') return chain.filter((l) => modelFamily(l.model) !== modelFamily(generator || GROQ_MODEL));
  return chain.length ? chain : defaultChain('mention');
}

// --- Errores: cuáles justifican pasar al siguiente eslabón y cuánto se bloquea el modelo ---
const isQuota = (err) => err?.status === 429;
const isServerError = (err) => [500, 502, 503, 504].includes(err?.status);
const isTimeout = (err) =>
  err?.code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(`${err?.name || ''} ${err?.message || ''}`);
const isDaily = (err) => groqUtils.isDailyQuota(err);

function blockDuration(_link, err) {
  if (isQuota(err)) {
    const wait = groqUtils.retryAfterMs(err) || (isDaily(err) ? BLOCK_DAILY_GROQ_MS : BLOCK_MINUTE_MS);
    return Math.min(wait, BLOCK_MAX_MS);
  }
  if (groqUtils.isModelGone(err)) return BLOCK_MAX_MS;
  return Math.min(num('AI_BLOCK_ERROR_MS', 3 * 60 * 1000), BLOCK_MAX_MS); // 5xx y timeouts
}
const shouldFallThrough = (err) => isQuota(err) || isServerError(err) || isTimeout(err) || groqUtils.isModelGone(err);

function blockLink(l, err, now = Date.now()) {
  state.blockAi(l.key, now + blockDuration(l, err));
}

// --- Presupuesto: saltar ANTES del 429 cuando el contador propio dice que no cabe ---
function overBudget(l, estTokens, now = Date.now()) {
  const minute = state.getAiMinuteUsage(l.key, now);
  if (
    minute.requests >= Math.floor(num('AI_GROQ_RPM', 30) * 0.9) ||
    minute.tokens + estTokens > num('AI_GROQ_TPM', 8000) * 0.85
  )
    return true;
  // Cupo real que dijo Groq en la última respuesta (x-ratelimit-remaining-*), mientras siga vigente
  const real = state.getGroqLimits(l.key, now);
  return (
    !!real &&
    ((real.remainingTokens !== undefined && real.remainingTokens < estTokens) ||
      (real.remainingRequests !== undefined && real.remainingRequests < 1))
  );
}

// Primero los que tienen hueco; luego los sin presupuesto; los bloqueados, como último recurso
function orderChain(chain, estTokens = 0, now = Date.now()) {
  const blocked = chain.filter((l) => state.isAiBlocked(l.key, now));
  const open = chain.filter((l) => !blocked.includes(l));
  return [
    ...open.filter((l) => !overBudget(l, estTokens, now)),
    ...open.filter((l) => overBudget(l, estTokens, now)),
    ...blocked,
  ];
}

// --- Transporte (sustituible en tests y en scripts/compare-models.js) ---
const transports = {
  groq: (p, { timeoutMs }) => groqUtils.groqCreate(p, { timeoutMs }),
};
function setTransport(provider, fn) {
  transports[provider] = fn;
}

function buildRequest(l, params) {
  const { model: _ignored, ...rest } = params;
  const p = { ...rest, model: l.model };
  // Los parámetros de razonamiento dependen del modelo, no se arrastran a los de reserva
  if (isReasoningModel(l.model)) {
    p.reasoning_effort = rest.reasoning_effort || 'low';
    if (rest.max_tokens) p.max_tokens = rest.max_tokens + REASONING_HEADROOM;
  } else delete p.reasoning_effort;
  return p;
}

const timeoutFor = (opts) => opts.timeoutMs || num('AI_GROQ_TIMEOUT_MS', 20000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera ante un 429: la que pide Groq (retry-after) o un retroceso exponencial, siempre con algo de aleatoriedad
// para que varias peticiones que fallaron a la vez no reintenten juntas. rng inyectable para tests.
function backoffMs(n, err, rng = Math.random) {
  const asked = groqUtils.retryAfterMs(err);
  if (asked) return asked + Math.round(rng() * 500);
  const cap = Math.min(2 ** n * 1000, 8000);
  return Math.round(cap / 2 + rng() * (cap / 2));
}

// Una petición a un eslabón. En el último, un 429 reintenta con espera (si no supera maxDelayMs)
async function attempt(l, params, { kind, maxRetries, maxDelayMs, timeoutMs, names, noWait }, hasNext) {
  let p = buildRequest(l, params);
  // Los nicks no salen en el prompt: user1, user2… y se restauran en la respuesta
  const ps = pseudonymize(p.messages, unique([...state.getChatterNames(), ...(names || [])]));
  const aliasMap = ps.map;
  p = { ...p, messages: ps.messages };
  for (let n = 0; ; n++) {
    const est = Math.ceil(JSON.stringify(p.messages || []).length / EST_CHARS_PER_TOKEN) + (p.max_tokens || 100);
    const handle = state.startAiRequest(l.provider, l.model, est);
    const t0 = Date.now();
    try {
      const result = await transports[l.provider](p, {
        timeoutMs: timeoutFor({ timeoutMs }),
        onHeaders: (h) => state.noteGroqLimits(l.key, groqUtils.parseRateHeaders(h)),
      });
      state.finishAiRequest(handle, result?.usage);
      state.recordGroqTokens(l.model, result?.usage);
      chatlog.noteAiCall(l.model, Date.now() - t0);
      groqUtils.stripThinking(result);
      restoreResult(result, aliasMap);
      if (result && typeof result === 'object') result._ai = { provider: l.provider, model: l.model, kind };
      return result;
    } catch (err) {
      if (isQuota(err)) state.recordGroq429();
      if (err?.headers) state.noteGroqLimits(l.key, groqUtils.parseRateHeaders(err.headers));
      if (isQuota(err) && !hasNext && !noWait && n < maxRetries && !isDaily(err)) {
        const delay = backoffMs(n, err);
        if (delay <= maxDelayMs) {
          await sleep(delay);
          continue;
        }
      }
      throw err;
    }
  }
}

// Recorre la cadena: pasa al siguiente ante 429, 5xx, timeout o modelo retirado; otros errores (p. ej. 400) se lanzan
async function runChain(chain, kind, params, opts = {}) {
  const o = { kind, maxRetries: 2, maxDelayMs: Infinity, ...opts };
  const est =
    Math.ceil(JSON.stringify(params.messages || []).length / EST_CHARS_PER_TOKEN) + (params.max_tokens || 100);
  const silent = SILENT_KINDS.has(kind);
  if (silent) {
    // Espontáneo: solo el modelo principal; sin cupo (bloqueado o sin presupuesto) se calla en vez de bajar de modelo
    const first = chain[0];
    if (state.isAiBlocked(first.key) || overBudget(first, est))
      throw new NoQuotaError(`Sin cupo en ${first.key} para ${kind}: se calla`);
    o.noWait = true;
  }
  const ordered = silent ? [chain[0], ...chain.slice(1)] : orderChain(chain, est);
  if (!ordered.length) throw new Error(`Sin modelo disponible para ${kind}`);
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
      // Espontáneo: solo un modelo retirado (404) justifica pasar al siguiente; un 429, 5xx o timeout lo deja callado
      if (!hasNext || !shouldFallThrough(err) || (silent && !groqUtils.isModelGone(err))) {
        if (silent && shouldFallThrough(err)) blockLink(l, err);
        throw err;
      }
      blockLink(l, err);
      const why = isQuota(err)
        ? `cupo ${isDaily(err) ? 'diario' : 'por minuto'} agotado`
        : groqUtils.isModelGone(err)
          ? 'modelo retirado'
          : isTimeout(err)
            ? 'timeout'
            : `error ${err.status}`;
      logger.warn(`⚠️ IA (${kind}): ${l.key} ${why}, probando ${ordered[i + 1].key}.`);
    }
  }
  throw lastErr;
}

function aiChat(kind, params, opts) {
  return runChain(getChain(kind, opts), kind, params, opts);
}

module.exports = {
  aiChat,
  runChain,
  getChain,
  backoffMs,
  NoQuotaError,
  SILENT_KINDS,
  defaultChain,
  parseChain,
  orderChain,
  overBudget,
  blockLink,
  blockDuration,
  setTransport,
  modelFamily,
  GROUP,
};
