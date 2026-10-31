// Control de calidad puro de las respuestas de la IA (sin estado ni I/O): tono, repetición, emotes, muertes y cortes.

// Léxico latinoamericano que no encaja con un chat de España
const LATAM_RE = /\b(pucha|puchas|qu[eé] onda|(?:la|esa|esta) onda|[oó]rale|[aá]ndale|chido|chida|ahorita|ch[eé]vere|bac[aá]n|g[uü]ey|wey|parce|boludo|che|vos|platicar|platicamos|padr[ií]simo|no manches)\b/i;

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
const MECHANICS_RE = /\b(armas?|espad[oó]n|espadas?|combos?|parr(?:y|ies)|esquiv\w*|fase \d+|zonas?|mec[aá]nicas?|habilidad(?:es)?|dificultad|barra|ventana|resistencia|cadencia|recarga|build|ataques? (?:rojo|amarillo|especial)|torre|cuartel\w*)\b/i;
// La nota de RAWG no se cita en el chat
const RAWG_NOTE_RE = /\brawg\b|\b\d(?:[.,]\d+)?\s*\/\s*5\b/i;
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
const TECH_LEAK_RE = /\brawg\b|buscar_juego|herramientas?\b|bases? de datos|\bapi\b|\bmis datos\b|no tengo (?:los |esos )?datos/i;
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
  return null;
}

// Juzgar el ambiente del chat ("el chat está quieto/dormilón") no es un comentario, es relleno
const MOOD_JUDGING_RE = /\b(chat|ambiente|sala|canal)\b[^.!?]{0,40}\b(quiet[oa]s?|dormid[oa]s?|dormil[oó]n\w*|apagad[oa]s?|tranquil[oa]s?|silencios[oa]s?|muert[oa]s?|vac[ií][oa]s?|callad[oa]s?)\b|\b(silencio|calma) (en el|del) chat\b/i;
function judgesChatMood(text) { return MOOD_JUDGING_RE.test(String(text || '')); }

// Validación del cohost. ctx: { deathCount, recent: string[], named: Map, now, nameWindowMs }
// Devuelve { ok, reason, soft }. soft = fallo leve (nombre repetido, fórmula, parecido, juicio del ambiente):
// se reintenta una vez y, si persiste, se envía igual. Lo grave (soft ausente) se descarta.
function validateCohost(text, { deathCount = 0, recent = [], named = new Map(), now = Date.now(), nameWindowMs = 15 * 60 * 1000 } = {}) {
  if (!text || text.length < 8) return { ok: false, rule: 'vacio', reason: 'vacío o demasiado corto' };
  if (hasLatam(text)) return { ok: false, rule: 'latam', reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, rule: 'robot', reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, rule: 'muertes', reason: 'menciona muertes que no están en el contador' };
  const game = gameTalkProblem(text);
  if (game) return { ok: false, rule: 'juego', reason: game };
  const names = recentlyNamedIn(text, named, now, nameWindowMs);
  if (names.length) return { ok: false, soft: true, rule: 'nombre', reason: `nombra a ${names.join(', ')}, que ya se nombró hace poco; no lo repitas` };
  if (matchesFormula(text) && repeatsFormula(text, recent)) return { ok: false, soft: true, rule: 'formula', reason: 'repite una fórmula que ya usaste' };
  if (tooSimilar(text, recent)) return { ok: false, soft: true, rule: 'parecido', reason: 'se parece demasiado a un mensaje reciente' };
  if (judgesChatMood(text)) return { ok: false, soft: true, rule: 'ambiente', reason: 'juzga el ambiente del chat; reacciona a un tema concreto con humor' };
  return { ok: true };
}

// Hook anti-silencio: voz de Dios Fua, sin deporte, sin muertes inventadas ni repetir los últimos hooks
function validateHook(text, { deathCount = 0, recent = [] } = {}) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (SPORTS_RE.test(text)) return { ok: false, reason: 'usa metáforas de comentarista deportivo' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, reason: 'menciona muertes que no están en el contador' };
  if (tooSimilar(text, recent)) return { ok: false, reason: 'se parece demasiado a un hook reciente' };
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
function validateTimerIA(text, { deathCount = 0, recent = [], currentGame = '', channelGames = [], named = new Map(), now = Date.now(), nameWindowMs = 15 * 60 * 1000 } = {}) {
  if (!text || text.length < 8) return { ok: false, reason: 'vacío o demasiado corto' };
  if (SPORTS_RE.test(text)) return { ok: false, reason: 'usa metáforas de comentarista deportivo' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
  if (mentionsUnrecordedDeaths(text, deathCount)) return { ok: false, reason: 'menciona muertes que no están en el contador' };
  if (citesRawgScore(text)) return { ok: false, reason: 'cita la nota de RAWG; no la menciones' };
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

// Resumen de reserva sin IA: datos reales (muertes, juego) y en positivo
function positiveSummaryFallback({ game, durationMinutes, deathCount } = {}) {
  const juego = game ? ` de ${game}` : '';
  const datos = deathCount > 0 ? `${durationMinutes} minutos con ${deathCount} ${deathCount === 1 ? 'muerte' : 'muertes'}` : `${durationMinutes} minutos`;
  return `Gran stream${juego}: ${datos}, mucho FUA y muy buen ambiente en el chat.`;
}

// Validación de respuestas a menciones (sin la parte de nombres: se responde al que escribe)
function validateMention(text) {
  if (!text || text.length < 3) return { ok: false, reason: 'vacío' };
  if (leaksTech(text)) return { ok: false, reason: 'menciona datos, herramientas o RAWG; habla con personalidad, sin nada técnico' };
  if (genderedParlusorum(text)) return { ok: false, reason: 'pone género a ParLusorum (la usan Manu y Pao); sin tía/tío/amigo/amiga' };
  if (hasLatam(text)) return { ok: false, reason: 'usa expresiones latinoamericanas; escribe español de España' };
  if (isRobotRefusal(text)) return { ok: false, reason: 'suena a rechazo de robot' };
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

// Respuesta cortada por max_tokens (finish_reason 'length'): se queda con las frases completas si las hay
function dropTrailingFragment(text) {
  const t = String(text || '').trim();
  if (/[.!?…]$/.test(t)) return t;
  const end = lastSentenceEnd(t, t.length, 0.25);
  return end > 0 ? t.slice(0, end).trim() : t.replace(/[\s,;:¡¿-]+$/, '') + '.';
}

module.exports = {
  LATAM_RE, ROBOT_REFUSAL_RE, FORMULAS,
  judgesChatMood, hasLatam, isRobotRefusal, matchesFormula, mentionsUnrecordedDeaths, recentlyNamedIn, namesIn,
  hasEmote, emoteAllowed, stripEmotes, applyEmotePolicy, similarity, tooSimilar, repeatsFormula,
  validateCohost, validateHook, validateTimerIA, validateMention, gameTalkProblem, genderedParlusorum, negativeSummary, positiveSummaryFallback,
  mentionsOtherGame, claimsEnemyKills, validateQueMePerdi, repeatsYear,
  mentionsGame, talksAboutGames, leaksTech, mentionsMechanics, citesRawgScore, disparagesGame, isGameQuestion, isDeathQuestion, SPORTS_RE, lastSentenceEnd, cutAtSentence, dropTrailingFragment,
};
