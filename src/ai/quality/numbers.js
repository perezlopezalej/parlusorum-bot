// Números, muertes, minutos, viewers y día/hora del directo.
const { norm } = require('./text');

const DEATH_WORDS_RE =
  /\b(muert[eoa]s?|muri[oó]|morir|mori|ca[ií]das?|ca[ey]ó|caer|cae|caen|caerá|cay[oó]|fallece|palm[oó])\b/i;

// Muertes: con contador a 0 no se habla de muertes/caídas; si se cita una cifra debe ser la del contador
function mentionsUnrecordedDeaths(text, deathCount, extraNumbers = []) {
  if (!DEATH_WORDS_RE.test(text)) return false;
  if (!deathCount) return true;
  const nums = [
    ...text.matchAll(
      /(?:#|n[uú]mero |muerte |ca[ií]da )(\d+)|(\d+)\s*(?:muertes?|ca[ií]das?|veces|del d[ií]a|de hoy)/gi,
    ),
  ].map((m) => parseInt(m[1] || m[2], 10));
  return nums.some((n) => n !== deathCount && !extraNumbers.includes(n));
}

// --- Números en palabras (0-999): para detectar que se cita el contador de muertes y los mal escritos ("cuarentay siete") ---
const UNITS_ES = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciseis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidos',
  'veintitres',
  'veinticuatro',
  'veinticinco',
  'veintiseis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];

const TENS_ES = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];

const HUNDREDS_ES = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

const NUMBER_TOKENS_ES = [
  ...new Set([
    ...UNITS_ES,
    'un',
    'una',
    'cien',
    ...TENS_ES.filter(Boolean),
    ...HUNDREDS_ES.filter(Boolean),
    'doscientas',
    'trescientas',
  ]),
];

// Formas (sin tildes) con las que se puede escribir n en español: "treinta y una", "treinta y uno", "treinta y un"
function numberWordsEs(n) {
  n = Math.trunc(Number(n));
  if (!Number.isFinite(n) || n < 0 || n > 999) return [];
  if (n === 100) return ['cien'];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = h ? HUNDREDS_ES[h] : '';
  let tail = [];
  if (rest < 30) tail = rest === 0 && h ? [] : [UNITS_ES[rest]];
  else {
    const t = TENS_ES[Math.floor(rest / 10)];
    tail = rest % 10 === 0 ? [t] : [`${t} y ${UNITS_ES[rest % 10]}`];
  }
  let forms = tail.map((w) => [head, w].filter(Boolean).join(' '));
  if (!tail.length) forms = [head];
  const extra = [];
  for (const f of forms) {
    if (/uno$/.test(f)) {
      extra.push(f.replace(/uno$/, 'una'));
      extra.push(f.replace(/uno$/, 'un'));
    }
    if (/veintiuno$/.test(f)) extra.push(f.replace(/veintiuno$/, 'veintiun'));
  }
  return [...forms, ...extra];
}

// Números en palabras mal formados: "cuarentay siete", "treintaydos", "cuarenta siete" (falta la "y")
const TENS_RE = '(?:treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)';

const SMALL_UNITS_RE = '(?:uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)';

const MALFORMED_NUMBER_RE = new RegExp(
  `\\b${TENS_RE}(?:y|i)\\s*${SMALL_UNITS_RE}\\b|\\b${TENS_RE}\\s+${SMALL_UNITS_RE}\\b|\\b${TENS_RE}(?:y|i)\\b`,
);

function malformedNumber(text) {
  const m = norm(text).match(MALFORMED_NUMBER_RE);
  return m ? m[0] : null;
}

// ¿Cita el número de muertes? Cifra o palabra pegada a "muertes/caídas/bajas/derrotas" ("31 caídas", "treinta y una caídas",
// "tres bajas seguidas") o, con 10+ muertes, el contador exacto suelto ("con treinta y una en el zurrón")
const NUM_TOKEN_RE = `(?:${NUMBER_TOKENS_ES.join('|')})`;

const DEATH_NOUN_RE = '(?:muertes?|caidas?|bajas?|derrotas?)';

const CITES_COUNT_RE = new RegExp(
  `(?:\\b\\d+|\\b${NUM_TOKEN_RE}(?:\\s+(?:y\\s+)?${NUM_TOKEN_RE})*)\\s+(?:\\p{L}+\\s+){0,1}${DEATH_NOUN_RE}\\b`,
  'u',
);

function citesDeathCount(text, deathCount = 0) {
  const t = norm(text);
  if (CITES_COUNT_RE.test(t)) return true;
  const n = Number(deathCount);
  if (n >= 10 && n <= 999) {
    if (new RegExp(`(?<![\\d#])${n}(?!\\d)`).test(t)) return true;
    if (numberWordsEs(n).some((w) => new RegExp(`\\b${w}\\b`).test(t))) return true;
  }
  return false;
}

