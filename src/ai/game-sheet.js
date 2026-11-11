// Ficha de un juego para el modelo de !dios_fua: en español y en limpio (fecha legible, géneros y país en español, resumen corto en
// español en vez de la descripción en inglés de IGDB) + filtro de salida contra fichas volcadas en bruto.
// El resumen se genera una vez por juego (qwen) y se guarda en caché.

const { translateGenres } = require('../utils/genres');
const { aiChat } = require('../utils/ai-router');
const logger = require('../utils/logger');

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

// "2026-10-29" → "octubre de 2026"; solo el año si no hay mes; '' si no hay fecha
function formatReleaseEs(released) {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(String(released || ''));
  if (!m) return '';
  const month = m[2] ? parseInt(m[2], 10) : 0;
  return month >= 1 && month <= 12 ? `${MONTHS_ES[month - 1]} de ${m[1]}` : m[1];
}

// --- Detección de inglés, fechas ISO y campos copiados de la ficha ---
const ENGLISH_WORDS = new Set([
  'the',
  'of',
  'and',
  'his',
  'her',
  'their',
  'its',
  'to',
  'is',
  'for',
  'with',
  'in',
  'an',
  'he',
  'she',
  'who',
  'has',
  'had',
  'was',
  'were',
  'this',
  'that',
  'on',
  'by',
  'from',
  'at',
  'as',
  'be',
  'are',
  'it',
  'you',
  'your',
  'they',
  'them',
  'but',
  'will',
  'can',
  'after',
  'before',
  'into',
  'only',
  'when',
  'where',
  'must',
  'have',
]);
const ENGLISH_GENRE_RE =
  /\b(?:hack and slash|beat 'em up|role-playing|adventure|shooter|strategy|simulator|fighting|racing|turn-based|real time|visual novel)\b/gi;
const ISO_DATE_RE = /\b\d{4}-\d{2}(?:-\d{2})?\b/;
const SHEET_FIELD_RE =
  /\b(?:Salida|Desarrolladora|G[eé]neros|Editora|Descripci[oó]n|Resumen|Pa[ií]s de la desarrolladora|Nombre)\s*:/;
const WINDOW = 5;

// Primera ventana de 5 palabras con 3 o más palabras funcionales inglesas (sin contar el nombre del juego y otros nombres propios)
function englishFragment(text, names = []) {
  let t = String(text || '');
  for (const n of names.filter((x) => x && String(x).length >= 3)) t = t.split(String(n)).join(' ');
  const words = t.split(/[^a-záéíóúüñ']+/i).filter(Boolean);
  for (let i = 0; i + WINDOW <= words.length; i++) {
    const win = words.slice(i, i + WINDOW);
    if (win.filter((w) => ENGLISH_WORDS.has(w.toLowerCase())).length >= 3) return win.join(' ');
  }
  return '';
}

// '' si la respuesta está limpia; si no, el motivo (se usa en el reintento y en el log)
function leaksSheetRaw(text, { names = [] } = {}) {
  const t = String(text || '');
  if (ISO_DATE_RE.test(t)) return 'fecha en formato ISO';
  if (SHEET_FIELD_RE.test(t)) return 'campos de la ficha copiados';
  const genres = new Set((t.match(ENGLISH_GENRE_RE) || []).map((g) => g.toLowerCase()));
  if (genres.size >= 2 || genres.has('hack and slash') || genres.has("beat 'em up")) return 'géneros en inglés';
  const frag = englishFragment(t, names);
  return frag ? `fragmento en inglés («${frag}»)` : '';
}

// --- Resumen en español, una vez por juego ---
const SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_MAX = 300;
const summaryCache = new Map(); // nombre en minúsculas → { text, ts }
const inFlight = new Map();
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of summaryCache) if (now - v.ts > SUMMARY_TTL_MS) summaryCache.delete(k);
  },
  60 * 60 * 1000,
).unref();

const SUMMARY_SYSTEM =
  'Resumes en español de España la descripción de un videojuego. Una sola frase de menos de 200 caracteres con la premisa, usando solo lo que dice <descripcion>, sin valoraciones y sin copiar frases en inglés.';

async function summarizeGameEs(info) {
  const desc = String(info?.description || '').trim();
  if (!desc || !info?.name) return '';
  const key = info.name.toLowerCase();
  const hit = summaryCache.get(key);
  if (hit && Date.now() - hit.ts < SUMMARY_TTL_MS) return hit.text;
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    try {
      const response = await aiChat('summary', {
        max_tokens: 120,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: `<juego>${info.name}</juego>\n<descripcion>${desc}</descripcion>` },
        ],
      });
      const text = String(response.choices[0]?.message?.content || '')
        .replace(/\s+/g, ' ')
        .trim();
      // Sin resumen válido (vacío, largo o con inglés) la ficha no lleva descripción: nunca se le pasa la inglesa
      if (!text || text.length > SUMMARY_MAX || leaksSheetRaw(text, { names: [info.name] })) {
        logger.warn(`Resumen de "${info.name}" no válido, la ficha va sin descripción`);
        return '';
      }
      if (summaryCache.size >= 300) summaryCache.delete(summaryCache.keys().next().value);
      summaryCache.set(key, { text, ts: Date.now() });
      return text;
    } catch (err) {
      logger.warn(`Resumen de "${info.name}" falló: ${err.message}`);
      return '';
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

// Ficha en español y en limpio. Lo que no consta se dice como «desconocida»/«sin resumen», nunca en inglés
async function buildGameSheet(info, { summary = summarizeGameEs } = {}) {
  const genres = translateGenres(info.genres);
  const release = formatReleaseEs(info.released);
  const resumen = await summary(info);
  return [
    `Nombre: ${info.name}`,
    `Salida: ${release || 'desconocida'}`,
    `Desarrolladora: ${info.developers || 'desconocida'}`,
    // El país solo se da si la fuente lo trae (IGDB); sin él, el filtro de atributos impide afirmarlo
    ...(info.country ? [`País de la desarrolladora: ${info.country}`] : []),
    ...(info.publishers ? [`Editora: ${info.publishers}`] : []),
    `Géneros: ${genres || 'desconocidos'}`,
    `Resumen: ${resumen || 'sin resumen'}`,
  ].join('\n');
}

function resetSummaryCache() {
  summaryCache.clear();
  inFlight.clear();
}

module.exports = {
  formatReleaseEs,
  englishFragment,
  leaksSheetRaw,
  summarizeGameEs,
  buildGameSheet,
  resetSummaryCache,
};
