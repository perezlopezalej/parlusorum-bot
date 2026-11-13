// Validadores por tipo de mensaje (cohost, hook, timer, mención, !quemeperdi, automáticos).
const {
  BOT_SELF_RE,
  CHANNEL_OWNER_RE,
  CREATOR_CLAIM_RE,
  ETHNIC_RE,
  FUA_GENDER_RE,
  MANU_PAO_RE,
  MECHANICS_RE,
  PROFANITY_RE,
  REDIRECT_RE,
  SPORTS_RE,
  TIPS_RE,
  citesGameScore,
  claimsEnemyKills,
  disparagesGame,
  forcedComparison,
  fuaGender,
  genderedParlusorum,
  hasLatam,
  isRobotRefusal,
  judgesChatMood,
  leaksTech,
  matchesFormula,
  mentionsGenre,
  mentionsMechanics,
  abbreviatedGame,
  mentionsOtherGame,
  mirrorsUser,
  misusedIdiom,
  personalMatch,
  selfHelp,
} = require('./lexicon');
const { copiedFromChat, inventedDetail } = require('./copy');
const { factProblem, giroProblem, inventedQuote, unsupportedAttributes } = require('./facts');
const {
  WORD_LIST_RE,
  hasElongation,
  isCutOff,
  junkProblem,
  oddCaps,
  reportFormat,
  spellingProblem,
  wordListProblem,
} = require('./form');
const {
  achievesDeaths,
  citesDeathCount,
  citesViewers,
  exactMinutes,
  mentionsUnrecordedDeaths,
  wrongDayPart,
  wrongWeekday,
} = require('./numbers');
const {
  METAPHOR_MARK,
  METAPHOR_REASON,
  isMetaphor,
  recentlyNamedIn,
  repeatedClosing,
  repeatedInStream,
  repeatsClosing,
  repeatsFormula,
  repeatsYear,
  sameOpening,
  structureKey,
  tooSimilar,
} = require('./repetition');
const { plainWords } = require('./text');

// Motivo de rechazo si el mensaje automático habla de mecánicas del juego, cita la nota del juego o desprecia el juego
function gameTalkProblem(text) {
  if (mentionsMechanics(text))
    return 'habla de mecánicas, armas o zonas del juego; habla solo del stream, el chat y el FUA';
  if (citesGameScore(text)) return 'cita la nota o la fuente del juego; no la menciones';
  if (disparagesGame(text)) return 'desprecia el juego de los streamers; bromas cariñosas sí, desprecio no';
  const attr = unsupportedAttributes(text, '', { persons: false });
  if (attr) return `afirma "${attr}" (país, cifra o presupuesto) que no está en los datos; no lo digas`;
  return null;
}

