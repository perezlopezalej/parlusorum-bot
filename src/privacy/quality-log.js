/**
 * privacy/quality-log.js — Registro de calidad de 30 días, generado al acabar cada stream.
 *
 * Reemplaza al chat completo (que solo vive 24 h): guarda los mensajes del bot con unas líneas de
 * contexto antes y después (a qué respondía y cómo reaccionó el chat), con los nicks seudonimizados
 * de forma consistente dentro del stream (usuario1, usuario2…) y las métricas del stream.
 *
 * No guarda nicks ni user_id: cada entrada lleva `user_keys`, un HMAC de los participantes, para
 * poder borrarlas con !fua_olvidame sin conservar el id. Olvidar a alguien borra la entrada completa.
 *
 * buildQualityLog() es puro (sin E/S); persistStream() y catchUp() hablan con Supabase.
 */
const crypto = require('crypto');
const reactions = require('../ai/reactions');
const { excludedNames } = require('../utils/ai-pseudonym');
const logger = require('../utils/logger');

const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 3;
const MIN_NAME_LEN = 3;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── claves de borrado ───────────────────────────────────────────────────────

function secretKey() {
  return process.env.EVENTSUB_SECRET || 'sin-secreto';
}

// HMAC estable del usuario. Con user_id usa el id; sin él (filas antiguas) usa el nick en minúsculas.
function userKey({ userId, username }, secret = secretKey()) {
  const basis = userId ? `id:${userId}` : `nick:${String(username || '').toLowerCase()}`;
  return crypto.createHmac('sha256', secret).update(`quality-log:${basis}`).digest('hex').slice(0, 32);
}

// Todas las claves con las que pudo guardarse a un usuario (por id y por nick)
function userKeysFor({ userId, login }, secret = secretKey()) {
  const keys = new Set();
  if (userId) keys.add(userKey({ userId }, secret));
  if (login) keys.add(userKey({ username: login }, secret));
  return [...keys];
}

// ─── seudónimos ──────────────────────────────────────────────────────────────

// Mapa nick → usuarioN por orden de aparición; streamers, mods, bot y canal no se tocan
function makePseudonymizer(rows, { exclude = excludedNames() } = {}) {
  const aliases = new Map();
  const isExcluded = (n) => exclude.has(n);
  const aliasOf = (nick) => {
    const key = String(nick || '')
      .replace(/^@/, '')
      .toLowerCase();
    if (!key || isExcluded(key)) return key;
    if (!aliases.has(key)) aliases.set(key, `usuario${aliases.size + 1}`);
    return aliases.get(key);
  };
  // Primero los emisores, por orden de aparición: el mismo nick es siempre el mismo usuarioN en todo el stream
  for (const r of rows) if (!r.is_bot) aliasOf(r.username);
  for (const r of rows) if (!r.is_bot && r.reply_parent_login) aliasOf(r.reply_parent_login);

  const text = (value) => {
    let out = String(value ?? '');
    // 1) @menciones de cualquier nick (conocido o no)
    out = out.replace(/@(\w{2,25})/g, (found, nick) => (isExcluded(nick.toLowerCase()) ? found : `@${aliasOf(nick)}`));
    // 2) nick suelto de quien escribió (≥3 letras: con menos se rompería el texto)
    const known = [...aliases.keys()].filter((n) => n.length >= MIN_NAME_LEN).sort((a, b) => b.length - a.length);
    if (known.length) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_@])(?:${known.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
      out = out.replace(re, (found) => aliases.get(found.toLowerCase()) || found);
    }
    return out;
  };
  return { aliasOf, text, aliases };
}

// ─── construcción (pura) ─────────────────────────────────────────────────────

const timeOf = (r) => new Date(r.created_at).getTime();

