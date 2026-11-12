/**
 * memory/handler.js — Memoria del canal entre streams
 * Al acabar cada stream genera un resumen con IA y lo guarda en Supabase.
 * Al arrancar el siguiente stream, inyecta ese historial en el prompt.
 */

const channelConfig = require('../../config/channel.json');
const { saveStreamMemory, getRecentStreamMemory, endStreamSession } = require('../utils/supabase');
const logger = require('../utils/logger');
const quality = require('../ai/quality');
const { buildSummaryPrompt, retryNote } = require('../ai/style');
const { containsBlockedContent } = require('../utils/filter');
const { aiChat } = require('../utils/ai-router');
const { onStreamEndLore } = require('../lore/handler');
const { scrubNicks, nicksFromChatSample } = require('../privacy/names');

// Motivo de rechazo del resumen (null si vale): vacío, negativo, muertes como logro, género a ParLusorum, vida personal o texto basura
function summaryProblem(text) {
  if (!text) return 'vacío';
  if (quality.negativeSummary(text)) return 'es negativo; el resumen siempre va en positivo';
  if (quality.achievesDeaths(text)) return 'presenta las muertes como un logro; son caídas del streamer';
  if (quality.genderedParlusorum(text)) return 'pone género a ParLusorum';
  if (quality.fuaGender(text)) return '"el FUA" va siempre en masculino';
  if (quality.mentionsEthnicTerms(text)) return 'usa una expresión con etnias o pueblos; cuéntalo sin ellas';
  if (quality.summaryPersonalLife(text))
    return 'habla de vida personal o charla ajena al stream (comida, clima, calor...); habla solo del juego, el stream y el ambiente del chat';
  const junk = quality.junkProblem(text, { minWords: 1 });
  if (junk) return junk.reason;
  return null;
}

// ─── GENERAR RESUMEN AL ACABAR EL STREAM ─────────────────────────────────────

async function generateStreamMemory(streamStats, chatSample) {
  try {
    const { game, durationMinutes, deathCount, peakViewers, topCommands } = streamStats;

    const prompt = buildSummaryPrompt({
      streamer: channelConfig.streamer,
      game,
      durationMinutes,
      deathCount,
      peakViewers,
      topCommands,
      chatSample,
    });

    // Hasta 2 intentos: si el resumen habla de vida personal, es negativo o está mal, el segundo recibe el motivo
    let parsed = {};
    let summary = '';
    let feedback = '';
    for (let attempt = 0; attempt < 2 && !summary; attempt++) {
      const response = await aiChat('endstream', {
        max_tokens: 300,
        messages: [{ role: 'user', content: `${prompt}${retryNote(feedback)}` }],
      });

      const text = response.choices[0].message.content.trim();
      // Limpiar posibles backticks de markdown
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);

      const rawSummary = String(parsed.summary || '').trim();
      const problem = summaryProblem(rawSummary);
      if (problem) {
        feedback = problem;
        logger.info(`Resumen de fin de stream descartado (${problem}): ${rawSummary.slice(0, 80)}`);
        continue;
      }
      summary = rawSummary;
    }
    if (!summary) summary = quality.positiveSummaryFallback(streamStats);

    // Los momentos y frases también entran luego en los prompts: sin vida personal ni charla ajena al stream
    const keep = (list) =>
      (Array.isArray(list) ? list : []).filter(
        (item) => typeof item === 'string' && !quality.summaryPersonalLife(item) && !quality.mentionsEthnicTerms(item),
      );

    // Lo que perdura entre streams no lleva nicks: se sustituyen por «un espectador»
    const nicks = [...(streamStats.activeUsers || []), ...nicksFromChatSample(chatSample)];
    const clean = (text) => scrubNicks(text, nicks);

    return {
      game,
      summary: clean(summary),
      highlights: keep(parsed.highlights).map(clean),
      recurringPhrases: keep(parsed.recurringPhrases).map(clean),
      activeUsers: [],
    };
  } catch (e) {
    logger.error(`Error generando memoria del stream: ${e.message}`);
    // Fallback sin IA
    return {
      game: streamStats.game,
      summary: quality.positiveSummaryFallback(streamStats),
      highlights: [],
      recurringPhrases: [],
      activeUsers: [],
    };
  }
}

