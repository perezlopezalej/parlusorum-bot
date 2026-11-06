// IGDB (propiedad de Twitch): fuente principal de datos de juegos. Mismo CLIENT_ID y app token que EventSub.
// Límite de la API: 4 peticiones por segundo (y 8 abiertas a la vez); aquí se serializan con ≥260 ms entre inicios.
const logger = require('../utils/logger');
const { classifyGameMatch, nameSimilarity } = require('../utils/game-match');
const { getAppAccessToken, invalidateAppAccessToken } = require('./app-token');

const IGDB_URL = 'https://api.igdb.com/v4/games';
const IGDB_TIMEOUT_MS = 8000;
const MIN_GAP_MS = 260;
const ATTRIBUTION = 'Datos: IGDB.com';

// summary y no storyline (spoilers). version_parent: las ediciones apuntan a su juego base.
const FIELDS = 'name,summary,genres.name,first_release_date,version_parent,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,involved_companies.company.country';
// Juego base, expansión independiente, remake, remaster, edición ampliada y port: sin DLC, packs ni bundles
const MAIN_TYPES = '(0,4,8,9,10,11)';

// País de IGDB: código numérico ISO 3166-1 → alpha-2 (los que salen en estudios de videojuegos)
const NUMERIC_TO_ALPHA2 = {
  32: 'AR', 36: 'AU', 40: 'AT', 56: 'BE', 76: 'BR', 100: 'BG', 124: 'CA', 152: 'CL', 156: 'CN', 170: 'CO', 191: 'HR', 196: 'CY',
  203: 'CZ', 208: 'DK', 233: 'EE', 246: 'FI', 250: 'FR', 276: 'DE', 300: 'GR', 344: 'HK', 348: 'HU', 352: 'IS', 356: 'IN',
  360: 'ID', 372: 'IE', 376: 'IL', 380: 'IT', 392: 'JP', 410: 'KR', 428: 'LV', 440: 'LT', 442: 'LU', 458: 'MY', 484: 'MX',
  528: 'NL', 554: 'NZ', 578: 'NO', 616: 'PL', 620: 'PT', 642: 'RO', 643: 'RU', 702: 'SG', 703: 'SK', 705: 'SI', 710: 'ZA',
  724: 'ES', 752: 'SE', 756: 'CH', 158: 'TW', 764: 'TH', 792: 'TR', 804: 'UA', 826: 'GB', 840: 'US', 862: 'VE', 704: 'VN',
  784: 'AE', 818: 'EG', 566: 'NG', 604: 'PE', 858: 'UY',
};
let regionNames = null;
function countryName(code) {
  const alpha2 = NUMERIC_TO_ALPHA2[code];
  if (!alpha2) return '';
  try {
    regionNames = regionNames || new Intl.DisplayNames(['es'], { type: 'region' });
    return regionNames.of(alpha2) || '';
  } catch { return ''; }
}

