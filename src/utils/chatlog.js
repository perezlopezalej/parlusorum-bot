/**
 * chatlog.js — Registro del chat en Supabase (tabla chat_log)
 *
 * Los mensajes se acumulan en memoria (state.js) y se vuelcan por lotes cada
 * FLUSH_INTERVAL_MS o al llegar a FLUSH_BATCH. Un fallo de Supabase nunca
 * llega al bot: el lote vuelve a la cola (con tope) y se reintenta.
 *
 * El origen de cada mensaje del bot (dios_fua, cohost, hook...) viaja en un
 * AsyncLocalStorage: quien dispara la acción abre un contexto con runWithOrigin()
 * y client.say() lo recoge sin que cada llamada tenga que pasarlo.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const logger = require('./logger');
const { pushChatLog, takeChatLog, requeueChatLog, getChatLogSize } = require('./state');

const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_BATCH = 50;
const RETENTION_DAYS = 60;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LEN = 500;

const als = new AsyncLocalStorage();

// ─── Contexto de origen ──────────────────────────────────────────────────────

// Ejecuta fn con un contexto nuevo; los say() hechos dentro (también tras await/timers) lo heredan
function runWithOrigin(origin, fn) {
  return als.run({ origin, model: null, usedTool: false, latencyMs: 0, aiCalls: 0 }, fn);
}

// Envuelve fn para que cada llamada (intervalos, callbacks) abra su propio contexto
function withOrigin(origin, fn) {
  return (...args) => runWithOrigin(origin, () => fn(...args));
}

// groq-utils anota cada petición: el modelo que respondió y la latencia acumulada
function noteAiCall(model, latencyMs) {
  const s = als.getStore();
  if (!s) return;
  s.model = model || s.model;
  s.latencyMs += Math.max(0, Math.round(latencyMs || 0));
  s.aiCalls++;
}

function noteTool(name) {
  const s = als.getStore();
  if (s && name === 'buscar_juego') s.usedTool = true;
}

// Metadatos del contexto actual, fusionados con los explícitos (estos ganan)
function currentMeta(explicit = {}) {
  const s = als.getStore();
  return {
    origin: explicit.origin || s?.origin || 'otro',
    model: explicit.model ?? s?.model ?? null,
    usedTool: explicit.usedTool ?? s?.usedTool ?? false,
    latencyMs: explicit.latencyMs ?? (s?.aiCalls ? s.latencyMs : null),
  };
}

// ─── Funciones puras ─────────────────────────────────────────────────────────

function buildRow({ username, message, isBot = false, origin = null, model = null, usedTool = false, latencyMs = null, sessionId = null, at = new Date() }) {
  return {
    created_at: at.toISOString(),
    session_id: sessionId ?? null,
    username: String(username || '?').slice(0, 50),
    message: String(message ?? '').slice(0, MAX_MESSAGE_LEN),
    is_bot: !!isBot,
    origin: isBot ? (origin || 'otro') : null,
    model: isBot ? (model || null) : null,
    used_buscar_juego: isBot && !!usedTool,
    latency_ms: isBot && Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
  };
}

const pad2 = n => String(n).padStart(2, '0');

// Fecha local AAAA-MM-DD
function localDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "HH:MM:SS  usuario: mensaje" y, si es del bot, "[origen]" tras el usuario
function formatLine(row) {
  const d = new Date(row.created_at);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const tag = row.is_bot ? ` [${row.origin || 'otro'}]` : '';
  return `${time} ${row.username}${tag}: ${String(row.message).replace(/\r?\n/g, ' ')}`;
}

function formatChat(rows) {
  return rows.map(formatLine).join('\n') + (rows.length ? '\n' : '');
}

// Día local AAAA-MM-DD → [desde, hasta) en ISO; null si la fecha no es válida
function dayRange(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const from = new Date(y, mo - 1, d);
  if (from.getFullYear() !== y || from.getMonth() !== mo - 1 || from.getDate() !== d) return null;
  const to = new Date(y, mo - 1, d + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function retentionCutoff(now = Date.now(), days = RETENTION_DAYS) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Escritura por lotes ─────────────────────────────────────────────────────

let timer = null;
let flushing = false;
let lastWarnAt = 0;

function isEnabled() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
}

function currentSessionId() {
  try { return require('./supabase').getCurrentSessionId(); } catch { return null; }
}

function enqueue(row) {
  if (!isEnabled()) return;
  try {
    if (pushChatLog(row) >= FLUSH_BATCH) flush().catch(() => {});
  } catch (e) {
    logger.warn(`chatlog: no se pudo encolar: ${e.message}`);
  }
}

// Nunca lanzan: el registro no puede afectar al flujo del chat
function logUserMessage(username, message) {
  try { enqueue(buildRow({ username, message, sessionId: currentSessionId() })); } catch { /* ignorado */ }
}

function logBotMessage(username, message, explicit) {
  try {
    enqueue(buildRow({ username, message, isBot: true, ...currentMeta(explicit), sessionId: currentSessionId() }));
  } catch { /* ignorado */ }
}

async function flush() {
  if (flushing || getChatLogSize() === 0) return;
  flushing = true;
  try {
    while (getChatLogSize() > 0) {
      const batch = takeChatLog(FLUSH_BATCH);
      try {
        await require('./supabase').insertChatLog(batch);
      } catch (e) {
        requeueChatLog(batch);
        // Un aviso cada 5 min como mucho, para no inundar el log si Supabase cae
        if (Date.now() - lastWarnAt > 5 * 60 * 1000) {
          lastWarnAt = Date.now();
          logger.warn(`chatlog: lote no guardado (${batch.length} msgs, se reintentará): ${e.message}`);
        }
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

async function purgeOld() {
  if (!isEnabled()) return;
  try {
    const n = await require('./supabase').deleteChatLogBefore(retentionCutoff());
    if (n > 0) logger.info(`chatlog: ${n} filas de más de ${RETENTION_DAYS} días borradas`);
  } catch (e) {
    logger.warn(`chatlog: no se pudo purgar: ${e.message}`);
  }
}

function start() {
  if (timer || !isEnabled()) return;
  timer = setInterval(() => flush().catch(() => {}), FLUSH_INTERVAL_MS);
  timer.unref?.();
  purgeOld();
  setInterval(purgeOld, PURGE_INTERVAL_MS).unref?.();
  logger.info(`📝 Registro de chat activo (lotes cada ${FLUSH_INTERVAL_MS / 1000}s o ${FLUSH_BATCH} msgs, retención ${RETENTION_DAYS} días)`);
}

module.exports = {
  runWithOrigin, withOrigin, noteAiCall, noteTool, currentMeta,
  logUserMessage, logBotMessage, flush, purgeOld, start,
  buildRow, formatLine, formatChat, dayRange, retentionCutoff, localDateStr,
  FLUSH_BATCH, RETENTION_DAYS,
};
