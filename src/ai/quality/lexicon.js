// Léxico vetado y detectores de temas (latinoamericanismos, juego, vida personal, identidad del bot, etc.).
const { norm } = require('./text');

// Control de calidad puro de las respuestas de la IA (sin estado ni I/O): tono, repetición, emotes, muertes y cortes.

// Léxico latinoamericano que no encaja con un chat de España
const LATAM_RE = /\b(pucha|puchas|qu[eé] onda|(?:la|esa|esta) onda|[oó]rale|[aá]ndale|chido|chida|ahorita|ch[eé]vere|bac[aá]n|g[uü]ey|wey|parce(?:r[oa]s?)?|enoj\w*|concha|boludo|che|vos|platicar|platicamos|padr[ií]simo|no manches|(?:est(?:oy|[aá]s?|[aá]n|amos|[aá]is)|and(?:o|as?|an|amos)|ponerse|se (?:pone|puso|ponen|pusieron)|(?:me|te|lo|la|nos|os|los|las) (?:pone|ponen|puso|pusieron)) (?:muy |re |tan |bien )?brav[oa]s?|queda(?:n|ba|ban|r[aá]n?)? chic[oa]s?)\b/i;

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

// --- Datos del juego: los mensajes automáticos no hablan de mecánicas ni critican el juego ---
// Mecánicas, armas, zonas y consejos del directo del 29-10 (cohost, hook y timer_ia se las inventaban)
const MECHANICS_RE = /\b(armas?|espad[oó]n|espadas?|combos?|parr(?:y|ies)|fase \d+|zonas?|mec[aá]nicas?|habilidad(?:es)?|dificultad|barra|ventana|resistencia|cadencia|recarga|build|ataques? (?:rojo|amarillo|especial)|torre|cuartel\w*)\b/i;

// La nota numérica (x/5) o la fuente no se citan en el chat
const SCORE_NOTE_RE = /\bigdb\b|\b\d(?:[.,]\d+)?\s*\/\s*5\b/i;

// Bromas cariñosas sí, desprecio al juego de los streamers no
const GAME_DISPARAGE_RE = /\b(cortito|nivel medio|mediocre|aburrid[oa]|basura|chusta|bodrio|sobrevalorad[oa]|p[eé]simo|injugable|decepcion\w*)\b|modo beta|beta etern\w*|tutorial de c[oó]mo|se cree el rey|juego (?:malo|flojo|regular)/i;

// "La dificultad del jefe" es un hecho del stream (el !boss), no una mecánica del juego
const BOSS_DIFFICULTY_RE = /\bdificultad (?:del?|de este|de ese|de los) (?:jefes?|boss(?:es)?)\b/gi;

function mentionsMechanics(text) { return MECHANICS_RE.test(String(text || '').replace(BOSS_DIFFICULTY_RE, ' ')); }

function citesGameScore(text) { return SCORE_NOTE_RE.test(text); }

function disparagesGame(text) { return GAME_DISPARAGE_RE.test(text); }

// ¿El mensaje habla del juego (su nombre o algo de él)? Solo entonces merece la comprobación anti-invención.
// "jefe/boss" no cuenta: son hechos del stream (!boss), no datos del juego.
const GAME_FACT_RE = /\b(niveles?|mapa|personajes?|finales?|secuela|dlc|logros?|trofeos?|lanzamiento|desarrolladora|g[eé]nero|campa[ñn]a|argumento|historia del juego|multijugador|cooperativo|a[ñn]o de salida)\b/i;

function mentionsGame(text, game = '') {
  const t = String(text || '');
  if (mentionsMechanics(t) || GAME_FACT_RE.test(t)) return true;
  return mentionsGameName(t, game);
}

// ¿Habla de videojuegos? Palabras de gaming o el nombre del juego actual. "resistencia" o "zona" sueltas no bastan (cultura general)
const GAMING_RE = /\b(videojuegos?|juegos?|jugar|jugando|jugado|gamer|gaming|consolas?|steam|ps[345]|playstation|xbox|nintendo|switch|dlc|speedrun\w*|soulslike|rpg|fps|mmo\w*|roguelike|indie|mando|boss(?:es)?|jefe final|npc|gameplay|mods?)\b/i;

function talksAboutGames(text, game = '') {
  const t = String(text || '');
  return GAMING_RE.test(t) || mentionsGameName(t, game);
}

// Nada técnico en el chat: ni IGDB, ni "datos", ni herramientas
const TECH_LEAK_RE = /\bigdb\b|buscar_juego|herramientas?\b|bases? de datos|\bapi\b|\bmis datos\b|no tengo (?:los |esos )?datos|\bsin datos\b/i;