// ─── LLAMAR AL FINAL DE CADA STREAM ──────────────────────────────────────────

async function onStreamEnd(streamStats, chatSample) {
  try {
    // 1. Cerrar la sesión en Supabase con las stats finales
    await endStreamSession(streamStats);

    // 2. Generar memoria con IA
    const memory = await generateStreamMemory(streamStats, chatSample);

    // 3. Guardar memoria
    await saveStreamMemory(memory);

    logger.info(`🧠 Memoria del stream guardada: "${memory.summary?.slice(0, 60)}"`);

    // 3b. Aprender lore del canal (no bloquea el resto si falla)
    await onStreamEndLore(memory);

    // 4. Persistir hechos de usuarios activos, por user_id (fire-and-forget). Ya no se guardan frases literales.
    try {
      const { saveUserFact } = require('../utils/supabase');
      const ids = streamStats.activeUserIds || {};
      for (const nick of (streamStats.activeUsers || []).slice(0, 20)) {
        const id = ids[nick];
        if (!id) continue;
        saveUserFact(id, 'is_regular', 'true');
        if (streamStats.game) saveUserFact(id, 'last_game_mentioned', streamStats.game);
      }
    } catch (e) {
      logger.warn(`User facts post-stream: ${e.message}`);
    }

    return memory;
  } catch (e) {
    logger.error(`Error en onStreamEnd: ${e.message}`);
  }
}

function sanitizeMemoryField(text, maxLen = 500) {
  if (!text || typeof text !== 'string') return '';
  if (containsBlockedContent(text)) return '';
  return text
    .slice(0, maxLen)
    .replace(/[\r\n]/g, ' ')
    .replace(/[<>{}]/g, '')
    .trim();
}

// ─── OBTENER CONTEXTO DE MEMORIA PARA LA IA ──────────────────────────────────

let memoryCache = null; // filas de stream_memory (null = sin caché)
let memoryCacheTime = 0;
const MEMORY_CACHE_TTL = 10 * 60 * 1000;

// Texto de memoria para el prompt. maxStreams/summaryMax recortan el perfil "lean" (los más recientes primero)
// game: solo entran los streams del mismo juego (los detalles de otro juego no se mezclan con el actual)
function renderMemory(
  memories,
  { maxStreams = 5, summaryMax = 500, maxHighlights = 2, plain = false, game = '' } = {},
) {
  const sameGame = game
    ? memories.filter((m) => String(m.game || '').toLowerCase() === String(game).toLowerCase())
    : memories;
  if (!sameGame.length) return '';
  const lines = sameGame.slice(0, maxStreams).map((m) => {
    const date = m.stream_date;
    const game = m.game || 'sin juego';
    const summary = sanitizeMemoryField(m.summary, summaryMax);
    const highlights =
      m.highlights?.length && maxHighlights > 0
        ? `Momentos: ${m.highlights
            .slice(0, maxHighlights)
            .map((h) => sanitizeMemoryField(h, 150))
            .filter(Boolean)
            .join(', ')}.`
        : '';
    const phrases = m.recurring_phrases?.length
      ? `Frases del chat: "${sanitizeMemoryField(m.recurring_phrases[0], 150)}".`
      : '';
    return `[${date}] ${game}: ${summary} ${highlights} ${phrases}`.trim();
  });
  if (plain) return lines.join(' | ');
  return `\nMEMORIA DEL CANAL — referencía estos momentos y frases de forma espontanea cuando encaje en la conversacion:\n${lines.join('\n')}`;
}

async function getMemoryContext(opts = {}) {
  // Cache para no consultar Supabase en cada mensaje
  if (memoryCache && Date.now() - memoryCacheTime < MEMORY_CACHE_TTL) return renderMemory(memoryCache, opts);

  try {
    const memories = await getRecentStreamMemory(5);
    memoryCache = memories || [];
    memoryCacheTime = Date.now();
    return renderMemory(memoryCache, opts);
  } catch (e) {
    logger.error(`Error obteniendo contexto de memoria: ${e.message}`);
    return '';
  }
}

function invalidateMemoryCache() {
  memoryCache = null;
  memoryCacheTime = 0;
}

module.exports = {
  onStreamEnd,
  getMemoryContext,
  invalidateMemoryCache,
  generateStreamMemory,
  summaryProblem,
  renderMemory,
};
