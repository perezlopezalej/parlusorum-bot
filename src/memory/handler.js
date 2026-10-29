/**
 * memory/handler.js — Memoria del canal entre streams
 * Al acabar cada stream genera un resumen con IA y lo guarda en Supabase.
 * Al arrancar el siguiente stream, inyecta ese historial en el prompt.
 */

const channelConfig = require('../../config/channel.json');
const {
  saveStreamMemory,
  getRecentStreamMemory,
  endStreamSession
} = require('../utils/supabase');
const logger = require('../utils/logger');
const quality = require('../ai/quality');
const { containsBlockedContent } = require('../utils/filter');
const { groqWithRetry } = require('../utils/groq-utils');
const { onStreamEndLore } = require('../lore/handler');


// ─── GENERAR RESUMEN AL ACABAR EL STREAM ─────────────────────────────────────

async function generateStreamMemory(streamStats, chatSample) {
  try {
    const { game, durationMinutes, deathCount, peakViewers, topCommands } = streamStats;

    const prompt = `Eres el bot dios_fua del canal de ${channelConfig.streamer}. 
Acaba de terminar un stream con estos datos:
- Juego: ${game || 'no definido'}
- Duración: ${durationMinutes} minutos
- Muertes: ${deathCount}
- Pico de viewers: ${peakViewers}
- Comandos más usados: ${JSON.stringify(topCommands)}
- Muestra del chat durante el stream: ${chatSample || 'sin datos'}

Genera un resumen BREVE y CONCRETO del stream en español. Incluye:
1. Una frase en POSITIVO con lo que pasó (muertes, jefes, momentos del juego, ambiente del chat). Nunca digas que hubo poca acción, que fue aburrido, flojo o tranquilo: si pasó poco, destaca el buen rollo y el chat.
2. El momento más destacado si lo detectas en el chat
3. Una frase recurrente del chat si la hay
No pongas género a ParLusorum (la cuenta la usan Manu y Pao): nada de tía/tío/amigo/amiga.

Responde SOLO en JSON con este formato exacto:
{
  "summary": "frase resumen del stream",
  "highlights": ["momento1", "momento2"],
  "recurringPhrases": ["frase1", "frase2"]
}`;

    const response = await groqWithRetry({
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.choices[0].message.content.trim();
    // Limpiar posibles backticks de markdown
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    const rawSummary = String(parsed.summary || '').trim();
    const summary = !rawSummary || quality.negativeSummary(rawSummary) || quality.genderedParlusorum(rawSummary)
      ? quality.positiveSummaryFallback(streamStats)
      : rawSummary;

    return {
      game,
      summary,
      highlights: parsed.highlights || [],
      recurringPhrases: parsed.recurringPhrases || [],
      activeUsers: streamStats.activeUsers || []
    };
  } catch (e) {
    logger.error(`Error generando memoria del stream: ${e.message}`);
    // Fallback sin IA
    return {
      game: streamStats.game,
      summary: quality.positiveSummaryFallback(streamStats),
      highlights: [],
      recurringPhrases: [],
      activeUsers: streamStats.activeUsers || []
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

    // 4. Persistir hechos de usuarios activos (fire-and-forget)
    try {
      const { saveUserFact } = require('../utils/supabase');
      const activeUsers = streamStats.activeUsers || [];
      for (const username of activeUsers.slice(0, 20)) {
        saveUserFact(username, 'is_regular', 'true');
        if (streamStats.game) saveUserFact(username, 'last_game_mentioned', streamStats.game);
      }
      // Solo a quien dijo de verdad la frase en la muestra de chat (formato "usuario: mensaje")
      const phrases = (memory.recurringPhrases || []).map(p => sanitizeMemoryField(p, 100)).filter(p => p.length >= 4);
      if (phrases.length > 0 && chatSample) {
        const assigned = new Set();
        for (const line of chatSample.split('\n')) {
          const sep = line.indexOf(': ');
          if (sep < 1) continue;
          const user = line.slice(0, sep).toLowerCase();
          const text = line.slice(sep + 2).toLowerCase();
          if (assigned.has(user) || !activeUsers.includes(user)) continue;
          const phrase = phrases.find(p => text.includes(p.toLowerCase()));
          if (phrase) {
            assigned.add(user);
            saveUserFact(user, 'recurring_joke', phrase);
          }
        }
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
  return text.slice(0, maxLen).replace(/[\r\n]/g, ' ').replace(/[<>{}]/g, '').trim();
}

// ─── OBTENER CONTEXTO DE MEMORIA PARA LA IA ──────────────────────────────────

let memoryCache = null;
let memoryCacheTime = 0;
const MEMORY_CACHE_TTL = 10 * 60 * 1000;

async function getMemoryContext() {
  // Cache para no consultar Supabase en cada mensaje
  if (memoryCache && Date.now() - memoryCacheTime < MEMORY_CACHE_TTL) {
    return memoryCache;
  }

  try {
    const memories = await getRecentStreamMemory(5);
    if (!memories || memories.length === 0) {
      memoryCache = '';
      memoryCacheTime = Date.now();
      return '';
    }

    // Formatear los últimos streams en texto para inyectar en el prompt
    const lines = memories.map(m => {
      const date = m.stream_date;
      const game = m.game || 'sin juego';
      const summary = sanitizeMemoryField(m.summary);
      const highlights = m.highlights?.length
        ? `Momentos: ${m.highlights.slice(0, 2).map(h => sanitizeMemoryField(h, 150)).filter(Boolean).join(', ')}.`
        : '';
      const phrases = m.recurring_phrases?.length
        ? `Frases del chat: "${sanitizeMemoryField(m.recurring_phrases[0], 150)}".`
        : '';
      return `[${date}] ${game}: ${summary} ${highlights} ${phrases}`.trim();
    });

    memoryCache = `\nMEMORIA DEL CANAL — referencía estos momentos y frases de forma espontanea cuando encaje en la conversacion:\n${lines.join('\n')}`;
    memoryCacheTime = Date.now();
    return memoryCache;
  } catch (e) {
    logger.error(`Error obteniendo contexto de memoria: ${e.message}`);
    return '';
  }
}

function invalidateMemoryCache() {
  memoryCache = null;
  memoryCacheTime = 0;
}

module.exports = { onStreamEnd, getMemoryContext, invalidateMemoryCache };