// Cola serie con separación mínima entre peticiones
let queue = Promise.resolve();
let lastStart = 0;
function schedule(fn) {
  const run = queue.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastStart = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

async function igdbQuery(body, retry = true) {
  // index.js ya exige estas variables; la guarda evita peticiones de red sin credenciales (tests, scripts)
  if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) throw new Error('IGDB sin CLIENT_ID/CLIENT_SECRET');
  const token = await getAppAccessToken();
  if (!token) throw new Error('IGDB sin app token');
  const res = await schedule(() => fetch(IGDB_URL, {
    method: 'POST',
    headers: { 'Client-ID': process.env.CLIENT_ID, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(IGDB_TIMEOUT_MS),
  }));
  if (res.status === 401 && retry) { invalidateAppAccessToken(); return igdbQuery(body, false); }
  if (!res.ok) throw new Error(`IGDB HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('IGDB respuesta ilegible');
  return data;
}

function mapGame(game, detail) {
  const involved = game.involved_companies || [];
  const named = list => [...new Set(list.map(i => i.company?.name).filter(Boolean))];
  const devs = involved.filter(i => i.developer);
  const countries = [...new Set(devs.map(i => countryName(i.company?.country)).filter(Boolean))];
  const ts = game.first_release_date;
  return {
    name: game.name,
    description: game.summary ? game.summary.replace(/\s+/g, ' ').trim().slice(0, detail ? 600 : 300) : null,
    genres: (game.genres || []).map(g => g.name).join(', ') || null,
    released: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null,
    rating: null,
    developers: named(devs).join(', ') || null,
    publishers: named(involved.filter(i => i.publisher)).join(', ') || null,
    country: countries.join(', ') || null,
    source: 'igdb',
  };
}

// Mejor candidato: coincidencia de nombre > parecido del nombre completo > juego base sobre edición > orden de IGDB
const LEVEL = { match: 2, maybe: 1, none: 0 };
function pickBest(name, games) {
  return games
    .map((g, i) => ({ g, score: LEVEL[classifyGameMatch(name, g.name)] * 100 + nameSimilarity(name, g.name) * 20 + (g.version_parent ? 0 : 5) - i * 0.1 }))
    .sort((a, b) => b.score - a.score)[0]?.g || null;
}

// Variantes del nombre con los números escritos de otra forma ("phantom blade 0" → "phantom blade zero", "dark souls 2" → "dark souls II")
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const DIGIT_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function nameVariants(name) {
  const words = String(name).split(/\s+/).filter(Boolean);
  const out = new Set();
  const swap = f => words.map(w => f(w) ?? w).join(' ');
  const digit = w => (/^\d{1,2}$/.test(w) && Number(w) <= 10 ? Number(w) : null);
  out.add(swap(w => { const d = digit(w); return d === null ? null : DIGIT_WORDS[d]; }));
  out.add(swap(w => { const d = digit(w); return d === null || d === 0 ? null : DIGIT_ROMAN[d]; }));
  out.add(swap(w => { const i = DIGIT_WORDS.indexOf(w.toLowerCase()); const r = DIGIT_ROMAN.indexOf(w.toUpperCase()); return i >= 0 ? String(i) : (r > 1 ? String(r) : null); }));
  out.delete(words.join(' '));
  return [...out].slice(0, 2);
}

async function searchOnce(query) {
  const games = await igdbQuery(`search "${query}"; fields ${FIELDS}; where game_type = ${MAIN_TYPES}; limit 8;`);
  let best = pickBest(query, games);
  // "phantom blade 0" solo encuentra la edición: se usan los datos del juego base
  if (best?.version_parent) {
    const parent = (await igdbQuery(`fields ${FIELDS}; where id = ${Number(best.version_parent)}; limit 1;`))[0];
    if (parent) best = parent;
  }
  return best;
}

// → info | null (no encontrado). Lanza si IGDB falla (HTTP, timeout, token, formato).
// Si la primera búsqueda no da una coincidencia clara se reintenta con los números normalizados y se queda con la mejor.
async function searchGame(name, { detail = false } = {}) {
  const query = String(name).replace(/[\\"]/g, ' ').trim();
  if (!query) return null;
  let best = await searchOnce(query);
  let level = best ? LEVEL[classifyGameMatch(query, best.name)] : 0;
  if (level < LEVEL.match) {
    for (const variant of nameVariants(query)) {
      const cand = await searchOnce(variant);
      const l = cand ? LEVEL[classifyGameMatch(query, cand.name)] : 0;
      if (l > level) { best = cand; level = l; }
      if (level === LEVEL.match) break;
    }
  }
  // Un candidato sin relación con lo buscado cuenta como no encontrado
  if (!best || level === 0) {
    if (best) logger.info(`IGDB: "${query}" sin coincidencia (mejor candidato: ${best.name})`);
    return null;
  }
  return mapGame(best, detail);
}

module.exports = { searchGame, mapGame, pickBest, nameVariants, countryName, ATTRIBUTION, MIN_GAP_MS };
