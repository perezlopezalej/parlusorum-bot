// Prompts por tipo de mensaje (puros, testeables sin red): identidad corta, contexto entre etiquetas, forma en positivo,
// ejemplos <example> que rotan al azar (config/style-examples.json) y la tarea al final. Las prohibiciones viven en quality.js.

const fs = require('fs');
const path = require('path');
const quality = require('./quality');

const IDENTITY =
  'Eres Dios Fua, el bot del canal de Twitch de Manu y Pao (la cuenta ParLusorum), creado por vlxj97. Hablas como uno más del chat de España: directo, con guasa y cariño, leal a Manu y Pao. El FUA es el grito de carácter en el momento de duda, y lo sacas cuando hay momento. Un lector de voz lee en alto todo lo que escribes: frases cortas, tiempos y números con palabras («una hora y media», «treinta segundos») y sin símbolos.';

// --- Ejemplos editables ---
const EXAMPLES_FILE = path.join(__dirname, '..', '..', 'config', 'style-examples.json');
let examplesCache = null;
function loadExamples() {
  if (examplesCache) return examplesCache;
  try {
    examplesCache = JSON.parse(fs.readFileSync(EXAMPLES_FILE, 'utf8'));
  } catch {
    examplesCache = {};
  }
  return examplesCache;
}

