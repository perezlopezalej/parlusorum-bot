/**
 * search.js — Búsqueda web (Tavily) + juegos (RAWG)
 * Usado por !dios_fua para responder con información real cuando la necesita.
 */

const logger = require('./logger');

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_URL = 'https://api.tavily.com/search';

// Cache simple para no repetir búsquedas idénticas
const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function cacheKey(query) { return query.toLowerCase().trim().slice(0, 100); }

/**
 * Búsqueda web general via Tavily.
 * Devuelve un resumen corto listo para inyectar en el prompt.
 */
async function searchWeb(query, maxResults = 3) {
  if (!TAVILY_API_KEY) return null;

  const key = cacheKey(query);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: true
      })
    });

    if (!res.ok) {
      logger.warn(`Tavily HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();

    // Usar el answer si existe (es un resumen directo de Tavily)
    if (data.answer && data.answer.length > 10) {
      const result = data.answer.slice(0, 400);
      searchCache.set(key, { result, ts: Date.now() });
      return result;
    }

    // Si no hay answer, combinar los snippets
    const snippets = (data.results || [])
      .slice(0, 2)
      .map(r => r.content?.slice(0, 150) || '')
      .filter(Boolean)
      .join(' | ');

    const result = snippets || null;
    if (result) searchCache.set(key, { result, ts: Date.now() });
    return result;
  } catch (err) {
    logger.error(`Tavily error: ${err.message}`);
    return null;
  }
}

/**
 * Detecta si una pregunta probablemente necesita búsqueda web.
 * Heurística simple: preguntas factuales o sobre temas actuales.
 */
function needsWebSearch(question) {
  if (!TAVILY_API_KEY) return false;
  const q = question.toLowerCase();

  // Preguntas factuales
  const factual = [
    'cuándo', 'cuando', 'quién', 'quien', 'qué es', 'que es',
    'cómo se', 'como se', 'cuál', 'cual', 'dónde', 'donde',
    'cuánto', 'cuanto', 'precio', 'fecha', 'año', 'sale', 'salió',
    'disponible', 'estreno', 'lanzamiento', 'historia de', 'origen de',
    'quién hizo', 'quien hizo', 'creador', 'desarrollador'
  ];

  // Si la pregunta es muy corta o genérica, no buscar
  if (question.length < 10) return false;

  return factual.some(kw => q.includes(kw));
}

/**
 * Detecta si la pregunta es sobre un juego y extrae el nombre.
 * Devuelve el nombre del juego o null.
 */
function extractGameQuery(question) {
  const q = question.toLowerCase();
  const gameKeywords = [
    'juego', 'videojuego', 'game', 'jugarlo', 'jugué', 'jugado',
    'dificultad', 'horas', 'plataforma', 'fps', 'rpg', 'souls'
  ];
  if (gameKeywords.some(kw => q.includes(kw))) {
    // Intentar extraer el nombre del juego (palabras capitalizadas)
    const match = question.match(/(?:de|sobre|el|la|al|un|una)\s+([A-Z][^?,.!]+)/);
    return match ? match[1].trim() : null;
  }
  return null;
}

// Limpiar cache cada hora
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) {
    if (now - v.ts > CACHE_TTL) searchCache.delete(k);
  }
}, 60 * 60 * 1000);

module.exports = { searchWeb, needsWebSearch, extractGameQuery };