// Motivo de rechazo por redacción o tema vetado (null si pasa). opts.personal=false deja pasar la vida personal (menciones)
// opts.idioms: frases hechas vetadas en los mensajes automáticos (por defecto, igual que personal)
function styleProblem(
  text,
  { personal = true, idioms = personal, minWords = 3, player = 'manu', now = new Date(), names = [] } = {},
) {
  const t = String(text || '');
  const junk = junkProblem(t, { minWords });
  if (junk) return junk;
  if (isCutOff(t))
    return {
      rule: 'cortada',
      reason: 'la frase está cortada o termina a medias; escribe una frase completa y sencilla',
    };
  if (ETHNIC_RE.test(t))
    return { rule: 'etnia', reason: 'usa una expresión con etnias o pueblos; haz la broma sobre la partida o el FUA' };
  if (hasElongation(t))
    return { rule: 'ruido', reason: 'copia letras alargadas o ruido del chat ("parrrrr"); escribe palabras normales' };
  if (wrongDayPart(t, now))
    return {
      rule: 'hora',
      reason:
        'habla de una parte del día que no es la de ahora (noche, mañana); habla del momento sin inventar la hora',
    };
  const caps = oddCaps(t, names);
  if (caps)
    return {
      rule: 'mayusculas',
      reason: `escribe «${caps}» con mayúsculas raras; las palabras normales van en minúscula y solo el FUA o los nombres propios en mayúscula`,
    };
  const spelling = spellingProblem(t);
  if (spelling) return { rule: 'ortografia', reason: `ortografía: ${spelling}` };
  if (reportFormat(t))
    return {
      rule: 'formato',
      reason: 'suena a informe (paréntesis con cifras, «en los últimos N′»); cuéntalo como una frase natural',
    };
  if (wrongWeekday(t, now))
    return { rule: 'dia', reason: 'cita un día de la semana que no es hoy; habla del momento sin inventar el día' };
  if (PROFANITY_RE.test(t))
    return { rule: 'grosería', reason: 'repite una grosería o insulto; no los repitas ni los cites' };
  if (BOT_SELF_RE.test(t) && !/\bsoy\b[^.!?]{0,30}\bbot\b/i.test(t))
    return { rule: 'bot', reason: 'habla de sí mismo como "el bot"; habla en primera persona o como el FUA' };
  if (FUA_GENDER_RE.test(t)) return { rule: 'fua', reason: '"el FUA" va siempre en masculino' };
  if (player !== 'pao' && player !== 'ambos' && MANU_PAO_RE.test(t))
    return { rule: 'manu', reason: 'quien juega es Manu; no pongas a Pao a jugar ni a morir' };
  if (CHANNEL_OWNER_RE.test(t))
    return { rule: 'canal', reason: 'el canal es de Manu y Pao; vlxj97 solo creó el bot, no le atribuyas el canal' };
  if (CREATOR_CLAIM_RE.test(t))
    return { rule: 'creador', reason: 'eres el bot del canal, no su creador; te creó vlxj97' };
  if (idioms && misusedIdiom(t))
    return { rule: 'modismo', reason: 'usa una frase hecha que no pega con lo que pasa; dilo con palabras llanas' };
  if (personal && personalMatch(t))
    return {
      rule: 'personal',
      reason:
        'habla de vida personal (comida, sueño, familia, trabajo, salud, fútbol); habla solo del stream, el juego y el chat sobre la partida',
    };
  return null;
}

// Aviso automático (inicio de stream, encuestas, avisos): mismo tono que el resto, sin comprobar nombres ni muertes
function validateAuto(text) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  const style = styleProblem(text, { personal: false });
  if (style) return { ok: false, reason: style.reason };
  return { ok: true };
}

const INVENTED_REASON = (w) =>
  `usa «${w}», un nombre o una palabra poco común que no sale de los hechos, del juego ni del canal; cuenta solo lo que está en los hechos`;

const ABBREVIATED_REASON = (w, game) =>
  `abrevia el nombre del juego («${w}»); si lo nombras, escribe el título completo («${game}»)`;

const EXACT_MINUTES_REASON =
  'cita los minutos exactos del directo; usa una expresión aproximada («casi dos horas», «un buen rato»)';

const VIEWERS_REASON =
  'cita una cifra de viewers; los de una raid son visitantes de otro canal, no los espectadores del canal';

