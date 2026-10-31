/**
 * self-review.js — Autorrevisión del bot al acabar el stream (solo para revisión humana).
 * El código mide reacciones y marca sospechosos (repeticiones, datos del juego, ignorados, negativos);
 * la IA solo redacta un informe breve sobre esos mensajes. Va a Supabase (bot_self_reviews) y al log, nunca al chat ni al prompt.
 */

const quality = require('./quality');
const reactions = require('./reactions');
const logger = require('../utils/logger');

const MAX_FLAGGED = 12;
const MAX_REPORT_CHARS = 800;

// Mensajes sospechosos con el motivo. scored viene de reactions.scoreSession.
function flagMessages(scored) {
  const flagged = [];
  const previous = [];
  for (const s of scored) {
    const text = String(s.row.message || '');
    const reasons = [];
    if (previous.length && quality.tooSimilar(text, previous.slice(-8))) reasons.push('repetición');
    if (quality.mentionsMechanics(text) || quality.claimsEnemyKills(text)) reasons.push('posible dato inventado del juego');
    if (s.negative) reasons.push(`reacción negativa (${s.negUsers.join(', ')})`);
    else if (s.ignored) reasons.push('ignorado');
    previous.push(text);
    if (reasons.length) flagged.push({ origin: s.row.origin, message: text.slice(0, 200), reasons });
  }
  // Primero lo más grave: negativos e inventos antes que ignorados
  const weight = f => (f.reasons.some(r => r.startsWith('reacción')) ? 0 : f.reasons.some(r => r.startsWith('posible')) ? 1 : f.reasons.includes('repetición') ? 2 : 3);
  return flagged.sort((a, b) => weight(a) - weight(b)).slice(0, MAX_FLAGGED);
}

async function writeReport(flagged, summary) {
  const { groqWithRetry, GROQ_MODEL_FAST } = require('../utils/groq-utils'); // lazy: el cliente Groq exige GROQ_API_KEY al cargarse
  if (!flagged.length) return 'Sin mensajes sospechosos en este stream.';
  const list = flagged.map((f, i) => `${i + 1}. [${f.origin}] "${f.message}" → ${f.reasons.join('; ')}`).join('\n');
  const prompt = `Revisas los mensajes de un bot de Twitch (dios_fua) tras un stream, para que lo lea una persona.
Cifras: ${reactions.formatSummary(summary)}
Mensajes marcados por el código:
${list}

Redacta en español un informe de como máximo 6 líneas: qué se repite, qué parece inventado y qué cayó mal o fue ignorado, con una mejora concreta. Usa solo estos mensajes; no inventes otros.`;
  const response = await groqWithRetry({ model: GROQ_MODEL_FAST, max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  return (response.choices[0].message.content || '').trim().slice(0, MAX_REPORT_CHARS);
}

// Nunca lanza: una autorrevisión fallida no puede afectar al bot
async function reviewStream({ sessionId, botName = process.env.BOT_USERNAME || 'dios_fua' } = {}) {
  try {
    const { getSessionChatLog, saveSelfReview } = require('../utils/supabase');
    if (!sessionId) return null;
    const rows = await getSessionChatLog(sessionId);
    if (!rows.length) { logger.info('📊 Autorrevisión: sin chat registrado en la sesión'); return null; }

    const result = reactions.scoreSession(rows, { botName });
    const summary = reactions.summarize(result);
    logger.info(`📊 ${reactions.formatSummary(summary)}`);

    const flagged = flagMessages(result.scored);
    let report;
    try {
      report = await writeReport(flagged, summary);
    } catch (e) {
      logger.warn(`Autorrevisión: informe IA fallido: ${e.message}`);
      report = `(sin informe IA) ${flagged.length} mensajes marcados: ${flagged.map(f => `"${f.message.slice(0, 50)}" ${f.reasons.join('/')}`).join(' | ')}`.slice(0, MAX_REPORT_CHARS);
    }
    logger.info(`📝 Autorrevisión del bot: ${report.replace(/\s*\n\s*/g, ' / ')}`);
    await saveSelfReview({ sessionId, stats: { ...summary, flagged: flagged.length }, report });
    return { summary, flagged, report };
  } catch (e) {
    logger.warn(`Autorrevisión: ${e.message}`);
    return null;
  }
}

module.exports = { flagMessages, reviewStream };
