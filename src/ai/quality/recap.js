// Reglas de los textos que cuentan el directo (!quemeperdi y resumen de fin de stream): solo valen los hechos recibidos.
// Directo del 13-11: «Pao en la grada» jugando Manu, «Final Fantasy trece» por FINAL FANTASY XVI, «el chat de España»,
// «todo fue copiar y pegar», «madrugada larga de 4 horas y casi 3». Módulo puro.
const { norm, plainWords } = require('./text');
const { abbreviatedGame, genderedGameTitle, mentionsOtherGame } = require('./lexicon');
const { inventedDetail } = require('./copy');
const { citesViewers, exactMinutes } = require('./numbers');

// --- Quién juega: el otro streamer no aparece salvo en la pareja «Manu y Pao» ---
// → 'Pao' | 'Manu' | '' (player: 'manu' | 'pao' | 'ambos')
function otherStreamer(text, player = 'manu') {
  if (player === 'ambos') return '';
  const t = norm(plainWords(text)).replace(/\bmanu y pao\b|\bpao y manu\b/g, ' ');
  if (player === 'pao') return /\bmanu\b/.test(t) ? 'Manu' : '';
  return /\bpao\b/.test(t) ? 'Pao' : '';
}

// --- El chat es el del canal: ni «el chat de España» ni «todo fue copiar y pegar» ---
const FOREIGN_CHAT_RE =
  /\bchat (?:de|del) (?!Manu\b|Pao\b|ParLusorum\b|Twitch\b|Lusorum)\p{Lu}\p{L}+|\bchat (?:espa[ñn]ol|latino|internacional|extranjero)\b|\bcopi(?:ar|a|ando) y peg(?:ar|a|ando)\b/u;

function foreignChat(text) {
  const m = String(text || '').match(FOREIGN_CHAT_RE);
  return m ? m[0] : '';
}

// --- Duración: las horas citadas cuadran con las del directo ---
const HOUR_WORDS = {
  un: 1,
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
const HOURS_RE = new RegExp(`\\b(\\d{1,2}|${Object.keys(HOUR_WORDS).join('|')}) horas?( y media)?\\b`, 'g');
const HOURS_TOLERANCE = 0.75; // «casi cuatro horas» con tres horas y media vale; «cuatro horas» con dos, no
const MARATHON_MIN_MINUTES = 240;

// → la expresión que no cuadra («cuatro horas», «maratón») o ''
function wrongHours(text, minutes) {
  if (!Number.isFinite(minutes)) return '';
  const t = norm(text);
  for (const m of t.matchAll(HOURS_RE)) {
    const n = HOUR_WORDS[m[1]] ?? parseInt(m[1], 10);
    const value = n + (m[2] ? 0.5 : 0);
    if (Math.abs(value - minutes / 60) > HOURS_TOLERANCE) return m[0];
  }
  const marathon = t.match(/\bmaraton\w*/);
  return marathon && minutes < MARATHON_MIN_MINUTES ? marathon[0] : '';
}

// --- Parte del día: solo las que cubrió el directo (hora de Madrid) ---
function madridHour(ts) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  return parseInt(parts.find((p) => p.type === 'hour')?.value, 10) % 24;
}
const partOf = (hour) => (hour < 6 ? 'madrugada' : hour < 14 ? 'mañana' : hour < 21 ? 'tarde' : 'noche');

// Partes del día entre el inicio y el fin: Set de 'madrugada' | 'mañana' | 'tarde' | 'noche' (vacío si no hay hora de inicio)
function streamDayParts(startedAt, endedAt = startedAt) {
  const out = new Set();
  if (!Number.isFinite(startedAt)) return out;
  const STEP = 30 * 60 * 1000;
  const end = Number.isFinite(endedAt) && endedAt > startedAt ? Math.min(endedAt, startedAt + 48 * STEP) : startedAt;
  for (let t = startedAt; t < end; t += STEP) out.add(partOf(madridHour(t)));
  out.add(partOf(madridHour(end)));
  return out;
}