// Validación del cohost. ctx: { deathCount, recent: string[], sameKind: string[], named: Map, now, nameWindowMs }
// ctx.facts/hecho/giro: hechos del momento, el que declara el candidato y su giro (reglas `hecho` y `giro`).
// ctx.chatLines/allowedWords/gameWords: regla `copia`. ctx.game/channelGames: sin nombrar otros juegos.
// Devuelve { ok, reason, soft }. soft = fallo leve (nombre repetido, fórmula, parecido, juicio del ambiente):
// se reintenta una vez y, si persiste, se envía igual. Lo grave (soft ausente) se descarta.
function validateCohost(
  text,
  {
    deathCount = 0,
    recent = [],
    sameKind = [],
    named = new Map(),
    now = Date.now(),
    nameWindowMs = 15 * 60 * 1000,
    usedStructures = new Set(),
    lastCitedDeaths = false,
    player = 'manu',
    game = '',
    channelGames = [],
    facts = [],
    hecho = '',
    giro = '',
    chatLines = [],
    allowedWords = [],
    gameWords = [],
  } = {},
) {
  if (!text || text.length < 8) return { ok: false, rule: 'vacio', reason: 'vacío o demasiado corto' };
  if (hasLatam(text))
    return { ok: false, rule: 'latam', reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, rule: 'robot', reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount))
    return { ok: false, rule: 'muertes', reason: 'menciona muertes que no están en el contador' };
  const style = styleProblem(text, { player, now: new Date(now) });
  if (style) return { ok: false, rule: style.rule, reason: style.reason };
  const twist = giroProblem(giro);
  if (twist) return { ok: false, rule: 'giro', reason: twist };
  const fact = factProblem(text, { facts, hecho });
  if (fact) return { ok: false, rule: 'hecho', reason: fact };
  const copied = copiedFromChat(text, chatLines, {
    allowed: [...facts.map((f) => f.texto), ...allowedWords, game],
    gameWords,
    numbers: [deathCount],
  });
  if (copied)
    return {
      ok: false,
      rule: 'copia',
      reason: `copia del chat «${copied}»; cuenta el hecho con tus propias palabras`,
    };
  const invented = allowedWords.length
    ? inventedDetail(text, {
        allowed: [...facts.map((f) => f.texto), ...allowedWords, game],
        gameWords,
        names: chatLines.map((l) => l.username),
      })
    : '';
  if (invented) return { ok: false, rule: 'inventado', reason: INVENTED_REASON(invented) };
  const abbreviated = abbreviatedGame(text, game);
  if (abbreviated) return { ok: false, rule: 'juego_nombre', reason: ABBREVIATED_REASON(abbreviated, game) };
  if (lastCitedDeaths && citesDeathCount(text, deathCount))
    return { ok: false, rule: 'contador', reason: DEATH_REPEAT_REASON };
  const gameProblem = gameTalkProblem(text);
  if (gameProblem) return { ok: false, rule: 'juego', reason: gameProblem };
  const other = game ? mentionsOtherGame(text, game, channelGames) : null;
  if (other)
    return {
      ok: false,
      rule: 'otro_juego',
      reason: `nombra otro videojuego (${other}); habla solo del juego actual o de ningún juego`,
    };
  if (forcedComparison(text))
    return {
      ok: false,
      rule: 'comparacion',
      reason: 'usa una comparación forzada con objetos o situaciones cotidianas; di la idea directa',
    };
  if (exactMinutes(text)) return { ok: false, rule: 'minutos', reason: EXACT_MINUTES_REASON };
  if (citesViewers(text)) return { ok: false, rule: 'viewers', reason: VIEWERS_REASON };
  if (WORD_LIST_RE.test(plainWords(text)))
    return { ok: false, rule: 'lista', reason: 'lista palabras sueltas del chat; cuenta el tema en una idea' };
  const names = recentlyNamedIn(text, named, now, nameWindowMs);
  if (names.length)
    return {
      ok: false,
      soft: true,
      rule: 'nombre',
      reason: `nombra a ${names.join(', ')}, que ya se nombró hace poco; no lo repitas`,
    };
  if (usedStructures.has(METAPHOR_MARK) && isMetaphor(text))
    return { ok: false, soft: true, rule: 'metafora', reason: METAPHOR_REASON };
  const repeated = repeatedInStream(text, usedStructures, game);
  if (repeated) return { ok: false, soft: true, rule: 'repetido', reason: repeated };
  const structure = structureKey(text);
  if (structure && usedStructures.has(structure))
    return {
      ok: false,
      soft: true,
      rule: 'estructura',
      reason:
        'repite la estructura "Manu lleva N caídas y el FUA…" que ya usaste en este stream; cambia de enfoque y no cites el contador',
    };
  if (matchesFormula(text) && repeatsFormula(text, recent))
    return { ok: false, soft: true, rule: 'formula', reason: 'repite una fórmula que ya usaste' };
  if (tooSimilar(text, recent))
    return { ok: false, soft: true, rule: 'parecido', reason: 'se parece demasiado a un mensaje reciente' };
  if (sameKind.length && tooSimilar(text, sameKind, 0.4))
    return {
      ok: false,
      soft: true,
      rule: 'parecido',
      reason: 'repite una idea de otro comentario de este stream sobre lo mismo; cambia de enfoque',
    };
  if (judgesChatMood(text))
    return {
      ok: false,
      soft: true,
      rule: 'ambiente',
      reason: 'juzga el ambiente del chat; reacciona a un tema concreto con humor',
    };
  return { ok: true };
}

