// Comprobación SÍ/NO con el modelo rápido: ¿el mensaje afirma algo concreto del juego que no está en los datos?
// Solo se comprueba lo que habla del juego; si es de eso y hay duda o fallo, se descarta. Lo que no habla del juego se envía sin comprobar.

const { aiChat } = require('../utils/ai-router');
const { canMakeAuxRequest } = require('../utils/ratelimit');
const { mentionsGame } = require('./quality');
const logger = require('../utils/logger');
const { recordCohostDiscard } = require('../utils/state');

// Fallos de la propia comprobación (no del mensaje), para distinguirlos en el resumen de fin de stream
function recordFactcheckFailure(kind) {
  recordCohostDiscard(`factcheck_${kind}`);
}

// 'yes' | 'no' | null (respuesta ilegible)
function parseVerdict(raw) {
  const t = String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (/^(si|yes)\b/.test(t)) return 'yes';
  if (/^no\b/.test(t)) return 'no';
  return null;
}

// Los emotes del canal no son datos del juego: se quitan antes de cualquier comprobación
const { channel_emotes: CHANNEL_EMOTES = [] } = require('../../config/channel.json');
function stripEmotes(text) {
  let t = String(text || '');
  for (const e of CHANNEL_EMOTES) t = t.split(e).join(' ');
  return t
    .replace(/\bparlus1w+/gi, '')
    .replace(/s{2,}/g, ' ')
    .trim();
}

function buildCheckPrompt(text, data, source) {
  text = stripEmotes(text);
  const ctx = String(data || '').trim() || '(ninguno)';
  const question =
    source === 'juego'
      ? '¿El mensaje afirma algún dato concreto y comprobable del juego (fechas, estudio, país o nacionalidad del estudio, personas, cifras, presupuestos, mecánicas, armas, zonas, dificultades, personajes, tramas) que no esté en el resultado de la consulta de arriba (incluida su descripción; el país del estudio solo cuenta si aparece como "País de la desarrolladora")? Las opiniones, valoraciones y descripciones de tono o ambiente ("atmósfera densa", "ideal para flipar"), las bromas y el FUA no se comprueban y no cuentan. Si no hay datos y el mensaje solo dice que no conoce el juego, responde NO. Responde "NO" si todo está respaldado, o "SÍ: " seguido de la frase o dato no respaldado, copiado del mensaje (máx. 15 palabras).'
      : '¿El mensaje afirma algo concreto del juego (mecánicas, armas, zonas, dificultad, jefes, historia, consejos, fechas) que no esté en estos datos? ' +
        GENERIC_NOT_CLAIM +
        ' Las bromas, el FUA y los hechos del stream (muertes, chat, eventos) no cuentan.';
  return `Datos disponibles:\n${ctx}\n\nMensaje:\n${text}\n\n${question} ${source === 'juego' ? '' : 'Responde SOLO "SÍ" o "NO".'}`;
}

// Ficha del juego (IGDB, la de lookupGameInfo) como texto de "datos disponibles" para el revisor.
// Sin ficha devuelve '' y el revisor solo conoce el nombre.
function gameFactsText(info) {
  if (!info || !info.name) return '';
  const parts = [`Ficha del juego: ${info.name}`];
  if (info.released) parts.push(`Fecha de salida: ${info.released}`);
  if (info.developers) parts.push(`Desarrolladora: ${info.developers}`);
  if (info.publishers) parts.push(`Editora: ${info.publishers}`);
  if (info.country) parts.push(`País de la desarrolladora: ${info.country}`);
  if (info.genres) parts.push(`Géneros: ${info.genres}`);
  if (info.description) parts.push(`Descripción: ${info.description}`);
  return parts.join('. ') + '.';
}

// Juego a partir de los datos ("Juego: X. Muertes...") cuando el llamador no lo pasa aparte
function gameFromData(data) {
  const m = /^Juego:\s*(.+?)\.(?:\s|$)/.exec(String(data || ''));
  return m ? m[1] : '';
}

// Pregunta de redacción, en la misma llamada que la de datos: ¿se entiende y está bien escrita?
const SENSE_QUESTION =
  'SENTIDO: ¿el mensaje tiene sentido y está bien escrito en español de España? Responde NO si la idea no se entiende, mezcla imágenes que no encajan (metáforas absurdas), usa palabras inventadas o mal usadas, copia palabras sueltas del chat sin entenderlas, tiene errores gramaticales o suena a traducción. Responde NO también si suena poético o profundo pero no dice nada concreto, si compara cosas sin relación lógica, si dice que alguien "se hace" o "será" algo que no se entiende, o si el sujeto y lo que hace no encajan. Ejemplos que son NO: "la flor que brota cuando el FUA se queja, ya vas a ser la mariposa de la derrota" (metáforas encadenadas sin sentido), "el FUA está sudando más que la nevera del microondas" (comparación sin relación lógica), "el FUA se está haciendo de la muerte una obra de arte" (frase mal construida). Los chistes y exageraciones claros (que se entienden a la primera) SÍ valen. "El FUA" (grito de carácter del canal) y "Dios Fua" (nombre del bot) no son errores.';