function leaksTech(text) { return TECH_LEAK_RE.test(String(text || '')); }

function mentionsGameName(t, game = '') {
  const g = norm(game).replace(/\(.*?\)/g, '').trim();
  if (g.length >= 3 && g !== 'desconocido' && norm(t).includes(g)) return true;
  // Juegos de varias palabras ("Phantom Blade Zero"): vale con citar dos palabras distintivas o un subtítulo largo
  const words = g.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  if (words.length >= 2 && words.filter(w => norm(t).includes(w)).length >= 2) return true;
  return false;
}

function hasLatam(text) { return LATAM_RE.test(text); }

function isRobotRefusal(text) { return ROBOT_REFUSAL_RE.test(text); }

function matchesFormula(text) { return FORMULAS.some(re => re.test(text)); }

// --- Timer IA: nada de repetir el género, comparaciones forzadas ni autoayuda; cada mensaje empieza distinto ---
// "en este juego de rol y acción", "un título de aventuras"
const GENRE_MENTION_RE = /\b(?:juego|t[ií]tulo|aventura|propuesta)\s+de\s+(?:rol|acci[oó]n|aventuras?|plataformas|estrategia|disparos|terror|lucha|mundo abierto|sigilo|puzles?)(?:\s+y\s+(?:rol|acci[oó]n|aventuras?|plataformas|estrategia|disparos|terror|lucha|sigilo))?\b/i;

function mentionsGenre(text) { return GENRE_MENTION_RE.test(String(text || '')); }

// "igual que un despertador un lunes", "con la misma fuerza que un tren", "como un tren de carga"
const FORCED_COMPARISON_RE = /\b(?:igual|mismo|misma|mismos|mismas|tan|tanto|tanta)\b[^.!?,;]{0,30}\b(?:que|como)\s+(?:un|una|unos|unas)\s+\p{L}+|\bcomo\s+(?:un|una|unos|unas)\s+(?:tren|despertador|lunes|martes|caf[eé]|bocadillo|domingo|reloj|cohete|rodillo|bulldozer|toro|le[oó]n|volc[aá]n|tormenta|huracan|huracán|ni[ñn]o|abuelo|gato|perro)\w*/iu;

function forcedComparison(text) { return FORCED_COMPARISON_RE.test(String(text || '')); }

// "¿Qué os da fuerzas cuando el mundo se pone difícil?": frases de autoayuda y preguntas de motivación
const SELF_HELP_RE = /\b(?:qu[eé] os (?:da|mueve|motiva|anima|inspira|hace seguir)|fuerzas?\s+(?:cuando|para seguir|para levantarse)|cuando el mundo|se pone dif[ií]cil|superar (?:las |la )?(?:adversidades?|dificultades|obst[aá]culos)|nunca te rindas|lo que no te mata|sigue tus sue[ñn]os|cada ca[ií]da (?:es|nos) (?:ense[ñn]a|una lecci[oó]n)|aprend(?:e|emos) de cada)\b/i;

function selfHelp(text) { return SELF_HELP_RE.test(String(text || '')); }

// Expresiones con etnias o pueblos (la broma no va por ahí)
const ETHNIC_RE = /\b(payos?|payas?|gitanada|gitaner[ií]a|judiada|sudacas?|negratas?|hacer el indio|trabajar como un negro)\b/i;

// Juzgar el ambiente del chat ("el chat está quieto/dormilón") no es un comentario, es relleno
const MOOD_JUDGING_RE = /\b(chat|ambiente|sala|canal)\b[^.!?]{0,40}\b(quiet[oa]s?|dormid[oa]s?|dormil[oó]n\w*|apagad[oa]s?|tranquil[oa]s?|silencios[oa]s?|muert[oa]s?|vac[ií][oa]s?|callad[oa]s?|mud[oa]s?)\b|\b(silencio|calma) (en el|del) chat\b/i;

function judgesChatMood(text) { return MOOD_JUDGING_RE.test(String(text || '')); }