// Para avisos con IA (bienvenida, encuestas, raids, subs): devuelve el texto limpio o lanza para que actúe la reserva fija
function vetAuto(text) {
  const t = String(text || '').trim();
  const check = validateAuto(t);
  if (!check.ok) throw new Error(`mensaje automático descartado (${check.reason})`);
  return t;
}

// Hook anti-silencio: voz de Dios Fua, sin deporte, sin muertes inventadas ni repetir los últimos hooks
const DEATH_REPEAT_REASON =
  'el mensaje anterior del bot ya citó el número de muertes; no lo cites ahora, habla de otra cosa';

function validateHook(
  text,
  {
    deathCount = 0,
    recent = [],
    lastCitedDeaths = false,
    player = 'manu',
    requireQuestion = false,
    extraDeathNumbers = [],
    now = Date.now(),
    usedStructures = new Set(),
    game = '',
  } = {},
) {
  if (lastCitedDeaths && citesDeathCount(text, deathCount)) return { ok: false, reason: DEATH_REPEAT_REASON };
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (requireQuestion && !/\?/.test(text)) return { ok: false, reason: 'no es una pregunta al chat' };
  if (SPORTS_RE.test(text)) return { ok: false, reason: 'usa metáforas de comentarista deportivo' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount, extraDeathNumbers))
    return { ok: false, reason: 'menciona muertes que no están en el contador' };
  if (exactMinutes(text)) return { ok: false, reason: EXACT_MINUTES_REASON };
  if (citesViewers(text)) return { ok: false, reason: VIEWERS_REASON };
  if (tooSimilar(text, recent)) return { ok: false, reason: 'se parece demasiado a un hook reciente' };
  if (usedStructures.has(METAPHOR_MARK) && isMetaphor(text)) return { ok: false, reason: METAPHOR_REASON };
  const style = styleProblem(text, { player, now: new Date(now) });
  if (style) return { ok: false, reason: style.reason };
  const abbreviated = abbreviatedGame(text, game);
  if (abbreviated) return { ok: false, reason: ABBREVIATED_REASON(abbreviated, game) };
  const talk = gameTalkProblem(text);
  if (talk) return { ok: false, reason: talk };
  return { ok: true };
}

function validateQueMePerdi(text, { deathCount = 0, bosses = 0, source = '' } = {}) {
  if (fuaGender(text)) return '"el FUA" va siempre en masculino';
  if (ETHNIC_RE.test(String(text || ''))) return 'usa una expresión con etnias o pueblos; cuéntalo sin ellas';
  const junk = junkProblem(text);
  if (junk) return junk.reason;
  if (achievesDeaths(text)) return 'presenta las muertes como un logro; son caídas del streamer';
  if (!text || text.length < 8) return 'vacío o demasiado corto';
  if (claimsEnemyKills(text))
    return 'habla de enemigos derribados; no hay ese dato (las muertes son caídas del streamer)';
  if (hasLatam(text)) return 'usa expresiones latinoamericanas; escribe español de España';
  if (isRobotRefusal(text)) return 'suena a rechazo de robot';
  if (mentionsUnrecordedDeaths(text, deathCount)) return 'menciona muertes que no están en el contador';
  if (inventedQuote(text, source)) return 'cita un mensaje del chat que no existe (entrecomillado inventado)';
  const boss = text.match(/(\d+)\s+(?:jefes?|bosses|boss)\b/i);
  if (boss && parseInt(boss[1], 10) !== bosses) return `cita ${boss[1]} jefes y llevamos ${bosses}`;
  return null;
}