// Frases genéricas de tono o ambiente no son datos comprobables (falsos positivos: "exige temple de acero")
const GENERIC_NOT_CLAIM =
  'Las frases genéricas de tono, esfuerzo o ambiente sin ningún dato concreto ("exige temple de acero", "pide paciencia", "es un viaje intenso", "la dificultad del jefe") NO son datos del juego: responde NO.';

function buildReviewPrompt(text, data, { checkData }) {
  const ctx = String(data || '').trim() || '(ninguno)';
  const dataPart = checkData
    ? `DATOS: ¿el mensaje afirma algo concreto del juego (mecánicas, armas, zonas, jefes concretos, historia, consejos, fechas, cifras) que no esté en los datos (la ficha incluye año, estudio, géneros y descripción)? ${GENERIC_NOT_CLAIM} Las bromas, el FUA y los hechos del stream (muertes, chat, eventos) no cuentan. Responde "DATOS: SÍ" o "DATOS: NO".\n`
    : '';
  return `Datos disponibles:\n${ctx}\n\nMensaje:\n${stripEmotes(text)}\n\nResponde en ${checkData ? 'dos líneas' : 'una línea'}.\n${dataPart}${SENSE_QUESTION} Responde "SENTIDO: SÍ" o "SENTIDO: NO".`;
}

// { data, sense }: 'yes' | 'no' | null por línea
function parseReview(raw) {
  const t = String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  const pick = (key) => {
    const m = new RegExp(key + '\\s*[:\\-]?\\s*(si|yes|no)\\b').exec(t);
    return m ? (m[1] === 'no' ? 'no' : 'yes') : null;
  };
  return { data: pick('datos'), sense: pick('sentido') };
}

// Frase no respaldada tras "SÍ:" (solo la pide el prompt del juego)
function parseClaim(raw) {
  const m = /^\s*s[ií]\s*[:\-–]\s*(.+)$/is.exec(String(raw || ''));
  return m
    ? m[1]
        .trim()
        .replace(/^["“«]|["”»]$/g, '')
        .slice(0, 120)
    : '';
}

// Mensajes automáticos con revisión de sentido (opts.sense): datos del juego (solo si hablan de él) y redacción, en una llamada
// { discard, claim, nonsense }. Un fallo de la revisión de redacción no bloquea (se envía); uno de la de datos sí descarta.
async function evaluateReview(text, data, { game, checkData: forced } = {}) {
  const checkData = typeof forced === 'boolean' ? forced : mentionsGame(text, game ?? gameFromData(data));
  if (!canMakeAuxRequest()) {
    recordFactcheckFailure('ratelimit');
    return { discard: checkData, claim: '', nonsense: false };
  }
  try {
    const response = await aiChat('review', {
      max_tokens: 24,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Eres un revisor estricto de mensajes de un chat de Twitch en España. Respondes solo con las líneas pedidas.',
        },
        { role: 'user', content: buildReviewPrompt(text, data, { checkData }) },
      ],
    });
    const r = parseReview(response.choices[0]?.message?.content);
    return { discard: checkData && r.data !== 'no', claim: '', nonsense: r.sense === 'no' };
  } catch (err) {
    logger.warn(`Revisión del mensaje falló: ${err.message}`);
    recordFactcheckFailure(err.status === 429 ? 'groq429' : 'error');
    return { discard: checkData, claim: '', nonsense: false };
  }
}

// { discard, claim }: claim es lo no respaldado cuando el verificador lo indica
async function evaluate(text, data, { source = 'stream', game, sense = false, checkData } = {}) {
  if (sense && source === 'stream') return evaluateReview(text, data, { game, checkData });
  if (source === 'stream' && !mentionsGame(text, game ?? gameFromData(data))) return { discard: false, claim: '' };
  if (!canMakeAuxRequest()) {
    recordFactcheckFailure('ratelimit');
    return { discard: true, claim: '' };
  }
  try {
    const response = await aiChat('review', {
      max_tokens: source === 'juego' ? 60 : 8,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            source === 'juego'
              ? 'Eres un verificador estricto. Respondes "NO" o "SÍ: <frase no respaldada>".'
              : 'Eres un verificador estricto. Respondes únicamente SÍ o NO.',
        },
        { role: 'user', content: buildCheckPrompt(text, data, source) },
      ],
    });
    const raw = response.choices[0]?.message?.content;
    return { discard: parseVerdict(raw) !== 'no', claim: parseClaim(raw) };
  } catch (err) {
    logger.warn(`Comprobación de datos del juego falló, se descarta: ${err.message}`);
    recordFactcheckFailure(err.status === 429 ? 'groq429' : 'error');
    return { discard: true, claim: '' };
  }
}

// true = descartar el mensaje. source: 'stream' (mensajes automáticos) | 'juego' (!dios_fua con buscar_juego)
// Los mensajes 'stream' que no hablan del juego no se comprueban (ni gastan petición). Usa su propio cupo (canMakeAuxRequest).
async function shouldDiscard(text, data, opts) {
  return (await evaluate(text, data, opts)).discard;
}

module.exports = {
  stripEmotes,
  gameFactsText,
  GENERIC_NOT_CLAIM,
  parseVerdict,
  parseClaim,
  parseReview,
  buildReviewPrompt,
  evaluate,
  buildCheckPrompt,
  gameFromData,
  shouldDiscard,
};