// Día y momento reales (Madrid): se pasan a los prompts que hablan del momento y se vigila que no se invente otro
const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function madridDay(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value, 10) % 24;
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return {
    weekday: WEEKDAYS_ES[idx < 0 ? 0 : idx],
    part: hour < 6 ? 'noche' : hour < 14 ? 'mañana' : hour < 21 ? 'tarde' : 'noche',
  };
}

const DAY_REF_RE =
  /\b(?:(?:ma[ñn]ana|tarde|noche|madrugada|jornada|d[ií]a|plan|rollo|ambiente) de|este) (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo) por la (?:ma[ñn]ana|tarde|noche)\b/gi;

// ¿Cita un día de la semana que no es hoy ("tarde de martes" un sábado)?
function wrongWeekday(text, now = new Date()) {
  const today = norm(madridDay(now).weekday);
  for (const m of String(text || '').matchAll(DAY_REF_RE)) {
    const day = norm(m[1] || m[2]);
    if (day !== today) return true;
  }
  return false;
}

// Hora que no cuadra con la real (Madrid): "plus de nocturnidad" a las 19:49
const NIGHT_RE =
  /\b(?:nocturnidad|nocturn[oa]s?|de madrugada|por la noche|esta noche|noche de|de noche|buenas noches|trasnochar\w*)\b/i;

const MORNING_RE = /\b(?:por la ma[ñn]ana|esta ma[ñn]ana|ma[ñn]anero|ma[ñn]anera|madrugar|de buena ma[ñn]ana)\b/i;

function wrongDayPart(text, now = new Date()) {
  const part = madridDay(now).part;
  if ((part === 'tarde' || part === 'mañana') && NIGHT_RE.test(text)) return true;
  if (part !== 'mañana' && MORNING_RE.test(text)) return true;
  return false;
}

// Minutos exactos del directo ("116 minutos", "1h 18m"): se dicen aproximados ("casi dos horas")
const EXACT_MINUTES_RE =
  /\b\d{2,3}\s*(?:minutos|mins?)\b|\b\d+\s*h\s*\d+\s*m\b|\b\d+\s*horas?\s+y\s+\d+\s*(?:minutos|min)\b/i;

function exactMinutes(text) {
  return EXACT_MINUTES_RE.test(String(text || ''));
}

// Duración aproximada en palabras: nunca los minutos exactos
function approxDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 20) return 'un ratito';
  if (m < 40) return 'media hora';
  if (m < 55) return 'casi una hora';
  if (m < 70) return 'una hora';
  const h = Math.floor(m / 60);
  const rem = m - h * 60;
  const word = (n) =>
    ['cero', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce'][n] ||
    String(n);
  const hours = (n) => (n === 1 ? 'una hora' : `${word(n)} horas`);
  if (rem < 12) return h === 1 ? 'una hora' : `unas ${word(h)} horas`;
  if (rem < 25) return `${hours(h)} y pico`;
  if (rem < 40) return `${hours(h)} y media`;
  return `casi ${hours(h + 1)}`;
}

// Cifras de viewers: el bot no las cita (los de una raid son visitantes, no los viewers del canal)
function citesViewers(text) {
  return /\b\d+\s+(?:viewers?|espectadores)\b/i.test(String(text || ''));
}

// "1 muerte" / "16 muertes", "1 bit" / "100 bits"
function countDeaths(n) {
  return `${n} ${Number(n) === 1 ? 'muerte' : 'muertes'}`;
}

function countBits(n) {
  return `${n} ${Number(n) === 1 ? 'bit' : 'bits'}`;
}

// "logrando 16 muertes": las muertes son caídas del streamer, no un logro
const ACHIEVED_DEATHS_RE =
  /\b(?:logr[\wáéíóú]*|consigu[\wáéíóú]*|alcanz[\wáéíóú]*|cosech[\wáéíóú]*|acumul[\wáéíóú]*|sum[\wáéíóú]*|anot[\wáéíóú]*|firm[\wáéíóú]*)\s+(?:un total de\s+|nada menos que\s+|hasta\s+)?\d+\s+(?:muertes?|ca[ií]das?)\b/i;

function achievesDeaths(text) {
  return ACHIEVED_DEATHS_RE.test(String(text || ''));
}

module.exports = {
  malformedNumber,
  NUM_TOKEN_RE,
  wrongWeekday,
  wrongDayPart,
  mentionsUnrecordedDeaths,
  citesDeathCount,
  exactMinutes,
  citesViewers,
  achievesDeaths,
  approxDuration,
  numberWordsEs,
  madridDay,
  countDeaths,
  countBits,
};
