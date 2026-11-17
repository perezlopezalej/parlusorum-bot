// Números, muertes, minutos, viewers y día/hora del directo.
const { norm } = require('./text');

const DEATH_WORDS_RE =
  /\b(muert[eoa]s?|muri[oó]|morir|mori|ca[ií]das?|ca[ey]ó|caer|cae|caen|caerá|cay[oó]|fallece|palm[oó])\b/i;

// Frases que dan por hecho que el streamer ha muerto sin decir «muerte» («el FUA sigue vivo, el streamer no tanto»): con el
// contador a cero contradicen los datos
const IMPLIED_DEATH_RE =
  /(?<![\p{L}\p{N}])(?:no tanto|resucit\p{L}*|reviv\p{L}*|sobreviv\p{L}*|fantasma|ata[uú]d|funeral(?:es)?|cementerio|en paz descanse)(?![\p{L}\p{N}])/iu;

// Muertes: con contador a 0 no se habla de muertes/caídas ni se da a entender que las hubo; si se cita una cifra debe ser la
// del contador
// strictSingular: el texto solo habla de un tramo concreto (media hora del timer), así que «una caída» siempre es una cifra a comprobar
function mentionsUnrecordedDeaths(text, deathCount, extraNumbers = [], { strictSingular = false } = {}) {
  if (!deathCount && IMPLIED_DEATH_RE.test(text)) return true;
  if (!DEATH_WORDS_RE.test(text)) return false;
  if (!deathCount) return true;
  const nums = [
    ...text.matchAll(
      /(?:#|n[uú]mero |muerte |ca[ií]da )(\d+)|(\d+)\s*(?:muertes?|ca[ií]das?|veces|del d[ií]a|de hoy)/gi,
    ),
  ].map((m) => parseInt(m[1] || m[2], 10));
  return nums
    .concat(citedWordDeathNumbers(text, strictSingular))
    .some((n) => n !== deathCount && !extraNumbers.includes(n));
}

// Cifras de caídas escritas con palabras («dos caídas», «una caída», «un par de muertes»). «Una caída» a secas solo cuenta como
// total si la frase lo plantea como cuenta («lleva», «con», «solo», «hoy»…); «una caída más» suma, no cuenta. 16-11: con 8 caídas
// el bot dijo «una caída y sigue a tope».
let wordNumbers = null;
function wordNumberMap() {
  if (!wordNumbers) {
    wordNumbers = new Map();
    for (let n = 0; n < 100; n++) for (const w of numberWordsEs(n)) wordNumbers.set(w, n);
  }
  return wordNumbers;
}
const SINGULAR_COUNT_CUE_RE = /\b(?:llev\w+|van|vais|solo|solamente|apenas|hoy|ya|total|acumul\w+|suma\w*|sola)\b/;

// Apuestas y pronósticos («apuesto por veinte caídas») hablan del futuro, no del contador
const PREDICTION_RE =
  /\b(?:apuest\w*|apostar\w*|apostemos|predic\w*|pronostic\w*|llegar\w*|acabar\w*|terminar\w*|superar\w*|batir\w*|record|mas de|menos de)\b/;

function citedWordDeathNumbers(text, strictSingular = false) {
  const t = norm(text)
    .replace(/[^a-zñ0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (PREDICTION_RE.test(t)) return [];
  const tokens = t.split(' ');
  const map = wordNumberMap();
  const out = [];
  tokens.forEach((tok, i) => {
    if (!/^(?:muertes?|caidas?)$/.test(tok) || tokens[i + 1] === 'mas') return;
    let j = i;
    if (/^(?:sola|solita|unica)$/.test(tokens[j - 1])) j--;
    if (tokens.slice(j - 3, j).join(' ') === 'un par de') return void out.push(2);
    for (let len = 3; len >= 1; len--) {
      if (j - len < 0) continue;
      const n = map.get(tokens.slice(j - len, j).join(' '));
      if (n === undefined) continue;
      if (/^(?:sin|ni)$/.test(tokens[j - len - 1] || '')) break; // «sin una sola caída»
      if (n === 1 && !strictSingular && !SINGULAR_COUNT_CUE_RE.test(t)) break;
      out.push(n);
      break;
    }
  });
  return out;
}

// ¿Cita una cifra de caídas (con cifras o con palabras) que no es la del contador? Para textos que pueden hablar de caídas
// (menciones), sin exigir que el contador sea 0 ni prohibir el tema
function citesWrongDeathCount(text, deathCount, extraNumbers = []) {
  const digits = [
    ...String(text || '').matchAll(
      /(?:#|n[uú]mero |muerte |ca[ií]da )(\d+)|(\d+)\s*(?:muertes?|ca[ií]das?|veces|del d[ií]a|de hoy)/gi,
    ),
  ].map((m) => parseInt(m[1] || m[2], 10));
  return digits.concat(citedWordDeathNumbers(text)).some((n) => n !== deathCount && !extraNumbers.includes(n));
}

// ¿El texto habla de caídas o muertes? (15-11: con una sola muerte en 2,5 horas el cohost la comentó 5 veces)
function talksDeaths(text) {
  return DEATH_WORDS_RE.test(String(text || ''));
}

// «Otra muerte», «una caída más», «vuelve a caer»: solo vale si ya había alguna antes (contador de 2 o más)
const AGAIN_DEATH_RE =
  /(?<![\p{L}\p{N}])(?:(?:otra|otro|nueva|segunda)\s+(?:muerte|ca[ií]da|tropiezo|vez al suelo)|(?:muerte|ca[ií]da|tropiezo)\s+m[aá]s|vuelve a (?:caer|morir)|de nuevo (?:en el suelo|por los suelos)|otra vez (?:al suelo|por los suelos))(?![\p{L}\p{N}])/iu;

function againDeathWrong(text, deathCount = 0) {
  return Number(deathCount) < 2 && AGAIN_DEATH_RE.test(String(text || ''));
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
  if (m < 60) return 'casi una hora';
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

// ¿El texto habla de cuánto dura el directo? («Dos horas y media y seguimos aquí», «media hora de directo», «¿quién sigue
// aquí desde el principio?»). El 13-11, 9 de 25 comentarios del cohost fueron de esto: ahora sale como mucho una vez por hora.
const HOURS_WORD = '(?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|\\d+)';
const STREAM_TIME_RE = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:' +
    [
      `${HOURS_WORD}\\s+horas?`,
      'media\\s+hora',
      'horas?\\s+y\\s+(?:media|pico)',
      'cuartos?\\s+de\\s+hora',
      '(?:horas?|minutos|rato|tiempo)\\s+de\\s+(?:directo|stream)',
      '(?:tanto|cu[aá]nto)\\s+(?:rato|tiempo)',
      'desde\\s+el\\s+(?:principio|inicio|minuto\\s+uno)',
    ].join('|') +
    ')(?![\\p{L}\\p{N}])',
  'iu',
);
// Horas de directo dichas de más (17-11: «Tres horas ya» con 2 h 41 min; había que decir «casi tres horas»). Lee «N horas»
// (con «y media» suma 30 min) y compara con los minutos reales: «casi» siempre vale; sin él (o con «unas»/«cerca de») la cifra no
// puede pasar de lo real en más de 10 min. «y pico» cuenta desde la hora redonda. → la expresión pasada de rosca, o ''.
const HOURS_VALUE = {
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};
const STATED_HOURS_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(casi|cerca de|unas?)\s+)?(${HOURS_WORD})\s+horas?(?![\p{L}\p{N}])(\s+y\s+(media|pico))?`,
  'giu',
);
function roundsUpTime(text, minutes, toleranceMin = 10) {
  if (!Number.isFinite(minutes)) return '';
  for (const m of String(text || '').matchAll(STATED_HOURS_RE)) {
    const [whole, qualifier, word, , tail] = m;
    if (/^casi$/i.test(qualifier || '')) continue;
    const hours = HOURS_VALUE[word.toLowerCase()] ?? Number(word);
    if (!hours) continue;
    const claimed = hours * 60 + (/^media$/i.test(tail || '') ? 30 : 0);
    if (claimed > minutes + toleranceMin) return whole.trim();
  }
  return '';
}

function talksStreamTime(text) {
  return STREAM_TIME_RE.test(String(text || ''));
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
  citesWrongDeathCount,
  talksDeaths,
  againDeathWrong,
  citesDeathCount,
  exactMinutes,
  talksStreamTime,
  roundsUpTime,
  citesViewers,
  achievesDeaths,
  approxDuration,
  numberWordsEs,
  madridDay,
  countDeaths,
  countBits,
};