// Une rangos [a, b] que se solapan o se tocan
function mergeRanges(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function buildQualityLog(
  rows,
  {
    botName = 'dios_fua',
    exclude,
    secret,
    metrics = null,
    report = null,
    before = CONTEXT_BEFORE,
    after = CONTEXT_AFTER,
  } = {},
) {
  const sorted = [...(rows || [])].filter((r) => Number.isFinite(timeOf(r))).sort((a, b) => timeOf(a) - timeOf(b));
  const scoring = reactions.scoreSession(sorted, { botName });
  const scoreByRow = new Map(scoring.scored.map((s) => [s.row, s]));
  const pseudo = makePseudonymizer(sorted, { exclude });

  const botIdx = sorted.map((r, i) => (r.is_bot ? i : -1)).filter((i) => i >= 0);
  const windows = mergeRanges(botIdx.map((i) => [Math.max(0, i - before), Math.min(sorted.length - 1, i + after)]));

  const lineOf = (row) => {
    const t = new Date(row.created_at).toISOString().slice(11, 19);
    if (!row.is_bot) {
      const line = { t, who: pseudo.aliasOf(row.username), text: pseudo.text(row.message) };
      if (row.reply_parent_login) line.reply_to = pseudo.aliasOf(row.reply_parent_login);
      return line;
    }
    const line = { t, who: 'bot', text: pseudo.text(row.message), origin: row.origin || 'otro' };
    if (row.model) line.model = row.model;
    if (Number.isFinite(row.latency_ms)) line.latency_ms = row.latency_ms;
    const s = scoreByRow.get(row);
    if (s) {
      line.reaction = {
        positive: s.positive,
        negative: s.negative,
        ignored: s.ignored,
        score: s.score,
        reactors: s.reactors.length,
        laughs: s.laughUsers.length,
      };
    }
    return line;
  };

  const entries = windows.map(([a, b]) => {
    const slice = sorted.slice(a, b + 1);
    const keys = new Set();
    for (const r of slice) if (!r.is_bot) keys.add(userKey({ userId: r.user_id, username: r.username }, secret));
    return { payload: { lines: slice.map(lineOf) }, user_keys: [...keys] };
  });

  const sum = reactions.summarize(scoring);
  const speakers = new Set(sorted.filter((r) => !r.is_bot).map((r) => String(r.username).toLowerCase()));
  const summary = {
    payload: {
      chat_messages: sorted.filter((r) => !r.is_bot).length,
      bot_messages: botIdx.length,
      speakers: speakers.size,
      reactions: {
        total: sum.total,
        positive: sum.positive,
        reacted: sum.reacted,
        negative: sum.negative,
        ignored: sum.ignored,
        baseline: sum.baseline,
        byOrigin: sum.byOrigin,
        liked: sum.best.map((b) => ({ origin: b.origin, text: pseudo.text(b.message), score: b.score })),
      },
      metrics: metrics || null,
      report: report ? pseudo.text(report) : null,
    },
    user_keys: [],
  };
  return { entries, summary };
}

// Texto legible del registro (filas de quality_log) para `npm run chatlog`
function formatQualityLog(rows) {
  const out = [];
  const summary = rows.filter((r) => r.kind === 'summary');
  const entries = rows.filter((r) => r.kind === 'entry');
  for (const r of summary) {
    out.push('=== RESUMEN DEL STREAM ===');
    out.push(JSON.stringify(r.payload, null, 2));
    out.push('');
  }
  entries.forEach((r, i) => {
    out.push(`--- entrada ${i + 1} ---`);
    for (const l of r.payload?.lines || []) {
      const tag = l.who === 'bot' ? ` [${l.origin || 'otro'}${l.model ? ' ' + l.model : ''}]` : '';
      const re = l.reaction
        ? ` {${l.reaction.negative ? 'mal' : l.reaction.positive ? 'bien' : l.reaction.ignored ? 'ignorado' : 'neutro'}, ${l.reaction.reactors} reacciones}`
        : '';
      out.push(`${l.t} ${l.who}${tag}: ${String(l.text).replace(/\r?\n/g, ' ')}${re}`);
    }
    out.push('');
  });
  return out.join('\n');
}

// ─── persistencia ────────────────────────────────────────────────────────────

const streamDate = (rows) => {
  const first = (rows || [])
    .map(timeOf)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return new Date(first ?? Date.now()).toISOString().slice(0, 10);
};

// Guarda el registro de un stream (entradas + resumen). Devuelve cuántas filas guardó.
async function persistStream({
  sessionId,
  rows,
  metrics = null,
  report = null,
  botName,
  db = require('../utils/supabase'),
}) {
  const built = buildQualityLog(rows, { botName, metrics, report });
  const date = streamDate(rows);
  const toRow = (kind, x) => ({
    session_id: sessionId ?? null,
    stream_date: date,
    kind,
    payload: x.payload,
    user_keys: x.user_keys,
  });
  const out = [...built.entries.map((e) => toRow('entry', e)), toRow('summary', built.summary)];
  await db.insertQualityLog(out);
  return out.length;
}

// Antes de borrar el chat de 24 h: genera el registro de las sesiones que aún no lo tienen
// (p. ej. el bot estuvo caído al acabar el stream). Lanza si no puede, para que el chat no se borre.
async function catchUp({
  now = Date.now(),
  db = require('../utils/supabase'),
  botName = process.env.BOT_USERNAME || 'dios_fua',
} = {}) {
  const olderThan = new Date(now - 18 * 60 * 60 * 1000).toISOString();
  const sessions = await db.getSessionsWithoutQualityLog(olderThan);
  let done = 0;
  for (const sessionId of sessions) {
    const rows = await db.getSessionChatLog(sessionId);
    if (!rows.length) continue;
    await persistStream({ sessionId, rows, botName, db });
    done++;
    logger.info(`📝 Registro de calidad recuperado para la sesión ${sessionId}`);
  }
  return done;
}

module.exports = {
  formatQualityLog,
  buildQualityLog,
  makePseudonymizer,
  userKey,
  userKeysFor,
  persistStream,
  catchUp,
  mergeRanges,
  CONTEXT_BEFORE,
  CONTEXT_AFTER,
};