// Comentario IA del timer: misma validación que el hook, sin nota del juego y sin repetir ideas del stream
// ctx.currentGame/channelGames: sin nombrar otros juegos; ctx.named: usuarios nombrados hace poco (no repetirlos)
// ctx.chatLines/allowedWords/gameWords: regla `copia` (palabras del chat que no vienen del resumen ni del juego)
function validateTimerIA(
  text,
  {
    extraDeathNumbers = [],
    deathCount = 0,
    recent = [],
    currentGame = '',
    channelGames = [],
    named = new Map(),
    now = Date.now(),
    nameWindowMs = 15 * 60 * 1000,
    usedStructures = new Set(),
    lastCitedDeaths = false,
    player = 'manu',
    chatLines = [],
    allowedWords = [],
    gameWords = [],
  } = {},
) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (SPORTS_RE.test(text)) return { ok: false, reason: 'usa metáforas de comentarista deportivo' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount, extraDeathNumbers))
    return { ok: false, reason: 'menciona muertes que no están en el contador' };
  if (lastCitedDeaths && citesDeathCount(text, deathCount)) return { ok: false, reason: DEATH_REPEAT_REASON };
  if (mentionsGenre(text) && recent.some(mentionsGenre))
    return {
      ok: false,
      reason: 'repite el género del juego ("juego de rol y acción"); no lo uses en cada mensaje, habla de otra cosa',
    };
  if (forcedComparison(text))
    return {
      ok: false,
      reason:
        'usa una comparación forzada ("igual que un despertador un lunes"); di la idea directa, sin comparar con objetos ni situaciones cotidianas',
    };
  if (selfHelp(text))
    return {
      ok: false,
      reason:
        'suena a autoayuda o motivación ("qué os da fuerzas…"); haz un comentario del directo con humor, sin consejos ni preguntas existenciales',
    };
  if (sameOpening(text, recent))
    return {
      ok: false,
      reason:
        'empieza igual que un mensaje anterior; cambia la estructura de la frase y no abras con el tiempo o el contador',
    };
  const structure = structureKey(text);
  if (structure && usedStructures.has(structure))
    return {
      ok: false,
      reason:
        'repite la estructura "Manu lleva N caídas y el FUA…" de este stream; no cites el contador y cambia de enfoque',
    };
  if (exactMinutes(text)) return { ok: false, reason: EXACT_MINUTES_REASON };
  if (citesViewers(text)) return { ok: false, reason: VIEWERS_REASON };
  const listed = wordListProblem(text);
  if (listed) return { ok: false, reason: `${listed}; cuenta de qué ha hablado el chat en general, con tus palabras` };
  const repeatedMark = repeatedInStream(text, usedStructures, currentGame);
  if (repeatedMark) return { ok: false, reason: repeatedMark };
  if (citesGameScore(text)) return { ok: false, reason: 'cita la nota o la fuente del juego; no la menciones' };
  if (/@\w/.test(text)) return { ok: false, reason: 'no etiquetes a nadie con @' };
  const style = styleProblem(text, { player, now: new Date(now) });
  if (style) return { ok: false, reason: style.reason };
  const copied = copiedFromChat(text, chatLines, {
    allowed: [...allowedWords, currentGame],
    gameWords,
    numbers: [deathCount, ...extraDeathNumbers],
  });
  if (copied) return { ok: false, reason: `copia del chat «${copied}»; cuenta la idea con tus propias palabras` };
  const invented = allowedWords.length
    ? inventedDetail(text, {
        allowed: [...allowedWords, currentGame],
        gameWords,
        names: chatLines.map((l) => l.username),
      })
    : '';
  if (invented) return { ok: false, reason: INVENTED_REASON(invented) };
  const abbreviated = abbreviatedGame(text, currentGame);
  if (abbreviated) return { ok: false, reason: ABBREVIATED_REASON(abbreviated, currentGame) };
  if (matchesFormula(text) && repeatsFormula(text, recent))
    return { ok: false, reason: 'repite una fórmula que ya usaste' };
  if (tooSimilar(text, recent, 0.5))
    return { ok: false, reason: 'repite una idea de un comentario anterior de este stream' };
  const other = mentionsOtherGame(text, currentGame, channelGames);
  if (other)
    return { ok: false, reason: `nombra otro videojuego (${other}); habla solo del juego actual o de ningún juego` };
  if (repeatsYear(text, recent))
    return { ok: false, reason: 'repite el año del juego que ya dijiste; no lo menciones' };
  const names = recentlyNamedIn(text, named, now, nameWindowMs);
  if (names.length)
    return { ok: false, reason: `nombra a ${names.join(', ')}, que ya se nombró hace poco; no lo repitas` };
  const game = gameTalkProblem(text);
  if (game) return { ok: false, reason: game };
  return { ok: true };
}

