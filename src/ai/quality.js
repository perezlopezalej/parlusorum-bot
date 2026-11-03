// Control de calidad puro de las respuestas de la IA (sin estado ni I/O): tono, repetición, emotes, muertes y cortes.

// Léxico latinoamericano que no encaja con un chat de España
const LATAM_RE = /\b(pucha|puchas|qu[eé] onda|(?:la|esa|esta) onda|[oó]rale|[aá]ndale|chido|chida|ahorita|ch[eé]vere|bac[aá]n|g[uü]ey|wey|parce(?:r[oa]s?)?|enoj\w*|concha|boludo|che|vos|platicar|platicamos|padr[ií]simo|no manches)\b/i;

// Rechazos con voz de robot ("No puedo participar en eso", "Lo siento, no puedo ayudar")
const ROBOT_REFUSAL_RE = /\b(no puedo (?:participar|ayudar|ayudarte|responder|continuar|hacer eso|cumplir)|no es algo que (?:haga|pueda)|lo siento|como (?:ia|inteligencia artificial|modelo)|no estoy (?:programado|autorizado)|no me est[aá] permitido|no entiend[eo] esos insultos)\b/i;

// Fórmulas que el cohost repitió hasta el cansancio en el directo del 28-10
const FORMULAS = [
  /pr[oó]xim[ao] ca[ií]da/i,
  /(?:el )?fua (?:se )?(?:est[aá] )?(?:carg(?:a|ando|ándose)|cargado)/i,
  /\bcarg[aá]ndose\b/i,
  /(?:el )?silencio (?:es|se siente|pesa|est[aá])/i,
  /m[aá]s (?:quieto|pesado|denso) que/i,
  /vibra(?:r)? (?:al|como siempre)|hacen vibrar|el chat vibra/i,
  /energ[ií]a (?:pura|fua)/i,
];

// Metáforas de comentarista deportivo: el hook ya no debe sonar a narrador de fútbol
const SPORTS_RE = /\b(f[uú]tbol|gol(?:azo)?|goles|delantero|portero|champions|[aá]rbitro|var|penalti|tiempo extra|comentarista|narrador|estadio|afici[oó]n|liga|mundial|partido|balón)\b/i;

const DEATH_WORDS_RE = /\b(muert[eoa]s?|muri[oó]|morir|mori|ca[ií]das?|ca[ey]ó|caer|cae|caen|caerá|cay[oó]|fallece|palm[oó])\b/i;

// --- Datos del juego: los mensajes automáticos no hablan de mecánicas ni critican el juego ---
// Mecánicas, armas, zonas y consejos del directo del 29-10 (cohost, hook y timer_ia se las inventaban)
const MECHANICS_RE = /\b(armas?|espad[oó]n|espadas?|combos?|parr(?:y|ies)|fase \d+|zonas?|mec[aá]nicas?|habilidad(?:es)?|dificultad|barra|ventana|resistencia|cadencia|recarga|build|ataques? (?:rojo|amarillo|especial)|torre|cuartel\w*)\b/i;
// La nota de RAWG no se cita en el chat
const RAWG_NOTE_RE = /\brawg\b|\bigdb\b|\b\d(?:[.,]\d+)?\s*\/\s*5\b/i;
// Bromas cariñosas sí, desprecio al juego de los streamers no
const GAME_DISPARAGE_RE = /\b(cortito|nivel medio|mediocre|aburrid[oa]|basura|chusta|bodrio|sobrevalorad[oa]|p[eé]simo|injugable|decepcion\w*)\b|modo beta|beta etern\w*|tutorial de c[oó]mo|se cree el rey|juego (?:malo|flojo|regular)/i;

function mentionsMechanics(text) { return MECHANICS_RE.test(text); }
function citesRawgScore(text) { return RAWG_NOTE_RE.test(text); }
function disparagesGame(text) { return GAME_DISPARAGE_RE.test(text); }

// Preguntas concretas del juego (a !dios_fua) y por el contador de muertes (con el número real)
const GAME_TOPIC_RE = /\b(dificultad|armas?|espad\w+|jefes?|boss(?:es)?|zonas?|niveles?|mapa|build|personajes?|finales?|secuela|dlc|logros?|trofeos?|mec[aá]nicas?|habilidad(?:es)?|combos?|desbloque\w*|versi[oó]n|f[ií]sica|plataformas?|lanzamiento|horas|capitulos?|cap[ií]tulos?|modo|historia|se puede|sale|salida)\b/i;
const QUESTION_SHAPE_RE = /\?|^\s*(?:qu[eé]|c[oó]mo|cu[aá]nd[oa]|cu[aá]nt[oa]s?|d[oó]nde|cu[aá]l(?:es)?|por qu[eé]|hay|se puede|puedo|puedes?|sabes?)\b/i;
function isGameQuestion(text) { return GAME_TOPIC_RE.test(text) && QUESTION_SHAPE_RE.test(text); }
const DEATH_QUESTION_RE = /\b(cu[aá]ntas|cu[aá]ntos)\b.*\b(muertes?|veces|ca[ií]das?)\b|\bmuertes?\b.*\b(llev\w+|hay|van|total)\b|\b(llev\w+|van)\b.*\bmuertes?\b/i;
function isDeathQuestion(text) { return DEATH_QUESTION_RE.test(text) && /\?|cu[aá]nt|llev|van\b/i.test(text); }