const DAY_PART_RES = [
  [/\bmadrugad\w+/, ['madrugada']],
  [/\b(?:noches?|nocturn\w+|trasnoch\w+)\b/, ['noche', 'madrugada']],
  [/\b(?:por la manana|esta manana|manana de|mananer\w+|matinal\w*|madrugon\w*)\b/, ['mañana']],
  [
    /\b(?:esta|la|una|toda la|buena|gran|otra) tarde\b|\btardes? (?:de|del|tranquila|intensa|larga|movid\w+|entera|redonda|completa)\b|\bsobremesa\b/,
    ['tarde'],
  ],
];

// → la expresión de una parte del día que el directo no cubrió, o '' (sin horas de inicio no se comprueba)
function wrongStreamDayPart(text, parts) {
  if (!parts || !parts.size) return '';
  const t = norm(text);
  for (const [re, valid] of DAY_PART_RES) {
    const m = t.match(re);
    if (m && !valid.some((p) => parts.has(p))) return m[0];
  }
  return '';
}

// Motivo de rechazo de un texto que cuenta el directo: { rule, reason } o null.
// ctx.facts: hechos recibidos ({ texto }); game: título exacto; player: 'manu' | 'pao' | 'ambos'; minutes: minutos de directo;
// gameWords: vocabulario del juego; channelGames: otros juegos del canal; startedAt/endedAt: para la parte del día.
function recapProblem(
  text,
  {
    facts = [],
    game = '',
    player = 'manu',
    minutes = null,
    gameWords = [],
    channelGames = [],
    startedAt = null,
    endedAt = null,
  } = {},
) {
  const t = String(text || '');
  const other = otherStreamer(t, player);
  if (other)
    return {
      rule: 'jugador',
      reason: `nombra a ${other}, que no juega hoy según los hechos; habla solo de quien juega`,
    };
  const abbreviated = abbreviatedGame(t, game);
  if (abbreviated)
    return {
      rule: 'juego_nombre',
      reason: `abrevia el nombre del juego o lo escribe distinto («${abbreviated}»); escribe el título tal cual («${game}»)`,
    };
  const gendered = genderedGameTitle(t, game);
  if (gendered)
    return {
      rule: 'juego_nombre',
      reason: `abrevia el nombre del juego o lo escribe distinto: pone el título en femenino («${gendered}»); el juego es masculino, escribe «${game}» sin artículo femenino`,
    };
  const otherGame = game ? mentionsOtherGame(t, game, channelGames) : null;
  if (otherGame)
    return { rule: 'otro_juego', reason: `nombra otro videojuego (${otherGame}); habla solo del juego de hoy` };
  const foreign = foreignChat(t);
  if (foreign)
    return {
      rule: 'chat_ajeno',
      reason: `habla del chat de otro sitio o de algo que no pasó («${foreign}»); el chat es el del canal, los Lusorums`,
    };
  const hours = wrongHours(t, minutes);
  if (hours)
    return { rule: 'duracion', reason: `da una duración que no cuadra («${hours}»); di la que dan los hechos` };
  if (exactMinutes(t))
    return {
      rule: 'minutos',
      reason: 'cita los minutos exactos del directo; usa una expresión aproximada («casi dos horas», «un buen rato»)',
    };
  const dayPart = wrongStreamDayPart(t, streamDayParts(startedAt, endedAt));
  if (dayPart)
    return {
      rule: 'hora',
      reason: `habla de una parte del día («${dayPart}») que no es la del directo; cuenta el directo sin decir la hora`,
    };
  if (citesViewers(t))
    return { rule: 'viewers', reason: 'cita una cifra de viewers; cuenta el directo sin cifras de espectadores' };
  const invented = facts.length
    ? inventedDetail(t, { allowed: [...facts.map((f) => f.texto || f), game], gameWords })
    : '';
  if (invented)
    return {
      rule: 'inventado',
      reason: `usa «${invented}», un nombre o una palabra poco común que no sale de los hechos; cuenta solo lo que está en los hechos`,
    };
  return null;
}

module.exports = { otherStreamer, foreignChat, wrongHours, streamDayParts, wrongStreamDayPart, recapProblem };
