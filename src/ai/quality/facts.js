// Datos inventados: países, estudios, personas y citas que no constan en la fuente.
const { norm } = require('./text');

// !quemeperdi: validación del resumen; devuelve el motivo de rechazo o null
// Texto entre comillas ("…", «…», “…») de más de dos palabras que no aparece en el chat ni en los datos: cita inventada
const QUOTE_RE = /"([^"]{8,})"|«([^»]{8,})»|“([^”]{8,})”/g;

function inventedQuote(text, source = '') {
  const src = norm(source).replace(/\s+/g, ' ');
  for (const m of String(text || '').matchAll(QUOTE_RE)) {
    const q = norm(m[1] || m[2] || m[3]).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.split(' ').length >= 2 && !src.replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').includes(q)) return m[0];
  }
  return '';
}

// ─── Atributos inventados: país/nacionalidad, personas y cifras que no están en los datos ───
// [qué dice la respuesta, qué debe aparecer en los datos para respaldarlo]
const COUNTRY_GROUPS = [
  [/\bjapon\w*/, /japan|japon/], [/\bchin[oa]s?\b/, /chin/], [/\bcore(?:ano|ana)s?\b|\bcorea\b/, /korea|corea/],
  [/\bestadounidens\w*|\bnorteamerican\w*|\beeuu\b|\bamerican[oa]s?\b/, /america|\busa\b|united states|estados unidos|u\.s\./],
  [/\bfranc(?:es|esa|eses|esas|ia)\b/, /franc/], [/\balem(?:an|ana|anes|anas|ania)\b/, /german|aleman/],
  [/\bbritanic\w*|\bingles\w*|\binglaterra\b|\breino unido\b/, /brit|engl|united kingdom|reino unido|\buk\b/],
  [/\brus[oa]s?\b|\brusia\b/, /russia|rusia/], [/\bcanadiens\w*|\bcanada\b/, /canad/], [/\bpolac[oa]s?\b|\bpolonia\b/, /poland|polish|polon/],
  [/\bitalian[oa]s?\b|\bitalia\b/, /ital/], [/\bsuec[oa]s?\b|\bsuecia\b/, /swed|sueci/], [/\btaiwan\w*|\btailand\w*|\bindi[oa]s?\b/, /taiwan|thai|india/],
];

const STUDIO_CTX_RE = /desarroll|estudio|creador|creadora|compania|equipo|publica|studio|juego|titulo|proyecto|saga/;

const FIGURE_CTX_RE = /presupuesto|vend|ventas|copias|jugadores|cuesta|precio|millones|dolares|euros|€|\$/;

const PERSON_RE = /(?:dirigid[oa]|creado|creada|dise[nñ]ad[oa]|liderad[oa]|desarrollad[oa]|producid[oa]|fundad[oa]) por ((?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ'’-]+)(?: (?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ'’-]+))*)/;

// Primer atributo de la respuesta que los datos no respaldan ('' si todo está respaldado).
// persons=false: no comprueba nombres de personas (mensajes sin datos de origen)
function unsupportedAttributes(text, source = '', { persons = true } = {}) {
  const src = norm(source);
  const sentences = String(text || '').split(/(?<=[.!?…])\s+/);
  for (const sentence of sentences) {
    const n = norm(sentence);
    if (STUDIO_CTX_RE.test(n)) {
      for (const [said, backed] of COUNTRY_GROUPS) {
        const m = said.exec(n);
        if (m && !backed.test(src)) return m[0];
      }
    }
    if (FIGURE_CTX_RE.test(n)) {
      // "el presupuesto nacional/familiar" es un chiste de cultura general, no el presupuesto del juego
      if (/presupuesto(?! (?:nacional|publico|general|familiar|domestico|mensual|del estado|de la nacion|del pais))/.test(n) && !/presupuesto|budget/.test(src)) return 'presupuesto';
      const srcDigits = new Set((src.match(/\d[\d.,]*/g) || []).map(d => d.replace(/[.,]/g, '')));
      for (const d of n.match(/\d[\d.,]*/g) || []) {
        const digits = d.replace(/[.,]/g, '');
        if (/^(19|20)\d\d$/.test(digits) || digits.length === 0) continue;
        if (!srcDigits.has(digits)) return d;
      }
    }
    if (persons) {
      const p = PERSON_RE.exec(sentence.charAt(0).toLowerCase() + sentence.slice(1));
      if (p && !src.includes(norm(p[1]))) return p[1];
    }
  }
  return '';
}

// Sin datos de la fuente (IGDB), cualquier desarrolladora o editora que cite la respuesta es inventada
const KNOWN_COMPANIES = ['sega', 'nintendo', 'capcom', 'bandai namco', 'namco', 'square enix', 'konami', 'fromsoftware', 'from software', 'ubisoft', 'electronic arts', 'ea games', 'sony', 'playstation studios', 'microsoft', 'xbox game studios', 'activision', 'blizzard', 'valve', 'tencent', 'netease', 'bethesda', 'cd projekt', 'rockstar', 'take-two', 'take two', 'warner', 'warner bros', '2k games', 'epic games', 'devolver', 'annapurna', 's-game', 'sgame', 'kojima productions', 'atlus', 'koei tecmo', 'team ninja', 'platinumgames', 'remedy', 'focus entertainment', 'deep silver', 'embracer', 'paradox', 'thq nordic', 'level-5', 'level 5', 'hoyoverse', 'mihoyo', 'nexon', 'netmarble', 'krafton', 'pearl abyss', 'shift up', 'larian', 'obsidian', 'bioware', 'insomniac', 'naughty dog', 'santa monica', 'cygames', 'arc system works'];

const COMPANY_NAMED_RE = /(?:estudio|desarrolladora|editora|compa[nñ][ií]a|empresa|publisher|creador\w*|detr[aá]s)(?:\s+(?:que|del|de|es|fue|son|lo|la|el))*\s+(?:es|fue|son|:)?\s*(?:el\s+|la\s+)?([A-ZÁÉÍÓÚÑ][\wáéíóúñ'’-]+)/;

function inventedCompany(text, source = '') {
  const src = norm(source);
  const n = ' ' + norm(text).replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const c of KNOWN_COMPANIES) {
    if (n.includes(' ' + c + ' ') && !src.includes(c)) return c;
  }
  const sentences = String(text || '').split(/(?<=[.!?…])\s+/);
  for (const sentence of sentences) {
    const m = COMPANY_NAMED_RE.exec(sentence);
    if (m && !src.includes(norm(m[1])) && !/^(?:No|Ni|Nada|Eso|Ese|Esa|Un|Una|Algo|Quien|Quién)$/.test(m[1])) return m[1];
  }
  return unsupportedAttributes(text, source, { persons: false });
}

module.exports = { unsupportedAttributes, inventedQuote, inventedCompany };