// ¿El mensaje habla del juego (su nombre o algo de él)? Solo entonces merece la comprobación anti-invención.
// "jefe/boss" no cuenta: son hechos del stream (!boss), no datos del juego.
const GAME_FACT_RE = /\b(niveles?|mapa|personajes?|finales?|secuela|dlc|logros?|trofeos?|lanzamiento|desarrolladora|g[eé]nero|campa[ñn]a|argumento|historia del juego|multijugador|cooperativo|a[ñn]o de salida)\b/i;
function mentionsGame(text, game = '') {
  const t = String(text || '');
  if (MECHANICS_RE.test(t) || GAME_FACT_RE.test(t)) return true;
  return mentionsGameName(t, game);
}

// ¿Habla de videojuegos? Palabras de gaming o el nombre del juego actual. "resistencia" o "zona" sueltas no bastan (cultura general)
const GAMING_RE = /\b(videojuegos?|juegos?|jugar|jugando|jugado|gamer|gaming|consolas?|steam|ps[345]|playstation|xbox|nintendo|switch|dlc|speedrun\w*|soulslike|rpg|fps|mmo\w*|roguelike|indie|mando|boss(?:es)?|jefe final|npc|gameplay|mods?)\b/i;
function talksAboutGames(text, game = '') {
  const t = String(text || '');
  return GAMING_RE.test(t) || mentionsGameName(t, game);
}

// Nada técnico en el chat: ni RAWG, ni "datos", ni herramientas
const TECH_LEAK_RE = /\brawg\b|\bigdb\b|buscar_juego|herramientas?\b|bases? de datos|\bapi\b|\bmis datos\b|no tengo (?:los |esos )?datos/i;
function leaksTech(text) { return TECH_LEAK_RE.test(String(text || '')); }