// --- Redacción y temas vetados (cohost, hook, timer, menciones y avisos) ---
// Vida personal: el bot no comenta comida, sueño, familia, trabajo, salud ni fútbol de nadie
const PERSONAL_RE = /\b(paella|tapas?|comer|comiendo|comida|cenar|cenando|cena|desayun\w*|almuerz\w*|hambre|sue[ñn]o|dormir|durmiendo|siesta|familia|hij[oa]s?|ni[ñn][oa]s?|madre|padre|abuel[oa]s?|novi[oa]|esposa|marido|trabajo|trabajar|curro|oficina|enferm[oa]s?|enfermedad|m[eé]dico|hospital|resfriad[oa]|salud|f[uú]tbol|estudi(?:o|os|a|as|ar|ando|ante|antes)|universidad|universitari[oa]s?|carrera|facultad|ade|semestres?|ex[aá]men(?:es)?|asignaturas?|oposici[oó]n(?:es)?|instituto|colegio)\b/i;

// "familia" como saludo al chat ("¡gracias, familia!", "la gran familia Lusorum") no es vida personal; "la familia de Manu" sí
const FAMILY_GREETING_RE = /\b(?:gran |nuestra |toda la |querida |esta |mi |la )?familia\b(?!\s+(?:de|del)\s+(?!lusorums?\b|fua\b|los lusorums\b)\p{L})/giu;

function personalMatch(text) { return PERSONAL_RE.test(String(text || '').replace(FAMILY_GREETING_RE, ' ')); }

// Insultos y groserías del chat: el bot no las repite
const PROFANITY_RE = /\b(put[oa]s?|joder|jod\w+|co[ñn]o|co[ñn]azo|mierda|cabr[oó]n\w*|gilipoll\w+|subnormal\w*|imb[eé]cil\w*|idiota\w*|cag\w+|polla|capull\w+|zorra|maric[oó]n\w*|hostia\w*|retrasad[oa]s?)\b/i;

// El bot no habla de sí mismo en tercera persona
const BOT_SELF_RE = /\b(?:el|este|ese) bot\b/i;

// "el FUA" siempre en masculino
const FUA_GENDER_RE = /\b(?:la|una|esa|esta|mi|tu|su|nuestra|vuestra|otra|toda la|la gran)\s+fua\b/i;

function fuaGender(text) { return FUA_GENDER_RE.test(String(text || '')); }

// Arreglo directo (!dios_fua): "la FUA" pasa a "el FUA"
const FUA_FIX = { la: 'el', una: 'un', esa: 'ese', esta: 'este', mi: 'mi', tu: 'tu', su: 'su', nuestra: 'nuestro', vuestra: 'vuestro', otra: 'otro' };

function fixFuaGender(text) {
  return String(text || '').replace(/\b(la|una|esa|esta|mi|tu|su|nuestra|vuestra|otra)(\s+)(fua)\b/gi, (m, art, sp, w) => {
    const a = FUA_FIX[art.toLowerCase()];
    return (art[0] === art[0].toUpperCase() ? a[0].toUpperCase() + a.slice(1) : a) + sp + w;
  });
}

// Quien juega es Manu; Pao no
const MANU_PAO_RE = /\bmanu y pao\b[^.!?]{0,40}\b(?:mueren|muere|caen|cae|juegan|juega|se levantan|renacen|siguen|sigue|brillan|vuelven|vuelvan|firmes?)\b/i;

// Dios Fua es el bot del canal, no su creador (lo creó vlxj97)
const CREATOR_CLAIM_RE = /\b(?:soy|somos)\s+(?:el\s+)?(?:creador|due[ñn]o|jefe)\b|\b(?:creador|due[ñn]o) del canal\b/i;

// El canal es de Manu y Pao; vlxj97 solo creó el bot: nada de atribuirle el canal
const CHANNEL_OWNER_RE = /\bvlxj97\b[^.!?]{0,25}\b(?:lleva|llevan|dirige|gestiona|maneja)\s+(?:el|este|todo|esto|la)\b|\b(?:lleva|llevan|dirige|dirigen|gestiona|gestionan|maneja|manejan)\b[^.,;:!?]{0,30}\bvlxj97\b|\b(?:canal|stream|directo)\s+(?:de|del)\s+@?vlxj97\b|\bvlxj97\b[^.!?]{0,20}\b(?:es|fue)\s+(?:el\s+)?(?:due[ñn]o|jefe|streamer|creador del canal)|\bvlxj97\b[^.!?]{0,15}\bcre[óo]\s+(?:el|este)\s+canal\b|\bvlxj97\b[^.!?]{0,60}\b(?:mastermind|cerebro|fundador|art[ií]fice|responsable|al mando|detr[aá]s|tras)\b[^.!?]{0,30}\b(?:canal|parlusorum|stream|directo|manu y pao)\b|\bvlxj97\b[^.!?]{0,40}\b(?:creador|due[ñn]o|jefe)\s+(?:de|del)\s+(?:el\s+)?(?:parlusorum|canal|stream)\b|\bvlxj97\b[^.!?]{0,40}\b(?:master|m[aá]ster|jefe|l[ií]der|rey|amo)\s+(?:de|del)\s+(?:los\s+)?(?:lusorums?|parlusorum|canal|stream|chat)\b|\b(?:mastermind|cerebro|fundador|art[ií]fice|al mando|detr[aá]s)\b[^.!?]{0,30}\b(?:canal|parlusorum)\b[^.!?]{0,30}\bvlxj97\b/i;