// Validación de respuestas a menciones (sin la parte de nombres: se responde al que escribe)
// ctx.question: lo que escribió el usuario (los consejos y las mecánicas solo valen si él los sacó)
// ctx.names: nicks que pueden aparecer (quien escribe y el chat); no cuentan como mayúsculas raras
// ctx.recentToUser: respuestas anteriores del bot a este usuario (sin repetir arranque, parecido ni cierre)
// ctx.usedStructures: marcas del stream (la coletilla final no sale dos veces)
function validateMention(
  text,
  { question = '', player = 'manu', names = [], recentToUser = [], usedStructures = new Set() } = {},
) {
  if (!text || text.length < 3) return { ok: false, rule: 'vacio', reason: 'vacío' };
  if (leaksTech(text))
    return {
      ok: false,
      rule: 'tech',
      reason: 'menciona datos, herramientas o IGDB; habla con personalidad, sin nada técnico',
    };
  if (genderedParlusorum(text))
    return {
      ok: false,
      rule: 'genero',
      reason: 'pone género a ParLusorum (la usan Manu y Pao); sin tía/tío/amigo/amiga',
    };
  if (hasLatam(text))
    return { ok: false, rule: 'latam', reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, rule: 'robot', reason: 'suena a rechazo de robot' };
  const style = styleProblem(text, { personal: false, minWords: 2, player, names });
  if (style) return { ok: false, rule: style.rule, reason: style.reason };
  if (mirrorsUser(text, question))
    return {
      ok: false,
      rule: 'espejo',
      reason: 'devuelve al usuario su propia frase («si tuvieras…»); responde con algo tuyo',
    };
  if (recentToUser.length && (sameOpening(text, recentToUser) || tooSimilar(text, recentToUser, 0.5)))
    return {
      ok: false,
      rule: 'repetido',
      reason: 'repite el arranque o las palabras de tus respuestas anteriores a este usuario; cambia la estructura',
    };
  const closing =
    (recentToUser.length && repeatsClosing(text, recentToUser)
      ? 'repite la coletilla final que ya usaste con este usuario; cierra con otra idea o sin frase final'
      : '') || repeatedClosing(text, usedStructures);
  if (closing) return { ok: false, rule: 'cierre', reason: closing };
  if (TIPS_RE.test(text) && !TIPS_RE.test(question))
    return { ok: false, rule: 'consejos', reason: 'ofrece consejos o tips que nadie ha pedido' };
  if (REDIRECT_RE.test(text) && !MECHANICS_RE.test(question))
    return {
      ok: false,
      rule: 'redirect',
      reason: 'dice que no habla de mecánicas cuando nadie las ha mencionado; responde a lo que dice el usuario',
    };
  return { ok: true };
}

module.exports = {
  vetAuto,
  styleProblem,
  validateAuto,
  validateCohost,
  validateHook,
  validateTimerIA,
  validateMention,
  gameTalkProblem,
  validateQueMePerdi,
};