function mentionsGameName(t, game = '') {
  const g = norm(game).replace(/\(.*?\)/g, '').trim();
  if (g.length >= 3 && g !== 'desconocido' && norm(t).includes(g)) return true;
  // Juegos de varias palabras ("Phantom Blade Zero"): vale con citar dos palabras distintivas o un subtítulo largo
  const words = g.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  if (words.length >= 2 && words.filter(w => norm(t).includes(w)).length >= 2) return true;
  return false;
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

function hasLatam(text) { return LATAM_RE.test(text); }
function isRobotRefusal(text) { return ROBOT_REFUSAL_RE.test(text); }
function matchesFormula(text) { return FORMULAS.some(re => re.test(text)); }

// Muertes: con contador a 0 no se habla de muertes/caídas; si se cita una cifra debe ser la del contador
function mentionsUnrecordedDeaths(text, deathCount) {
  if (!DEATH_WORDS_RE.test(text)) return false;
  if (!deathCount) return true;
  const nums = [...text.matchAll(/(?:#|n[uú]mero |muerte |ca[ií]da )(\d+)|(\d+)\s*(?:muertes?|ca[ií]das?|veces)/gi)].map(m => parseInt(m[1] || m[2], 10));
  return nums.some(n => n !== deathCount);
}

// Usuarios nombrados en `text` (con o sin @) que ya se nombraron hace menos de windowMs. named: Map<login, ts>
function recentlyNamedIn(text, named, now, windowMs) {
  const t = norm(text);
  const hits = [];
  for (const [login, ts] of named) {
    if (now - ts >= windowMs) continue;
    const re = new RegExp(`(?:^|[^a-z0-9_])@?${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`);
    if (re.test(t)) hits.push(login);
  }
  return hits;
}

// Logins del `candidates` que aparecen en el texto (para marcarlos como nombrados)
function namesIn(text, candidates) {
  const t = norm(text);
  return [...new Set(candidates.map(norm).filter(Boolean))].filter(login => {
    const re = new RegExp(`(?:^|[^a-z0-9_])@?${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`);
    return re.test(t);
  });
}

// --- Emotes: como mucho 1 de cada 3 mensajes ---
const emoteRe = emotes => new RegExp(`(?:${emotes.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
const hasEmote = (text, emotes) => emotes.length > 0 && emoteRe(emotes).test(text);

// Se permite emote solo si ninguno de los 2 últimos mensajes del bot (más recientes al final) llevó
function emoteAllowed(recentBotMessages, emotes) {
  return !recentBotMessages.slice(-2).some(m => hasEmote(m, emotes));
}

// Espacio sobrante antes de signos de puntuación; no toca "usa !comando" (el signo va pegado a una palabra)
const SPACE_BEFORE_PUNCT_RE = /\s+([,.;:!?…])(?![\p{L}\p{N}_])/gu;

function stripEmotes(text, emotes) {
  if (!emotes.length) return text;
  return text.replace(emoteRe(emotes), '').replace(SPACE_BEFORE_PUNCT_RE, '$1').replace(/ {2,}/g, ' ').trim();
}

// Aplica la política: sin permiso se quitan todos; con permiso se deja como mucho el primero
function applyEmotePolicy(text, allowed, emotes) {
  if (!emotes.length) return text;
  if (!allowed) return stripEmotes(text, emotes);
  let seen = false;
  return text.replace(emoteRe(emotes), m => (seen ? '' : (seen = true, m))).replace(/ {2,}/g, ' ').replace(SPACE_BEFORE_PUNCT_RE, '$1').trim();
}

// --- Repetición: palabras de contenido compartidas con mensajes recientes ---
const contentWords = s => new Set(norm(s).split(/[^a-z0-9]+/).filter(w => w.length >= 5));
function similarity(a, b) {
  const A = contentWords(a), B = contentWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}
function tooSimilar(text, recent, threshold = 0.6) {
  return recent.some(r => similarity(text, r) >= threshold);
}
function repeatsFormula(text, recent) {
  return FORMULAS.some(re => re.test(text) && recent.some(r => re.test(r)));
}

// Motivo de rechazo si el mensaje automático habla de mecánicas del juego, cita la nota de RAWG o desprecia el juego
function gameTalkProblem(text) {
  if (mentionsMechanics(text)) return 'habla de mecánicas, armas o zonas del juego; habla solo del stream, el chat y el FUA';
  if (citesRawgScore(text)) return 'cita la nota de RAWG; no la menciones';
  if (disparagesGame(text)) return 'desprecia el juego de los streamers; bromas cariñosas sí, desprecio no';
  const attr = unsupportedAttributes(text, '', { persons: false });
  if (attr) return `afirma "${attr}" (país, cifra o presupuesto) que no está en los datos; no lo digas`;
  return null;
}

// Juzgar el ambiente del chat ("el chat está quieto/dormilón") no es un comentario, es relleno
const MOOD_JUDGING_RE = /\b(chat|ambiente|sala|canal)\b[^.!?]{0,40}\b(quiet[oa]s?|dormid[oa]s?|dormil[oó]n\w*|apagad[oa]s?|tranquil[oa]s?|silencios[oa]s?|muert[oa]s?|vac[ií][oa]s?|callad[oa]s?)\b|\b(silencio|calma) (en el|del) chat\b/i;
function judgesChatMood(text) { return MOOD_JUDGING_RE.test(String(text || '')); }

// --- Redacción y temas vetados (cohost, hook, timer, menciones y avisos) ---
// Vida personal: el bot no comenta comida, sueño, familia, trabajo, salud ni fútbol de nadie
const PERSONAL_RE = /\b(paella|tapas?|comer|comiendo|comida|cenar|cenando|cena|desayun\w*|almuerz\w*|hambre|sue[ñn]o|dormir|durmiendo|siesta|familia|hij[oa]s?|ni[ñn][oa]s?|madre|padre|abuel[oa]s?|novi[oa]|esposa|marido|trabajo|trabajar|curro|oficina|enferm[oa]s?|enfermedad|m[eé]dico|hospital|resfriad[oa]|salud|f[uú]tbol)\b/i;
// Insultos y groserías del chat: el bot no las repite
const PROFANITY_RE = /\b(put[oa]s?|joder|jod\w+|co[ñn]o|co[ñn]azo|mierda|cabr[oó]n\w*|gilipoll\w+|subnormal\w*|imb[eé]cil\w*|idiota\w*|cag\w+|polla|capull\w+|zorra|maric[oó]n\w*|hostia\w*|retrasad[oa]s?)\b/i;
// El bot no habla de sí mismo en tercera persona
const BOT_SELF_RE = /\b(?:el|este|ese) bot\b/i;
// "el FUA" siempre en masculino
const FUA_GENDER_RE = /\b(?:la|una|esa|esta|mi|tu|su)\s+fua\b/i;
// Quien juega es Manu; Pao no
const MANU_PAO_RE = /\bmanu y pao\b[^.!?]{0,40}\b(?:mueren|muere|caen|cae|juegan|juega|se levantan|renacen|siguen|sigue|brillan|vuelven|vuelvan|firmes?)\b/i;
// Dios Fua es el bot del canal, no su creador (lo creó vlxj97)
const CREATOR_CLAIM_RE = /\b(?:soy|somos)\s+(?:el\s+)?(?:creador|due[ñn]o|jefe)\b|\b(?:creador|due[ñn]o) del canal\b/i;
// El canal es de Manu y Pao; vlxj97 solo creó el bot: nada de atribuirle el canal
const CHANNEL_OWNER_RE = /\bvlxj97\b[^.!?]{0,25}\b(?:lleva|llevan|dirige|gestiona|maneja)\s+(?:el|este|todo|esto|la)\b|\b(?:lleva|llevan|dirige|dirigen|gestiona|gestionan|maneja|manejan)\b[^.,;:!?]{0,30}\bvlxj97\b|\b(?:canal|stream|directo)\s+(?:de|del)\s+@?vlxj97\b|\bvlxj97\b[^.!?]{0,20}\b(?:es|fue)\s+(?:el\s+)?(?:due[ñn]o|jefe|streamer|creador del canal)|\bvlxj97\b[^.!?]{0,15}\bcre[óo]\s+(?:el|este)\s+canal\b/i;
function claimsChannelOwner(text) { return CHANNEL_OWNER_RE.test(String(text || '')); }
// Final colgando ("el stream y.", "cuando la.")
const DANGLING_RE = /(?:^|\s)(?:y|e|o|u|a|de|del|la|el|los|las|un|una|que|con|por|para|en|se|su|sus|al|como|pero|cuando|mi|tu|ni|sin|sobre)$/i;
// Consejos y mecánicas que el usuario no ha pedido
const TIPS_RE = /\b(tips?|consejos?|trucos?)\b/i;
const REDIRECT_RE = /no me mola hablar de|no hablo de (?:mec[aá]nicas|juegos?)|prefiero no hablar de (?:mec[aá]nicas|juegos?)/i;

function isCutOff(text) {
  const t = String(text || '').replace(/\bparlus1\w+/gi, '').replace(/[\s.!?…¡¿"”»)]+$/, '').trim();
  return DANGLING_RE.test(t);
}
function talksPersonalLife(text) { return PERSONAL_RE.test(String(text || '')); }
function repeatsProfanity(text) { return PROFANITY_RE.test(String(text || '')); }

// Motivo de rechazo por redacción o tema vetado (null si pasa). opts.personal=false deja pasar la vida personal (menciones)
function styleProblem(text, { personal = true } = {}) {
  const t = String(text || '');
  if (isCutOff(t)) return { rule: 'cortada', reason: 'la frase está cortada o termina a medias; escribe una frase completa y sencilla' };
  if (PROFANITY_RE.test(t)) return { rule: 'grosería', reason: 'repite una grosería o insulto; no los repitas ni los cites' };
  if (BOT_SELF_RE.test(t) && !/\bsoy\b[^.!?]{0,30}\bbot\b/i.test(t)) return { rule: 'bot', reason: 'habla de sí mismo como "el bot"; habla en primera persona o como el FUA' };
  if (FUA_GENDER_RE.test(t)) return { rule: 'fua', reason: '"el FUA" va siempre en masculino' };
  if (MANU_PAO_RE.test(t)) return { rule: 'manu', reason: 'quien juega es Manu; no pongas a Pao a jugar ni a morir' };
  if (CHANNEL_OWNER_RE.test(t)) return { rule: 'canal', reason: 'el canal es de Manu y Pao; vlxj97 solo creó el bot, no le atribuyas el canal' };
  if (CREATOR_CLAIM_RE.test(t)) return { rule: 'creador', reason: 'eres el bot del canal, no su creador; te creó vlxj97' };
  if (personal && PERSONAL_RE.test(t)) return { rule: 'personal', reason: 'habla de vida personal (comida, sueño, familia, trabajo, salud, fútbol); habla solo del stream, el juego y el chat sobre la partida' };
  return null;
}

// Nombres ya citados: si la frase empieza con ellos como vocativo ("Mujica90, ...") se quitan; en otro sitio no hay arreglo (null)
function stripLeadingNames(text, names) {
  let t = String(text || '');
  for (const login of names) {
    const re = new RegExp(`^([¡¿"\\s]*)@?${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,:]\\s*`, 'i');
    t = t.replace(re, '$1');
  }
  t = t.replace(/^([¡¿"\s]*)(\p{Ll})/u, (_, p, c) => p + c.toUpperCase());
  return t.trim() ? t.trim() : null;
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

// Validación del cohost. ctx: { deathCount, recent: string[], sameKind: string[], named: Map, now, nameWindowMs }
// Devuelve { ok, reason, soft }. soft = fallo leve (nombre repetido, fórmula, parecido, juicio del ambiente):
// se reintenta una vez y, si persiste, se envía igual. Lo grave (soft ausente) se descarta.
function validateCohost(text, { deathCount = 0, recent = [], sameKind = [], named = new Map(), now = Date.now(), nameWindowMs = 15 * 60 * 1000, usedStructures = new Set() } = {}) {
  if (!text || text.length < 8) return { ok: false, rule: 'vacio', reason: 'vacío o demasiado corto' };
  if (hasLatam(text)) return { ok: false, rule: 'latam', reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, rule: 'robot', reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, rule: 'muertes', reason: 'menciona muertes que no están en el contador' };
  const style = styleProblem(text);
  if (style) return { ok: false, rule: style.rule, reason: style.reason };
  const game = gameTalkProblem(text);
  if (game) return { ok: false, rule: 'juego', reason: game };
  const names = recentlyNamedIn(text, named, now, nameWindowMs);
  if (names.length) return { ok: false, soft: true, rule: 'nombre', reason: `nombra a ${names.join(', ')}, que ya se nombró hace poco; no lo repitas` };
  const structure = structureKey(text);
  if (structure && usedStructures.has(structure)) return { ok: false, soft: true, rule: 'estructura', reason: 'repite la estructura "Manu lleva N caídas y el FUA…" que ya usaste en este stream; cambia de enfoque y no cites el contador' };
  if (matchesFormula(text) && repeatsFormula(text, recent)) return { ok: false, soft: true, rule: 'formula', reason: 'repite una fórmula que ya usaste' };
  if (tooSimilar(text, recent)) return { ok: false, soft: true, rule: 'parecido', reason: 'se parece demasiado a un mensaje reciente' };
  if (sameKind.length && tooSimilar(text, sameKind, 0.4)) return { ok: false, soft: true, rule: 'parecido', reason: 'repite una idea de otro comentario de este stream sobre lo mismo; cambia de enfoque' };
  if (judgesChatMood(text)) return { ok: false, soft: true, rule: 'ambiente', reason: 'juzga el ambiente del chat; reacciona a un tema concreto con humor' };
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
function validateHook(text, { deathCount = 0, recent = [] } = {}) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (SPORTS_RE.test(text)) return { ok: false, reason: 'usa metáforas de comentarista deportivo' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, reason: 'menciona muertes que no están en el contador' };
  if (tooSimilar(text, recent)) return { ok: false, reason: 'se parece demasiado a un hook reciente' };
  const style = styleProblem(text);
  if (style) return { ok: false, reason: style.reason };
  const game = gameTalkProblem(text);
  if (game) return { ok: false, reason: game };
  return { ok: true };
}

// Otros videojuegos que la IA suele citar por asociación ("vibra de Ragnarok y Sekiro"). Los del canal (games_played) se añaden aparte.
const OTHER_GAMES_RE = /\b(sekiro|elden ring|dark souls|bloodborne|ragnar[oö]k|god of war|hollow knight|nioh|wukong|genshin|zelda|mario|minecraft|fortnite|witcher|cyberpunk|devil may cry|bayonetta|ghost of (?:tsushima|y[oō]tei)|lies of p|stellar blade|hades|celeste|cuphead|resident evil|silent hill|last of us|it takes two|stick of truth)\b/i;
// Juego actual y juegos del canal, para no tratarlos como "otro juego" salvo que no sea el actual
function mentionsOtherGame(text, currentGame = '', channelGames = []) {
  const t = norm(text);
  const cur = norm(currentGame);
  const isCurrent = name => cur && (cur.includes(name) || name.includes(cur));
  for (const g of channelGames) {
    const n = norm(g).replace(/\(.*?\)/g, '').trim();
    if (n.length >= 4 && !isCurrent(n) && t.includes(n)) return g;
  }
  const m = norm(text).match(OTHER_GAMES_RE);
  return m && !isCurrent(m[1]) ? m[1] : null;
}

// "ha derribado 11 enemigos": el bot confundía muertes con victorias; no hay dato de enemigos derribados
const KILLS_CLAIM_RE = /\b(?:derrib\w+|elimin\w+|abati\w+|mat[oó]|liquid\w+|vencid\w+)\s+(?:a\s+)?(?:\d+|\w+)\s+enemig\w+|\b\d+\s+enemig\w+/i;
function claimsEnemyKills(text) { return KILLS_CLAIM_RE.test(String(text || '')); }

// !quemeperdi: validación del resumen; devuelve el motivo de rechazo o null
function validateQueMePerdi(text, { deathCount = 0, bosses = 0 } = {}) {
  if (achievesDeaths(text)) return 'presenta las muertes como un logro; son caídas del streamer';
  if (!text || text.length < 8) return 'vacío o demasiado corto';
  if (claimsEnemyKills(text)) return 'habla de enemigos derribados; no hay ese dato (las muertes son caídas del streamer)';
  if (hasLatam(text)) return 'usa expresiones latinoamericanas; escribe español de España';
  if (isRobotRefusal(text)) return 'suena a rechazo de robot';
  if (mentionsUnrecordedDeaths(text, deathCount)) return 'menciona muertes que no están en el contador';
  const boss = text.match(/(\d+)\s+(?:jefes?|bosses|boss)\b/i);
  if (boss && parseInt(boss[1], 10) !== bosses) return `cita ${boss[1]} jefes y llevamos ${bosses}`;
  return null;
}

// Años (2026...) que ya salieron en comentarios anteriores
function repeatsYear(text, recent) {
  const years = String(text).match(/\b20\d\d\b/g) || [];
  return years.some(y => recent.some(r => String(r).includes(y)));
}

// Comentario IA del timer: misma validación que el hook, sin nota de RAWG y sin repetir ideas del stream
// ctx.currentGame/channelGames: sin nombrar otros juegos; ctx.named: usuarios nombrados hace poco (no repetirlos)
function validateTimerIA(text, { deathCount = 0, recent = [], currentGame = '', channelGames = [], named = new Map(), now = Date.now(), nameWindowMs = 15 * 60 * 1000, usedStructures = new Set() } = {}) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (SPORTS_RE.test(text)) return { ok: false, reason: 'usa metáforas de comentarista deportivo' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, reason: 'menciona muertes que no están en el contador' };
  const structure = structureKey(text);
  if (structure && usedStructures.has(structure)) return { ok: false, reason: 'repite la estructura "Manu lleva N caídas y el FUA…" de este stream; no cites el contador y cambia de enfoque' };
  if (citesRawgScore(text)) return { ok: false, reason: 'cita la nota de RAWG; no la menciones' };
  if (/@\w/.test(text)) return { ok: false, reason: 'no etiquetes a nadie con @' };
  const style = styleProblem(text);
  if (style) return { ok: false, reason: style.reason };
  if (matchesFormula(text) && repeatsFormula(text, recent)) return { ok: false, reason: 'repite una fórmula que ya usaste' };
  if (tooSimilar(text, recent, 0.5)) return { ok: false, reason: 'repite una idea de un comentario anterior de este stream' };
  const other = mentionsOtherGame(text, currentGame, channelGames);
  if (other) return { ok: false, reason: `nombra otro videojuego (${other}); habla solo del juego actual o de ningún juego` };
  if (repeatsYear(text, recent)) return { ok: false, reason: 'repite el año del juego que ya dijiste; no lo menciones' };
  const names = recentlyNamedIn(text, named, now, nameWindowMs);
  if (names.length) return { ok: false, reason: `nombra a ${names.join(', ')}, que ya se nombró hace poco; no lo repitas` };
  const game = gameTalkProblem(text);
  if (game) return { ok: false, reason: game };
  return { ok: true };
}

// ParLusorum es una cuenta compartida por Manu y Pao: nunca se le pone género
const GENDERED_ADDRESS_RE = /\b(t[ií]a|t[ií]o|amig[oa]s?|hermano|hermana|compa[ñn]er[oa]|colega|chic[oa]|crack|reina|rey|bro|se[ñn]or[a]?)\b/i;
function genderedParlusorum(text) {
  return /parlusorum/i.test(text) && GENDERED_ADDRESS_RE.test(text);
}

// Resumen de fin de stream: siempre en positivo y con lo que pasó
const NEGATIVE_SUMMARY_RE = /\b(poca acci[oó]n|sin acci[oó]n|falta de acci[oó]n|aburrid[oa]s?|flojo|floja|mon[oó]tono|mon[oó]tona|decepcion\w*|desastre|pobre|vac[ií][oa]|muerto|lento|lenta|sin nada|nada (?:que|de) (?:contar|destacar))\b/i;
function negativeSummary(text) { return NEGATIVE_SUMMARY_RE.test(text); }

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
      if (/presupuesto/.test(n) && !/presupuesto|budget/.test(src)) return 'presupuesto';
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

// Sin datos de la fuente (IGDB/RAWG), cualquier desarrolladora o editora que cite la respuesta es inventada
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

// Alguien dice que está mal o de bajón: el cohost libre calla
const PERSONAL_DISTRESS_RE = /\b(baj[oó]n|bajona|de bajon|estoy mal|me siento mal|me encuentro mal|triste|tristeza|deprimid[oa]|depre|ansiedad|agobiad[oa]|estresad[oa]|llorand[oa]|mal d[ií]a|hecho polvo|no puedo m[aá]s)\b/i;
function hasPersonalDistress(text) { return PERSONAL_DISTRESS_RE.test(String(text || '')); }

// Estructuras de frase que el cohost/timer no debe repetir en el mismo stream ("Manu lleva 13 caídas y el FUA…")
const STRUCTURES = [
  ['lleva-caidas', /\blleva\s+\d+\s+(?:ca[ií]das?|muertes?)\b/i],
  ['contador-y-fua', /\b\d+\s+(?:ca[ií]das?|muertes?)\s+y\s+el\s+fua\b/i],
];
function structureKey(text) {
  const t = String(text || '');
  const hit = STRUCTURES.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

// "Qué juego es?" / "a qué juego juegan": se responde con el juego actual, sin IA
const CURRENT_GAME_RE = /^(?:y\s+)?(?:(?:a\s+)?(?:que|cual)\s+juego\s+(?:es|esta[ns]?|estais|juega[ns]?|jugais|es\s+este|es\s+el\s+de\s+hoy|toca)(?:\s+(?:jugando|hoy|ahora|este))?|(?:que|cual)\s+es\s+(?:el|este)\s+juego(?:\s+(?:de\s+hoy|que\s+juega[ns]?|que\s+estais\s+jugando))?|a\s+que\s+(?:juegas?|jugais|jugamos|estais\s+jugando))$/;
function isCurrentGameQuestion(text) {
  const t = norm(text).replace(/@\S+/g, '').replace(/\b(?:dios\s*fua|dios_fua|fua|bot)\b/g, '').replace(/[¿?!¡,.]/g, ' ').replace(/\s+/g, ' ').trim();
  return CURRENT_GAME_RE.test(t);
}

// Los nombres de usuario los pone el código: cualquier @nombre del texto que no sea uno de `names` se corrige al más parecido
// (distancia ≤ 3) o se quita. names: logins/displays reales; el resultado usa su grafía exacta
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}
function fixMentions(text, names = []) {
  const known = names.map(n => String(n || '').replace(/^@/, '')).filter(Boolean);
  return String(text || '').replace(/@(\w+)/g, (all, tag) => {
    const exact = known.find(n => n.toLowerCase() === tag.toLowerCase());
    if (exact) return `@${exact}`;
    const close = known.map(n => [n, editDistance(n.toLowerCase(), tag.toLowerCase())]).sort((a, b) => a[1] - b[1])[0];
    return close && close[1] <= 3 ? `@${close[0]}` : '';
  }).replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}

// Bienvenida: la IA escribe {usuario} donde quiere nombrar al recién llegado; el nombre lo inserta siempre el código
function insertUsername(text, username) {
  const clean = String(text || '').replace(/@\w+/g, '').replace(/\s{2,}/g, ' ').trim();
  if (/\{usuario\}/i.test(clean)) return clean.replace(/\{usuario\}/gi, `@${username}`);
  return `@${username} ${clean}`;
}

// "1 muerte" / "16 muertes", "1 bit" / "100 bits"
function countDeaths(n) { return `${n} ${Number(n) === 1 ? 'muerte' : 'muertes'}`; }
function countBits(n) { return `${n} ${Number(n) === 1 ? 'bit' : 'bits'}`; }

// "logrando 16 muertes": las muertes son caídas del streamer, no un logro
const ACHIEVED_DEATHS_RE = /\b(?:logr[\wáéíóú]*|consigu[\wáéíóú]*|alcanz[\wáéíóú]*|cosech[\wáéíóú]*|acumul[\wáéíóú]*|sum[\wáéíóú]*|anot[\wáéíóú]*|firm[\wáéíóú]*)\s+(?:un total de\s+|nada menos que\s+|hasta\s+)?\d+\s+(?:muertes?|ca[ií]das?)\b/i;
function achievesDeaths(text) { return ACHIEVED_DEATHS_RE.test(String(text || '')); }

// Resumen de reserva sin IA: datos reales (muertes, juego) y en positivo
function positiveSummaryFallback({ game, durationMinutes, deathCount } = {}) {
  const juego = game ? ` de ${game}` : '';
  const datos = deathCount > 0 ? `${durationMinutes} minutos con ${deathCount} ${deathCount === 1 ? 'muerte' : 'muertes'}` : `${durationMinutes} minutos`;
  return `Gran stream${juego}: ${datos}, mucho FUA y muy buen ambiente en el chat.`;
}

// Validación de respuestas a menciones (sin la parte de nombres: se responde al que escribe)
// ctx.question: lo que escribió el usuario (los consejos y las mecánicas solo valen si él los sacó)
function validateMention(text, { question = '' } = {}) {
  if (!text || text.length < 3) return { ok: false, reason: 'vacío' };
  if (leaksTech(text)) return { ok: false, reason: 'menciona datos, herramientas o RAWG; habla con personalidad, sin nada técnico' };
  if (genderedParlusorum(text)) return { ok: false, reason: 'pone género a ParLusorum (la usan Manu y Pao); sin tía/tío/amigo/amiga' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  const style = styleProblem(text, { personal: false });
  if (style) return { ok: false, reason: style.reason };
  if (TIPS_RE.test(text) && !TIPS_RE.test(question)) return { ok: false, reason: 'ofrece consejos o tips que nadie ha pedido' };
  if (REDIRECT_RE.test(text) && !MECHANICS_RE.test(question)) return { ok: false, reason: 'dice que no habla de mecánicas cuando nadie las ha mencionado; responde a lo que dice el usuario' };
  return { ok: true };
}

// --- Cortes en final de frase ---
// Fin (exclusivo) de la última frase completa dentro de `limit`; -1 si no hay ninguna razonable
function lastSentenceEnd(text, limit, minRatio = 0.3) {
  const head = text.slice(0, limit);
  let end = -1;
  for (const m of head.matchAll(/[.!?…]+(?=\s|$)/g)) end = m.index + m[0].length;
  return end > 0 && end >= limit * minRatio ? end : -1;
}

// Recorta `text` a `limit` caracteres terminando en frase; sin final de frase, en la última palabra y con punto
function cutAtSentence(text, limit) {
  if (text.length <= limit) return text;
  const end = lastSentenceEnd(text, limit);
  if (end > 0) return text.slice(0, end).trim();
  const head = text.slice(0, limit - 1);
  const sp = head.lastIndexOf(' ');
  if (sp < limit * 0.3) return text.slice(0, limit - 3) + '...';
  return head.slice(0, sp).replace(/[\s,;:¡¿-]+$/, '') + '.';
}

// Respuesta cortada por max_tokens (finish_reason 'length'): se queda con las frases completas; sin ninguna, vacío (nunca se cierra un fragmento con un punto)
function dropTrailingFragment(text) {
  const t = String(text || '').trim();
  if (/[.!?…]$/.test(t)) return t;
  const end = lastSentenceEnd(t, t.length, 0.25);
  return end > 0 ? t.slice(0, end).trim() : '';
}

// Muletillas de trato ("tío", "tía", "colega", "bro", "chaval") usadas como apelativo: se quitan siempre, con su
// coma, sin descartar el mensaje. Como sustantivo ("ese tío", "mi colega", "menudo tío") se respetan.
const FILLER_RE = /(,\s*)?(?<![\p{L}\p{N}_@])(?:t[ií][oa]|colega|bro|chaval)(?![\p{L}\p{N}_])(\s*,)?/giu;
const NOUN_CONTEXT_RE = /(?:^|[\s¡¿])(?:el|la|un|una|ese|esa|este|esta|aquel|mi|tu|su|otro|otra|del|al|buen[oa]?|gran|menud[oa]|vaya|qu[eé]|pobre|ning[uú]n|cada|como|ni)\s+$/i;

function stripFillers(text, re = FILLER_RE) {
  return String(text)
    .replace(re, (m, before, after, off, full) => {
      if (before && after) return ',';
      if (before) return '';
      if (NOUN_CONTEXT_RE.test(full.slice(0, off))) return m;
      if (off === 0 || /[.!?¡¿]\s*$/.test(full.slice(0, off))) return '\0';
      return after ? ',' : ' ';
    })
    .replace(/\0\s*(\p{L})/gu, (_, c) => c.toUpperCase())
    .replace(/\0/g, '')
    .replace(/,\s*([.!?…])/g, '$1')
    .replace(/\s+([,.;:!?…])(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/¡\s+/g, '¡')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const limitFillers = text => (typeof text === 'string' ? stripFillers(text) : text);

// "Lusorums" (la comunidad): solo al chat en general, en 1 de cada 4 mensajes del bot (como el emote, por
// ventana de los últimos 3) y nunca en un mensaje dirigido a una persona (empieza por @usuario).
const LUSORUMS_RE = /(,\s*)?(?<![\p{L}\p{N}_@])lusorums?(?![\p{L}\p{N}_])(\s*,)?/giu;
const hasLusorums = text => { LUSORUMS_RE.lastIndex = 0; return LUSORUMS_RE.test(String(text || '')); };

function limitLusorums(text, recentFlags = []) {
  if (typeof text !== 'string' || !hasLusorums(text)) return { text, had: false };
  if (!/^\s*@/.test(text) && !recentFlags.slice(-3).some(Boolean)) return { text, had: true };
  return { text: stripFillers(text, LUSORUMS_RE), had: false };
}

module.exports = {
  stripFillers, limitFillers, hasLusorums, limitLusorums,
  LATAM_RE, ROBOT_REFUSAL_RE, FORMULAS,
  judgesChatMood, hasLatam, isRobotRefusal, matchesFormula, mentionsUnrecordedDeaths, recentlyNamedIn, namesIn,
  hasEmote, emoteAllowed, stripEmotes, applyEmotePolicy, similarity, tooSimilar, repeatsFormula,
  vetAuto, styleProblem, claimsChannelOwner, isCutOff, talksPersonalLife, repeatsProfanity, stripLeadingNames, validateAuto,
  validateCohost, validateHook, validateTimerIA, validateMention, gameTalkProblem, genderedParlusorum, negativeSummary, positiveSummaryFallback,
  mentionsOtherGame, claimsEnemyKills, validateQueMePerdi, repeatsYear,
  unsupportedAttributes, inventedCompany, fixMentions, insertUsername, hasPersonalDistress, structureKey, isCurrentGameQuestion, countDeaths, countBits, achievesDeaths,
  mentionsGame, talksAboutGames, leaksTech, mentionsMechanics, citesRawgScore, disparagesGame, isGameQuestion, isDeathQuestion, SPORTS_RE, lastSentenceEnd, cutAtSentence, dropTrailingFragment,
};