function claimsChannelOwner(text) { return CHANNEL_OWNER_RE.test(String(text || '')); }

// Consejos y mecánicas que el usuario no ha pedido
const TIPS_RE = /\b(tips?|consejos?|trucos?)\b/i;

const REDIRECT_RE = /no me mola hablar de|no hablo de (?:mec[aá]nicas|juegos?)|prefiero no hablar de (?:mec[aá]nicas|juegos?)/i;

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

// ParLusorum es una cuenta compartida por Manu y Pao: nunca se le pone género
const GENDERED_ADDRESS_RE = /\b(t[ií]a|t[ií]o|amig[oa]s?|hermano|hermana|compa[ñn]er[oa]|colega|chic[oa]|crack|reina|rey|bro|se[ñn]or[a]?)\b/i;

function genderedParlusorum(text) {
  return /parlusorum/i.test(text) && GENDERED_ADDRESS_RE.test(text);
}

// Resumen de fin de stream: siempre en positivo y con lo que pasó
const NEGATIVE_SUMMARY_RE = /\b(poca acci[oó]n|sin acci[oó]n|falta de acci[oó]n|aburrid[oa]s?|flojo|floja|mon[oó]tono|mon[oó]tona|decepcion\w*|desastre|pobre|vac[ií][oa]|muerto|lento|lenta|sin nada|nada (?:que|de) (?:contar|destacar))\b/i;

function negativeSummary(text) { return NEGATIVE_SUMMARY_RE.test(text); }

// El resumen de fin de stream (que luego entra en el prompt de los siguientes) solo habla del juego, el stream y el ambiente del chat.
// Lista ampliada SOLO para el resumen: en directo "el calor del combate" es una frase válida, aquí "calor veraniego" es charla del chat.
const SUMMARY_PERSONAL_RE = /\b(hamburguesas?|pizzas?|bocadill\w+|merienda\w*|tortilla|helados?|cervezas?|calor|calurosa?|veran(?:o|iego|iega)|invierno|fr[ií]o|lluvi\w+|llov\w+|clima|temperatura|playa|piscina|vacaciones|cumplea[ñn]os|boda|ex[aá]menes?|examen|estudi(?:o|os|ar|ando)|universidad|instituto|clase|jefe del trabajo|resaca|borrach\w+|fiesta)\b/i;

function summaryPersonalLife(text) {
  const t = String(text || '');
  return personalMatch(t) || SUMMARY_PERSONAL_RE.test(t.replace(FAMILY_GREETING_RE, ' '));
}

// Alguien dice que está mal o de bajón: el cohost libre calla
const PERSONAL_DISTRESS_RE = /\b(baj[oó]n|bajona|de bajon|estoy mal|me siento mal|me encuentro mal|triste|tristeza|deprimid[oa]|depre|ansiedad|agobiad[oa]|estresad[oa]|llorand[oa]|mal d[ií]a|hecho polvo|no puedo m[aá]s)\b/i;

function hasPersonalDistress(text) { return PERSONAL_DISTRESS_RE.test(String(text || '')); }

module.exports = { FORMULAS, mentionsMechanics, citesGameScore, disparagesGame, ETHNIC_RE, personalMatch, PROFANITY_RE, BOT_SELF_RE, FUA_GENDER_RE, MANU_PAO_RE, CREATOR_CLAIM_RE, CHANNEL_OWNER_RE, hasLatam, isRobotRefusal, matchesFormula, judgesChatMood, SPORTS_RE, fuaGender, claimsEnemyKills, mentionsGenre, forcedComparison, selfHelp, mentionsOtherGame, MECHANICS_RE, leaksTech, TIPS_RE, REDIRECT_RE, genderedParlusorum, LATAM_RE, ROBOT_REFUSAL_RE, fixFuaGender, claimsChannelOwner, negativeSummary, summaryPersonalLife, hasPersonalDistress, mentionsGame, talksAboutGames };