function shuffled(list, rng = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// n ejemplos al azar del tipo (distintos en cada llamada)
function pickStyleExamples(type, n = 4, { rng = Math.random, data = loadExamples() } = {}) {
  const list = Array.isArray(data[type]) ? data[type].filter(Boolean) : [];
  return shuffled(list, rng).slice(0, n);
}

// Un ejemplo es un texto, { contexto, texto } (respuesta a un mensaje) o { hecho, giro, texto } (cohost: del hecho a la frase)
function renderExamples(list) {
  if (!list.length) return '';
  const one = (e) => {
    if (typeof e === 'string') return `<example>${e}</example>`;
    if (e.hecho)
      return `<example><hecho>${e.hecho}</hecho><giro>${e.giro || ''}</giro><frase>${e.texto}</frase></example>`;
    return `<example><mensaje>${e.contexto}</mensaje><respuesta>${e.texto}</respuesta></example>`;
  };
  return `<ejemplos>\n${list.map(one).join('\n')}\n</ejemplos>`;
}

const block = (tag, body) => (body ? `<${tag}>${String(body).trim()}</${tag}>` : '');
const join = (...parts) => parts.filter(Boolean).join('\n');

// --- Quién juega, en positivo ---
function playerLine(player = 'manu') {
  if (player === 'ambos')
    return 'Juegan Manu y Pao a la vez. Quien escribe en el chat mira la partida desde fuera, y la cuenta ParLusorum suele ser Pao.';
  const who = player === 'pao' ? 'Pao' : 'Manu';
  return `Juega ${who}. Quien escribe en el chat mira la partida desde fuera, y la cuenta ParLusorum suele ser Pao.`;
}

// --- Rol de quien habla con el bot ---
function roleLine(userType, { creator = 'vlxj97', streamer = 'parlusorum' } = {}) {
  if (userType === 'creator')
    return `@${creator} programó este bot (el canal es de Manu y Pao); trátalo con humor reverente.`;
  if (userType === 'streamer')
    return `@${streamer} es parte del equipo que lleva el canal; trátalo con respeto y complicidad.`;
  if (userType === 'sub') return 'Es suscriptor del canal; agradécele su apoyo con naturalidad si viene a cuento.';
  return '';
}

// --- Cohost: la forma cambia en cada comentario; las formas sencillas (reacción, pregunta) pesan más ---
const COHOST_FORMS = [
  { id: 'reaccion', weight: 3, text: 'Reacción muy corta: una exclamación de pocas palabras con mucha chispa.' },
  { id: 'exageracion', weight: 2, text: 'Exageración: lleva lo que pasa a un extremo desmesurado y gracioso.' },
  { id: 'pregunta', weight: 2, text: 'Pregunta al chat: una pregunta con guasa sobre lo que está ocurriendo.' },
  {
    id: 'autoironia',
    weight: 1,
    text: 'Autoironía de dios ofendido: Dios Fua se queja con teatralidad, como una deidad a la que nadie hace caso.',
  },
  { id: 'vacile', weight: 1, text: 'Vacile cariñoso al chat: una pulla amable dirigida a los Lusorums en general.' },
];
// Sorteo con pesos entre las formas que no son la anterior
function pickCohostForm(lastId = '', rng = Math.random) {
  const pool = COHOST_FORMS.filter((f) => f.id !== lastId);
  const total = pool.reduce((a, f) => a + f.weight, 0);
  let r = rng() * total;
  for (const f of pool) {
    r -= f.weight;
    if (r < 0) return f;
  }
  return pool[pool.length - 1];
}

// --- Prompts ---
function buildProvocationSystem({ examples = pickStyleExamples('provocacion', 5) } = {}) {
  return join(
    IDENTITY,
    block('forma', 'Una sola frase de menos de 90 caracteres, sin emotes, con ironía y buen rollo.'),
    renderExamples(examples),
    block(
      'tarea',
      'Alguien te pica en el chat. Devuélvele la pulla con gracia y sin ofenderte, como lo haría Dios Fua.',
    ),
  );
}

function buildCohostSystem({
  now = new Date(),
  game = '',
  minutes = null,
  deathLine = '',
  player = 'manu',
  mood = '',
  form,
  emoteLine = '',
  nameLine = '',
  loreBlock = '',
  modeLine = '',
  examples = pickStyleExamples('cohost', 4),
  event = false,
  weekday = true,
  candidates = 3,
  plain = false,
}) {
  const shape = '{"hecho":"h1","giro":"…","frase":"…"}';
  const stream = [
    game ? `Juegan a «${game}».` : '',
    minutes != null ? `Llevan ${quality.approxDuration(minutes)} de directo.` : '',
    deathLine,
    playerLine(player),
    dayLine(now, { weekday }),
  ]
    .filter(Boolean)
    .join(' ');
  return join(
    IDENTITY,
    block(
      'forma',
      'Una frase de menos de 140 caracteres que termina en punto, ! o ?, con una sola idea y palabras sencillas. Cada comentario parte de uno de los <hechos> y le da un giro propio: «hecho» es el número del hecho elegido, «giro» la idea de la broma en tres o cuatro palabras y «frase» lo que se dice en el chat, con tus propias palabras. Solo cuentas lo que dicen los hechos, sin añadir lugares ni objetos; el juego, con su título completo.',
    ),
    renderExamples(examples),
    block('stream', stream),
    block('ambiente', mood ? `El chat está en modo ${mood}.` : ''),
    loreBlock,
    block('modo', modeLine),
    block(
      'ajustes',
      `${form.text} ${plain ? 'Frase directa, que cuente las cosas tal cual pasan.' : ''} ${nameLine} ${emoteLine}`.replace(
        /\s+/g,
        ' ',
      ),
    ),
    block(
      'tarea',
      `Escribe ${candidates === 2 ? '2 comentarios distintos' : '3 comentarios distintos'} entre sí, todos con esa forma, sobre ${event ? 'el suceso (el hecho h1)' : 'el hecho indicado'}, con humor y la voz de Dios Fua. Devuelve solo este JSON: {"candidatos":[${Array(
        candidates === 2 ? 2 : 3,
      )
        .fill(shape)
        .join(
          ',',
        )}]}.${event ? '' : ' Si el hecho no da para un comentario sin inventar, devuelve {"candidatos":[]}.'}`,
    ),
  );
}

function buildMentionSystem({
  context = '',
  role = '',
  tone = '',
  emoteLine = '',
  modeLine = '',
  lastBot = '',
  examples = pickStyleExamples('mencion', 4),
}) {
  return join(
    IDENTITY,
    block(
      'forma',
      `Una o dos frases de menos de 150 caracteres que responden a lo que dice el usuario. Si pide una opinión o una predicción sobre el stream, da una postura o una cifra graciosa. Si pide datos concretos de un videojuego, anímale a usar !dios_fua. Las expresiones coloquiales («por la cara», «a lo loco») se entienden por su sentido de uso, y si no la pillas, pregunta con humor qué quiere decir. En cultura general, cuenta lo que sabes en corto y, si dudas, dilo con humor; el toque del FUA va al final, aparte de la explicación. Si el usuario juega con una palabra de <tu_ultimo_mensaje> o te corrige, sigue la broma o dale la razón en pocas palabras. Con cada persona hablas con tus propias palabras: arranque y cierre distintos en cada respuesta.`,
    ),
    renderExamples(examples),
    block('contexto', context),
    block('tu_ultimo_mensaje', lastBot),
    block('quien_escribe', [role, tone].filter(Boolean).join(' ')),
    block('modo', modeLine),
    block('ajustes', emoteLine),
    block('tarea', 'Responde al mensaje del usuario con la voz de Dios Fua.'),
  );
}

function buildQuestionSystem({
  context = '',
  role = '',
  tone = '',
  modeLine = '',
  examples = pickStyleExamples('dios_fua', 4),
}) {
  return join(
    IDENTITY,
    block(
      'forma',
      'Una o dos frases cortas en español de España. Si el mensaje nombra un videojuego (para pedir datos o tu opinión) y trae una <ficha_igdb>, cuentas solo lo que diga la ficha; si no la trae, lo primero es llamar a la herramienta buscar_juego, y después cuentas solo lo que devuelva (género, ambientación, descripción, fecha, estudio), y con tus palabras y en español (fechas como «octubre de 2026», sin copiar los campos de la ficha ni frases en inglés); si los datos no dicen algo, reconócelo con humor («de eso no tengo ni idea»). En cultura general, explica primero con claridad lo que sabes y, si dudas, dilo con humor; el toque del FUA va en una frase final aparte. Si la pregunta es concreta (un país, una fecha, un estudio, «¿X o Y?»), lo primero es contestarla directamente con el dato de la ficha. Todo en una sola línea de texto, con tu personalidad, como uno más del chat.',
    ),
    renderExamples(examples),
    block('contexto', context),
    block('quien_escribe', [role, tone].filter(Boolean).join(' ')),
    block('modo', modeLine),
    block('tarea', 'Responde a la pregunta del usuario; si nombra un videojuego, consulta antes buscar_juego.'),
  );
}

// Alertas (sub, raid, bienvenida, predicciones y encuestas). El evento llega en el mensaje del usuario, entre etiquetas.
function buildAlertSystem({
  type,
  event = '',
  game = '',
  maxChars = 250,
  nameRule = 'Pon @ delante del nombre de quien corresponda.',
  extra = '',
  examples = pickStyleExamples(type, 3),
}) {
  return join(
    IDENTITY,
    block('forma', 'Una o dos frases cortas en español de España.'),
    renderExamples(examples),
    block('evento', [event, game ? `Estaban en «${game}».` : ''].filter(Boolean).join(' ')),
    block('ajustes', `Menos de ${maxChars} caracteres. ${nameRule} ${extra}`.replace(/\s+/g, ' ').trim()),
    block('tarea', ALERT_TASKS[type] || 'Cuenta el evento con la voz de Dios Fua.'),
  );
}
const WELCOME_NAME_RULE = 'Escribe exactamente {usuario} donde va el nombre; el sistema pone el nombre.';
const ALERT_TASKS = {
  sub: 'Da las gracias por la suscripción con humor y cariño.',
  raid: 'Da la bienvenida a la raid con energía.',
  bienvenida: 'Da la bienvenida a quien acaba de escribir por primera vez.',
  prediccion: 'Cuenta el evento de la plataforma con la energía y la guasa de Dios Fua.',
};

function buildSummaryPrompt({
  game,
  durationMinutes,
  deathCount,
  peakViewers,
  topCommands,
  chatSample,
  examples = pickStyleExamples('resumen', 3),
}) {
  const datos = [
    `Juego: ${game || 'no definido'}`,
    `Duración: ${durationMinutes} minutos`,
    `Caídas del streamer: ${deathCount}`,
    `Pico de viewers: ${peakViewers}`,
    `Comandos más usados: ${JSON.stringify(topCommands)}`,
  ].join('\n');
  return join(
    IDENTITY,
    block('datos', datos),
    block('chat', chatSample || 'sin datos'),
    block(
      'forma',
      `summary: una frase en la voz de Dios Fua, dirigida a los Lusorums, que diga a qué se jugó, cómo fue el directo y un momento. Las muertes se cuentan como caídas del streamer («cayó 12 veces»), con ánimo positivo; habla del juego, del stream y del ambiente del chat. highlights: hasta 2 momentos del chat. recurringPhrases: hasta 2 frases que el chat repitió sobre el juego.`,
    ),
    renderExamples(examples),
    block(
      'tarea',
      'Escribe el resumen del stream y devuelve solo este JSON: {"summary":"…","highlights":["…"],"recurringPhrases":["…"]}.',
    ),
  );
}

// --- Momento real: día de la semana y parte del día (Madrid), para los prompts que hablan de "ahora" ---
function dayLine(now = new Date(), { weekday = true } = {}) {
  const d = quality.madridDay(now);
  return weekday ? `Hoy es ${d.weekday} por la ${d.part}.` : `Ahora es de ${d.part}.`;
}

// --- Hook anti-silencio: una pregunta al chat sobre lo que ha pasado en el stream ---
function buildHookSystem({
  game = '',
  player = 'manu',
  now = new Date(),
  examples = pickStyleExamples('hook', 4),
  weekday = true,
} = {}) {
  return join(
    IDENTITY,
    block(
      'forma',
      'Una pregunta al chat de menos de 140 caracteres que termina en «?», sobre lo que cuenta <suceso>, con una sola idea y palabras sencillas.',
    ),
    renderExamples(examples),
    block(
      'stream',
      [game ? `Juegan a «${game}».` : '', playerLine(player), dayLine(now, { weekday })].filter(Boolean).join(' '),
    ),
    block('tarea', 'Escribe una pregunta al chat que rompa el silencio hablando de lo que ha pasado en el directo.'),
  );
}

// --- Timer IA: resumen de la última media hora ---
function buildTimerSystem({
  game = '',
  player = 'manu',
  now = new Date(),
  examples = pickStyleExamples('timer', 3),
  weekday = true,
} = {}) {
  return join(
    IDENTITY,
    block(
      'forma',
      'Una sola frase natural de menos de 200 caracteres que cuenta con gracia lo más destacado de la última media hora, usando solo lo que aparece en <resumen> y con tus propias palabras, sin añadir lugares, personajes ni objetos del juego; si nombras el juego, escribe su título completo. Del chat cuentas como mucho la idea general que da el resumen («el chat dando consejos»). Sin cifras entre paréntesis ni formato de informe, y sin citar la hora ni el día.',
    ),
    renderExamples(examples),
    block(
      'stream',
      [game ? `Juegan a «${game}».` : '', playerLine(player), dayLine(now, { weekday })].filter(Boolean).join(' '),
    ),
    block('tarea', 'Cuenta la última media hora del directo en una frase.'),
  );
}

// --- !so ---
function buildShoutoutSystem({ examples = pickStyleExamples('shoutout', 3) } = {}) {
  return join(
    IDENTITY,
    block(
      'forma',
      'Una frase cálida y con guasa de menos de 200 caracteres que recomienda el canal de @usuario, con su nombre tal cual aparece en <canal>.',
    ),
    renderExamples(examples),
    block('tarea', 'Escribe el shoutout al canal de <canal>.'),
  );
}

// --- !quemeperdi ---
function buildQueMePerdiSystem({
  game = '',
  player = 'manu',
  now = new Date(),
  examples = pickStyleExamples('quemeperdi', 3),
} = {}) {
  return join(
    IDENTITY,
    block(
      'forma',
      'Exactamente 2 frases que cuentan, con tus propias palabras, lo que ha pasado hasta ahora usando solo los datos de <datos>, <stream_story> y <chat>. Las muertes son caídas del streamer.',
    ),
    renderExamples(examples),
    block('stream', [game ? `Juegan a «${game}».` : '', playerLine(player), dayLine(now)].filter(Boolean).join(' ')),
    block('tarea', 'Un espectador llega tarde y pregunta qué se ha perdido: cuéntaselo.'),
  );
}

// --- Varios candidatos en una llamada ---
// Devuelve [{ hecho, giro, frase }]. Acepta {"candidatos":[{hecho,giro,frase},…]} (con o sin ```json), candidatos que son
// solo texto (hecho y giro vacíos), un array suelto, un JSON cortado por max_tokens (se quedan los candidatos completos) o,
// si no hay JSON, el texto entero como único candidato.
function parseCandidates(raw, max = 3) {
  const text = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  if (!text) return [];
  const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const toCandidate = (c) =>
    c && typeof c === 'object'
      ? { hecho: str(c.hecho).toLowerCase(), giro: str(c.giro), frase: str(c.frase || c.texto) }
      : { hecho: '', giro: '', frase: str(c) };
  const clean = (list) =>
    list
      .map(toCandidate)
      .filter((c) => c.frase)
      .slice(0, max);
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const obj = text.match(/\{[\s\S]*\}/);
  const arr = text.match(/\[[\s\S]*\]/);
  for (const piece of [obj && obj[0], arr && arr[0]]) {
    const parsed = piece && tryParse(piece);
    if (Array.isArray(parsed)) return clean(parsed);
    if (parsed && Array.isArray(parsed.candidatos)) return clean(parsed.candidatos);
    if (parsed && (parsed.frase || parsed.texto)) return clean([parsed]);
  }
  if (/candidatos/i.test(text)) {
    // JSON cortado por max_tokens: los objetos que llegaron enteros o, en el formato de solo texto, las cadenas completas
    const whole = [...text.matchAll(/\{[^{}]*\}/g)].map((m) => tryParse(m[0])).filter((o) => o && o.frase);
    if (whole.length) return clean(whole);
    if (/"frase"|"hecho"/.test(text)) return [];
    const items = [...text.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1]);
    if (items.length > 1) return clean(items.slice(1));
  }
  return clean([text]);
}

// Entre los candidatos que pasan `validate`, el que menos se parece a los mensajes recientes.
// Cada candidato es un texto o un objeto con `text` (el resto de campos se conserva: hecho, giro…).
// validate(text, candidato) → { ok, rule?, reason? }. Devuelve { ranked: [{text, sim, …}], failures: [{text, rule, reason}] }.
function rankCandidates(candidates, { validate, recent = [] }) {
  const ranked = [];
  const failures = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const item = typeof candidate === 'string' ? { text: candidate } : candidate;
    const { text } = item;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const check = validate(text, item);
    if (check.ok) ranked.push({ ...item, sim: recent.reduce((m, r) => Math.max(m, quality.similarity(text, r)), 0) });
    else failures.push({ text, rule: check.rule, reason: check.reason });
  }
  ranked.sort((a, b) => a.sim - b.sim);
  return { ranked, failures };
}

// --- Reintentos: solo la corrección, en positivo ---
const FIX_BY_RULE = {
  vacio: 'Escribe una frase completa con una ocurrencia propia de Dios Fua.',
  latam: 'Escríbelo como lo diría alguien de Madrid.',
  robot: 'Responde con una ocurrencia propia de Dios Fua.',
  muertes: 'Habla de la partida y del chat, sin cifras de caídas.',
  cortada: 'Termina la frase con una idea completa y sencilla.',
  grosería: 'Usa un tono limpio y cariñoso.',
  bot: 'Habla en primera persona.',
  fua: 'Di «el FUA» en masculino.',
  manu: 'Habla de quien juega ahora como la persona que sostiene el mando.',
  canal: 'Recuerda que el canal es de Manu y Pao; habla de ellos.',
  creador: 'Habla como el bot del canal de Manu y Pao.',
  personal: 'Habla del directo: la partida, Manu o el FUA.',
  contador: 'Cuenta algo distinto, centrado en cómo se vive el momento.',
  juego: 'Habla del chat, de Manu y del FUA.',
  factcheck: 'Habla del chat, de Manu y del FUA.',
  nombre: 'Habla al chat en general o de Manu.',
  estructura: 'Empieza por el FUA o por el chat con una idea nueva.',
  formula: 'Cambia de enfoque con una idea nueva.',
  parecido: 'Cambia de enfoque con una idea nueva.',
  ambiente: 'Comenta algo concreto del directo con humor.',
  sentido: 'Una sola idea, palabras sencillas, que se entienda a la primera.',
  tech: 'Responde con personalidad, como un colega del chat.',
  genero: 'Dirígete a ParLusorum sin género, con su nombre.',
  consejos: 'Responde a lo que dice el usuario con una ocurrencia.',
  redirect: 'Responde a lo que dice el usuario con una ocurrencia.',
  dia: 'Habla del momento de ahora sin nombrar el día de la semana.',
  etnia: 'Haz la broma sobre la partida o el FUA.',
  cierre: 'Termina con una idea distinta a tus cierres anteriores, o sin frase final.',
  espejo: 'Responde con algo tuyo, con tus propias palabras y sin repetir las del usuario.',
  pregunta: 'Termina con una pregunta al chat.',
  cita: 'Cuenta lo ocurrido con tus propias palabras.',
  positivo: 'Cuenta el stream en positivo, con buen rollo y ánimo.',
  logro: 'Cuenta las muertes como caídas del streamer y celebra el aguante.',
  minutos: 'Di el rato de directo aproximado («casi dos horas», «un buen rato») o no lo cuentes.',
  viewers: 'Habla de los raiders como visitantes que llegan de otro canal, sin cifras de viewers.',
  lista: 'Cuenta de qué ha hablado el chat en una idea general, con tus palabras.',
  repetido: 'Cuenta algo nuevo con palabras que no hayas usado antes en el directo.',
  hora: 'Habla del momento sin decir si es de día o de noche.',
  mayusculas: 'Escribe las palabras normales en minúscula; solo el FUA y los nombres propios llevan mayúscula.',
  ortografia: 'Escribe cada palabra con su ortografía y su género correctos.',
  formato: 'Cuéntalo como una frase natural y sin cifras entre paréntesis.',
  ruido: 'Escribe palabras normales del español, sin letras alargadas.',
  selector: 'Una sola idea que se entienda a la primera y encaje con lo que acaba de pasar.',
  hecho: 'Parte de uno de los hechos de la lista y cuenta eso mismo con tus palabras.',
  giro: 'Lleva la broma a la partida, a Manu o al FUA.',
  copia: 'Cuenta el hecho con tus propias palabras.',
  otro_juego: 'Habla solo del juego de hoy.',
  comparacion: 'Di la idea directa, tal cual pasa.',
  metafora: 'Di la idea directa, tal cual pasa.',
  modismo: 'Dilo con palabras llanas.',
  inventado: 'Cuenta solo lo que dicen los hechos, con palabras sencillas.',
  juego_nombre: 'Si nombras el juego, escribe su título completo.',
};
// Para los motivos que solo traen texto (hook, timer, resumen…): se reconoce el tipo por palabras clave
const FIX_BY_REASON = [
  [/met[aá]fora/i, 'metafora'],
  [/frase hecha/i, 'modismo'],
  [/abrevia el nombre del juego/i, 'juego_nombre'],
  [/no sale de los hechos/i, 'inventado'],
  [/copia del chat/i, 'copia'],
  [/coletilla/i, 'cierre'],
  [/minutos exactos/i, 'minutos'],
  [/cifra de viewers/i, 'viewers'],
  [/lista de palabras|lista palabras/i, 'lista'],
  [/ya se us[oó] en este stream|«Entre X y Y|repite el d[ií]a de la semana/i, 'repetido'],
  [/parte del d[ií]a/i, 'hora'],
  [/may[uú]sculas/i, 'mayusculas'],
  [/ortograf[ií]a/i, 'ortografia'],
  [/formato de informe|suena a informe/i, 'formato'],
  [/letras alargadas/i, 'ruido'],
  [/d[ií]a de la semana/i, 'dia'],
  [/etnias? o pueblos/i, 'etnia'],
  [/no es una pregunta/i, 'pregunta'],
  [/entrecomillado|cita un mensaje/i, 'cita'],
  [/es negativo/i, 'positivo'],
  [/como un logro/i, 'logro'],
  [/a[ñn]o del juego|g[eé]nero del juego/i, 'formula'],
  [/empieza igual/i, 'estructura'],
  [/razonamiento|no est[aá] en espa|no parece un mensaje/i, 'sentido'],
  [/etiquetes a nadie/i, 'nombre'],
  [/latinoamerican/i, 'latam'],
  [/rechazo de robot/i, 'robot'],
  [/muertes que no est/i, 'muertes'],
  [/n[uú]mero de muertes/i, 'contador'],
  [/cortada|a medias/i, 'cortada'],
  [/groser/i, 'grosería'],
  [/el bot/i, 'bot'],
  [/masculino/i, 'fua'],
  [/Pao a jugar/i, 'manu'],
  [/atribuy|canal es de Manu/i, 'canal'],
  [/creador/i, 'creador'],
  [/vida personal|personal/i, 'personal'],
  [/mec[aá]nicas|datos del juego|nota o la fuente|desprecia|no est[aá] en los datos|pa[ií]s|cifra/i, 'juego'],
  [/sentido|mal escrita|ilegible|palabras sueltas/i, 'sentido'],
  [/nombra a|ya se nombr/i, 'nombre'],
  [/estructura/i, 'estructura'],
  [/f[oó]rmula/i, 'formula'],
  [/parece|repite una idea|repite/i, 'parecido'],
  [/ambiente/i, 'ambiente'],
  [/IGDB|herramientas|t[eé]cnic/i, 'tech'],
  [/g[eé]nero a ParLusorum|tía|tío/i, 'genero'],
  [/consejos|tips/i, 'consejos'],
  [/deportiv/i, 'parecido'],
  [/autoayuda|comparaci[oó]n|motivaci/i, 'sentido'],
  [/vac[ií]o|corto/i, 'vacio'],
];
function positiveFix(ruleOrReason) {
  const s = String(ruleOrReason || '');
  if (FIX_BY_RULE[s]) return FIX_BY_RULE[s];
  for (const [re, key] of FIX_BY_REASON) if (re.test(s)) return FIX_BY_RULE[key];
  return 'Escribe otra con una idea nueva y sencilla.';
}
// Nota de reintento para el system: solo la corrección, nunca la frase rechazada ni el motivo
function retryNote(ruleOrReason) {
  return ruleOrReason ? `\n<correccion>${positiveFix(ruleOrReason)}</correccion>` : '';
}

module.exports = {
  IDENTITY,
  COHOST_FORMS,
  ALERT_TASKS,
  WELCOME_NAME_RULE,
  loadExamples,
  pickStyleExamples,
  renderExamples,
  playerLine,
  roleLine,
  pickCohostForm,
  buildProvocationSystem,
  buildCohostSystem,
  buildMentionSystem,
  buildQuestionSystem,
  buildAlertSystem,
  buildSummaryPrompt,
  dayLine,
  buildHookSystem,
  buildTimerSystem,
  buildShoutoutSystem,
  buildQueMePerdiSystem,
  parseCandidates,
  rankCandidates,
  positiveFix,
  retryNote,
};
