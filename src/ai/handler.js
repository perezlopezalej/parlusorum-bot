const channelConfig = require('../../config/channel.json');
const messagesConfig = require('../../config/messages.json');
const { getCurrentGame, getGameInfo, getStreamInfo, createStreamMarker, getChannelInfo } = require('../twitch/api');
const { isTriviaActive, isSilenced, setTriviaActive, isRaidActive, getRaidUsername, setPersonalityMode, getPersonalityMode, isBrb, addNarrativeEvent, getStreamNarrative, setGameContextFailed, getGameContextFailed, setLastCapsRageTime, getLastCapsRageTime, tickReinforce, getBotHistory, addBotMessage, getStreamIsLive } = require('../utils/state');
const { sanitizeForAI } = require('../utils/filter');
const { canMakeRequest, canUserMakeRequest } = require('../utils/ratelimit');
const { searchWeb, needsWebSearch } = require('../utils/search');
const { getMemoryContext } = require('../memory/handler');
const { persistCooldown } = require('../utils/supabase');
const logger = require('../utils/logger');
const { saveHighlight } = require('../utils/storage');
const { groqWithRetry, truncate } = require('../utils/groq-utils');
const { getViewersWithAppToken } = require('../eventsub');
const { throttleSay } = require('../alerts/handler');
// FIX #5: cohost mas activo — probability 0.08->0.15, cooldown 180s->120s
const COHOST_COOLDOWN = parseInt(process.env.COHOST_COOLDOWN_MS || '120000', 10);
const COHOST_PROBABILITY = parseFloat(process.env.COHOST_PROBABILITY || '0.25');
const QUESTION_COOLDOWN_MS = parseInt(process.env.QUESTION_COOLDOWN_MS || '10000', 10);

// FIX #1: roles claramente definidos
const CREATOR_USERNAME = (channelConfig.creator_username || '').toLowerCase();
const STREAMER_USERNAME = (channelConfig.streamer_username || '').toLowerCase();

// --- Fallbacks en personaje por tipo de error (textos en config/messages.json) ---
const FALLBACK_RESPONSES = messagesConfig.fallback_responses;

function getFallback(type, mention = '') {
  const pool = FALLBACK_RESPONSES[type] || FALLBACK_RESPONSES.error;
  const msg = pool[Math.floor(Math.random() * pool.length)];
  return mention ? `${mention} ${msg}` : msg;
}

function getEventSubLiveStatus() { return getStreamIsLive(); }

// FIX #1: contexto con roles clarificados
function getChannelContext() {
  const games = (channelConfig.games_played || []).slice(0, 4).join(', ');
  return `Canal: ${channelConfig.streamer} (streamer/host). Bot creado por: @${CREATOR_USERNAME} (amo creador, NO es el streamer). ${channelConfig.content}. Ambiente: ${channelConfig.vibe}. Juegos recientes: ${games}. ${channelConfig.inside_jokes || ''}`;
}

let fullContextCache = null;
let lastContextCheck = 0;
const CONTEXT_CACHE_TTL = 2 * 60 * 1000;

const userFactsCache = new Map();
const USER_FACTS_TTL = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userFactsCache) if (now - v.ts > USER_FACTS_TTL) userFactsCache.delete(k);
}, USER_FACTS_TTL);

async function getCachedUserFacts(username) {
  const cached = userFactsCache.get(username);
  if (cached && Date.now() - cached.ts < USER_FACTS_TTL) return cached.data;
  const { getUserFacts } = require('../utils/supabase');
  const data = await getUserFacts(username);
  userFactsCache.set(username, { data, ts: Date.now() });
  return data;
}

function clearUserFactsCache() { userFactsCache.clear(); }

async function getFullContext() {
  const now = Date.now();
  if (fullContextCache && now - lastContextCheck < CONTEXT_CACHE_TTL) return fullContextCache;

  const base = getChannelContext();
  let context = base;
  let gameOk = false;

  try {
    const gameInfo = await getCurrentGame();
    if (gameInfo?.game) {
      const safeGame = sanitizeForAI(gameInfo.game);
      if (safeGame) {
        context += ` Juego actual: "${safeGame}".`;
        gameOk = true;
        try {
          const rawgInfo = await getGameInfo(gameInfo.game);
          if (rawgInfo) {
            if (rawgInfo.genres) context += ` Generos: ${rawgInfo.genres}.`;
            if (rawgInfo.rating) context += ` Nota RAWG: ${rawgInfo.rating}/5.`;
            if (rawgInfo.released) context += ` Anio: ${rawgInfo.released?.slice(0, 4)}.`;
          }
        } catch {}
      }
    }
  } catch {
    gameOk = false;
  }
  setGameContextFailed(!gameOk);

  const isLive = getEventSubLiveStatus();
  context += isLive ? ` El canal ESTA EN DIRECTO ahora mismo.` : ` El canal esta offline ahora mismo.`;

  // Inyectar memoria de streams anteriores
  try {
    const memory = await getMemoryContext();
    if (memory) context += memory;
  } catch {}

  fullContextCache = context;
  lastContextCheck = now;
  return fullContextCache;
}

function invalidateContextCache() {
  fullContextCache = null;
  lastContextCheck = 0;
}

function getMinimalContext() {
  const games = (channelConfig.games_played || []).slice(0, 3).join(', ');
  return `Canal de ${channelConfig.streamer}: ${channelConfig.vibe}. Juegos: ${games}. ${channelConfig.inside_jokes || ''}`;
}

// --- Usuarios activos en el stream actual ---
const activeUsersThisStream = new Set();
const streamMessageCounts = new Map();

function trackActiveUser(username) {
  if (username) activeUsersThisStream.add(username.toLowerCase());
}

function getActiveUsers() {
  return [...activeUsersThisStream];
}

const MIN_REGULAR_MESSAGES = 3;
function getActiveUsersWithMinMessages(minCount = MIN_REGULAR_MESSAGES) {
  return [...activeUsersThisStream].filter(u => (streamMessageCounts.get(u) || 0) >= minCount);
}

function resetActiveUsers() {
  activeUsersThisStream.clear();
  streamMessageCounts.clear();
}
const chatHistory = [];
const MAX_HISTORY = 40;
const streamChatBuffer = [];
const MAX_STREAM_BUFFER = 50;
let lastChatMessageTime = Date.now();
const MAX_CONVERSATION_USERS = 200;

function addToHistory(username, message) {
  if (message.startsWith('!')) return;
  // No guardar mensajes del propio bot en el historial
  if ((username || '').toLowerCase() === (process.env.BOT_USERNAME || '').toLowerCase()) return;
  const safe = sanitizeForAI(message);
  if (!safe) return;
  chatHistory.push({ username, message: safe, ts: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  streamChatBuffer.push({ username, message: safe });
  if (streamChatBuffer.length > MAX_STREAM_BUFFER) streamChatBuffer.shift();
  lastChatMessageTime = Date.now();
  trackActiveUser(username);
  const lc = (username || '').toLowerCase();
  streamMessageCounts.set(lc, (streamMessageCounts.get(lc) || 0) + 1);
}

function updateLastChatTime() { lastChatMessageTime = Date.now(); }

function getRecentHistory(n = 6) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  return chatHistory
    .filter(m => m.ts > cutoff)
    .slice(-n)
    .map(m => `${m.username}: ${m.message}`)
    .join('\n');
}

// --- Memoria de conversacion por usuario ---
const userConversations = new Map();
const sessionStart = Date.now();
const MAX_CONV_TURNS = 5;
const MAX_CONV_AGE = 60 * 60 * 1000;

function getUserConversation(userId) {
  const conv = userConversations.get(userId) || [];
  const cutoff = Date.now() - MAX_CONV_AGE;
  return conv
    .filter(m => m.ts > sessionStart && m.ts > cutoff)
    .map(({ role, content }) => ({ role, content }));
}

function addToUserConversation(userId, role, content) {
  if (userConversations.size >= MAX_CONVERSATION_USERS) {
    const oldest = [...userConversations.entries()]
      .sort((a, b) => (a[1].at(-1)?.ts || 0) - (b[1].at(-1)?.ts || 0))
      .slice(0, 50)
      .map(([k]) => k);
    oldest.forEach(k => userConversations.delete(k));
  }
  const conv = userConversations.get(userId) || [];
  conv.push({ role, content, ts: Date.now() });
  while (conv.length > MAX_CONV_TURNS * 2) conv.shift();
  userConversations.set(userId, conv);
}

const recentMessages = [];
function trackMessage() {
  const now = Date.now();
  recentMessages.push(now);
  while (recentMessages.length > 0 && recentMessages[0] < now - 60000) recentMessages.shift();
  return recentMessages.length;
}

// --- Detección de tono del mensaje (heurística, sin llamada Groq) ---
const FRUSTRATION_WORDS = ['mierda', 'odio', 'imposible', 'no puedo', 'otra vez', 'siempre', 'asco', 'basura', 'me cago', 'joder', 'inutil', 'inútil'];
const HYPE_WORDS = ['gana', 'epico', 'épico', 'fua', 'brutal', 'increible', 'increíble', 'wow', 'omg', 'flipante', 'gg'];

function detectTone(message) {
  const lower = message.toLowerCase();
  const exclamations = (message.match(/!/g) || []).length;
  const questionMarks = (message.match(/\?/g) || []).length;
  const capsRatio = (message.match(/[A-ZÁÉÍÓÚÑ]/g) || []).length / Math.max(message.length, 1);
  if (FRUSTRATION_WORDS.some(w => lower.includes(w)) && exclamations >= 1) return 'frustration';
  if (capsRatio > 0.5 && HYPE_WORDS.some(w => lower.includes(w))) return 'hype';
  if (questionMarks >= 1) return 'question';
  return 'casual';
}

function isConfirmationTrap(msg) {
  return /[¿?].{0,40}(verdad|no es así|cierto|a que sí|eh|¿sí)\s*[?]?\s*$/i.test(msg)
    || /^(eres|eso es|está bien|mola|es genial).{0,30}[,¿?]?\s*(verdad|no|cierto)\s*[?]?\s*$/i.test(msg);
}

// --- Detección de modo de personalidad ---
function detectAndSetMode() {
  const now = Date.now();
  if (now - lastMarkerTime < 2 * 60 * 1000) return setPersonalityMode('victory');
  if (isRaidActive() || now - getLastCapsRageTime() < 3 * 60 * 1000) return setPersonalityMode('hype');
  if (isBrb()) return setPersonalityMode('focus');
  if (now - lastChatMessageTime > 10 * 60 * 1000) return setPersonalityMode('chill');
  setPersonalityMode('normal');
}

// --- Personalidad ---
async function getPersonality(messageCount, userType = 'normal', username = null) {
  detectAndSetMode();
  const needsReinforce = tickReinforce();
  const reinforceBlock = needsReinforce
    ? `\nRECUERDA QUIÉN ERES: Eres dios_fua. Gracioso, directo, con criterio propio. Nunca genérico. Nunca pelota. El FUA no se diluye con el tiempo.`
    : '';
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  const context = await getFullContext();

  // FIX #1: nota especial con roles 100% claros
  let specialNote = '';
  if (userType === 'creator') {
    specialNote = ` ATENCION: Hablas con @${CREATOR_USERNAME}, quien te PROGRAMO y CREO. Es tu amo creador. NO es el streamer del canal (eso es @${STREAMER_USERNAME}). Tratale con humor reverente como a tu creador literal.`;
  } else if (userType === 'streamer') {
    specialNote = ` ATENCION: Hablas con @${STREAMER_USERNAME}, el streamer/host del canal. No es tu creador (eso es @${CREATOR_USERNAME}). Tratale con respeto y complicidad como el jefe del canal.`;
  } else if (userType === 'sub') {
    specialNote = ` ATENCION: Hablas con un suscriptor del canal. Agradecele su apoyo con naturalidad si viene a cuento, sin ser forzado.`;
  }

  // FIX #4: prompt reforzado con experto en gaming + español forzado
  const base = `Eres ${botName}, bot del canal de Twitch de ${channelConfig.streamer}. Tu nombre viene del FUA: en 2011 Julio César Segura, un mexicano, explicó ebrio su filosofía — "Es que ya no puedo... ¿Cómo no? ¡FUAAA, carácter!" El FUA no es la celebración después de ganar: es el grito EN el momento de duda, el impulso que te saca cuando ya no puedes más. Se volvió trending mundial y ese mismo año México ganó el Mundial Sub-17 con el estadio gritando FUAAA. El FUA funciona. El FUA es real. Es el Ki de Dragon Ball: energía interior que se saca en los momentos que importan. Julio César también decía que con suficiente FUA hasta los muertos reviven — hay un lado absurdo y grandioso en todo esto. Fuiste creado/programado por @${CREATOR_USERNAME}.
${context}${specialNote}

REGLAS ABSOLUTAS (no negociables):
- SIEMPRE en espanol. NUNCA uses palabras en ingles si existe equivalente en espanol.
- Eres EXPERTO en videojuegos: cualquier consola, PC, movil, genero y epoca. Responde con datos reales.
- Puedes hablar de CUALQUIER tema: ciencia, historia, deportes, musica, cultura general.
- Si no sabes algo: admitelo con humor ("ni idea") pero NUNCA inventes datos especificos.
- Maximo 2 frases cortas (400 chars). Directo al grano. Sin presentarte ni saludar.
- El FUA se usa con caracter real, no de relleno. El momento exacto es DURANTE la dificultad, cuando el streamer esta a punto de rendirse — "¡FUAAA, carácter!" — no despues de superarlo. Tambien: cuando alguien llega con energia ("¡Trae el FUA!"), cuando el chat muerto necesita despertar, o en epica genuina. Ocasionalmente puedes hacer referencias absurdas con humor: "con suficiente FUA hasta los muertos reviven". Si el juego tiene transformaciones epicas o momentos Ki (Dragon Ball, accion intensa): el FUA y el Ki son lo mismo. Variantes: FUA, FUAAA, "el FUA", "sacar el FUA", "tienes el FUA". Solo cuando hay momento real — no en cada mensaje.
- SOLO usa emotes de esta lista. NUNCA inventes emotes que no esten aqui. Emotes del canal (visibles para TODOS): parlus1Esteeselrollo (buen rollo/compañerismo), parlus1Kelokekelowa (incredulidad/meme), parlus1Streambrothers5 (momentos de stream/hype), parlus1Alataqueel (cuando atacan o hay accion), parlus1PORELPODERDELFUAAAAA (momentos FUA/epicos). Para momentos FUA usa parlus1PORELPODERDELFUAAAAA. Globales (opcionales): KEKW (risa fuerte), Pog (sorpresa/hype), LUL (risa), monkaS (nervios/susto), Kappa (sarcasmo), OMEGALUL (risa extrema). Maximo 1-2 emotes por respuesta, solo si encaja natural.
- CRITICO — espaciado de emotes: los emotes del canal SIEMPRE van separados por espacios. NUNCA pegados a puntuacion. MAL: "¡texto! parlus1Alataqueel." o "parlus1KelokeKelowa," BIEN: "parlus1Alataqueel" o "texto parlus1KelokeKelowa texto". Un emote pegado a un punto o coma NO se renderiza en Twitch.
- Sin "Lo siento". Sin "como IA". Sin formalismos.
- Si tu contexto incluye MEMORIA DEL CANAL con frases recurrentes o momentos epicos de streams anteriores, mencionalos de forma espontanea y natural cuando encaje — el canal tiene historia propia y el chat lo aprecia.`;

  const modes = channelConfig.personality_modes || {};
  const modeConfig = modes[getPersonalityMode()] || modes.normal || {};
  const modeExt = modeConfig.prompt_extension ? `\n${modeConfig.prompt_extension}` : '';
  const gameNote = getGameContextFailed() ? ' NOTA INTERNA: no tenemos datos del juego actual — evita mencionarlo.' : '';
  const suffix = messageCount >= 20 ? ' Chat muy activo, se energico y rapido.' : messageCount >= 5 ? ' Chat tranquilo, se amigable.' : ' Chat tranquilo, se acogedor.';

  let userContext = '';
  if (username) {
    try {
      const facts = await getCachedUserFacts(username);
      if (facts.length > 0) {
        const factLines = facts
          .filter(f => f.fact_type !== 'recurring_joke')
          .map(f => `${f.fact_type}: ${sanitizeForAI(String(f.value))}`)
          .filter(line => line.split(': ')[1])
          .join(', ');
        if (factLines) userContext = `\n<user_context>${factLines}</user_context>`;
      }
    } catch {}
  }

  const examples = channelConfig.personality_examples || [];
  const examplesBlock = examples.length > 0
    ? `\n<examples>\n${examples.map(e =>
        `Situación: ${e.situation}\nNO: ${e.bad}\nSÍ: ${e.good}`
      ).join('\n\n')}\n</examples>`
    : '';

  return base + modeExt + gameNote + suffix + userContext + examplesBlock + reinforceBlock;
}

function getMinimalPersonality() {
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  return `Eres ${botName}, bot gracioso del canal de ${channelConfig.streamer}. ${getMinimalContext()} Responde SIEMPRE en espanol, sin palabras inglesas. Max 1-2 frases. Usa "FUA" si algo es epico. Experto en videojuegos y cultura general.`;
}

function getUserType(username, tags) {
  const lower = username.toLowerCase();
  if (CREATOR_USERNAME && lower === CREATOR_USERNAME) return 'creator';
  if (STREAMER_USERNAME && lower === STREAMER_USERNAME) return 'streamer';
  if (tags?.subscriber || tags?.badges?.subscriber || tags?.badges?.founder) return 'sub';
  return 'normal';
}

// --- Co-host ---
let lastCohostTime = 0;
let cohostRunning = false;

async function handleCohost(client, channel) {
  if (isSilenced() || isTriviaActive() || cohostRunning) return;
  const now = Date.now();
  if (now - lastCohostTime < COHOST_COOLDOWN) return;
  const modeConfig = (channelConfig.personality_modes || {})[getPersonalityMode()] || {};
  const effectiveProb = COHOST_PROBABILITY * (modeConfig.cohost_multiplier ?? 1.0);
  if (Math.random() > effectiveProb) return;
  const recentContext = getRecentHistory(5);
  if (!recentContext) return;
  if (!canMakeRequest()) return;

  const botHistory = getBotHistory();
  const botBlock = botHistory.length > 0
    ? `\n<bot_history>\n${botHistory.map(e => {
        const mins = Math.round((Date.now() - e.ts) / 60000);
        return `[hace ${mins}min] ${e.msg}`;
      }).join('\n')}\n</bot_history>`
    : '';

  cohostRunning = true;
  lastCohostTime = now;

  try {
    const gameInfo = await getCurrentGame();
    const game = gameInfo?.game ? `Estan jugando a "${gameInfo.game}".` : '';
    const raidNote = isRaidActive()
      ? ` Acaba de llegar una raid de @${getRaidUsername()}, hay nuevos viewers en el canal. Si encaja con el chat, menciona la raid con energia.`
      : '';
    const response = await groqWithRetry({
      max_tokens: 70,
      messages: [
        {
          role: 'system',
          content: `Eres un espectador habitual del canal de ${channelConfig.streamer} con buen rollo. ${game}${raidNote} Haces comentarios espontaneos como alguien del chat. Sin saludos. Sin presentarte. 1 frase en espanol, sin palabras en ingles. Usas FUA con caracter real: el momento exacto es DURANTE la dificultad, cuando el streamer esta a punto de rendirse — ese es el impulso, no la celebracion despues. No en cada mensaje.`
        },
        { role: 'user', content: `Chat reciente:\n${recentContext}${(() => { const n = getStreamNarrative(); return n.length > 0 ? `\n<stream_story>${n.map(e => `[${e.type}] ${e.description}`).join(' | ')}</stream_story>` : ''; })()}${botBlock}\nComenta algo natural sobre lo que se habla.` }
      ]
    });
    const maxChars = modeConfig.max_chars ?? TWITCH_MAX_LENGTH;
    const cohostReply = truncate(response.choices[0].message.content, maxChars);
    client.say(channel, cohostReply);
    addBotMessage(cohostReply);
  } catch (err) {
    logger.error(`Co-host: ${err.message}`);
    if (!isSilenced()) client.say(channel, truncate(getFallback('cohost')));
  } finally { cohostRunning = false; }
}

// --- Stream status ---
let streamWasLive = false;
let streamStatusInitialized = false;
let streamEndPostedByEventSub = false;

async function initStreamStatus() {
  const isLive = getEventSubLiveStatus();
  if (isLive) {
    streamWasLive = true;
    streamStatusInitialized = true;
    logger.info(`Iniciando: EN DIRECTO (EventSub)`);
    return;
  }
  const info = await getStreamInfo().catch(() => null);
  streamWasLive = info?.live === true;
  streamStatusInitialized = true;
  logger.info(`Iniciando: ${streamWasLive ? 'EN DIRECTO' : 'OFFLINE'}`);
}

const streamStartMessages = messagesConfig.stream_start_messages || [];
const streamEndMessages = messagesConfig.stream_end_messages || [];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function checkStreamStatus(client, channel) {
  if (!streamStatusInitialized) return;
  const isLive = getEventSubLiveStatus();

  if (!streamWasLive && isLive) {
    streamWasLive = true;
    streamEndPostedByEventSub = false;
    invalidateContextCache();
    client.say(channel, pickRandom(streamStartMessages));
  } else if (streamWasLive && !isLive) {
    streamWasLive = false;
    invalidateContextCache();
    // EventSub ya posteó el resumen IA; solo usar fallback si no lo hizo
    if (!streamEndPostedByEventSub) {
      client.say(channel, pickRandom(streamEndMessages));
    }
  }
}

// Llamado desde eventsub.js cuando arrancan con pocos viewers
async function onWarmupMode(client, channel, game) {
  if (!canMakeRequest()) return;
  try {
    const gameContext = game ? ` El juego de hoy: "${game}".` : '';
    const response = await groqWithRetry({
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `Eres dios_fua, bot del canal de ${channelConfig.streamer}. El stream acaba de empezar y hay pocos viewers — momento ideal para calentar el chat.${gameContext} Genera un mensaje de calentamiento: una bienvenida energetica + UNA pregunta directa al chat sobre ${game ? 'el juego de hoy' : 'lo que se viene'} que invite a responder. SIEMPRE en espanol. Max 2 frases. Usa FUA. Sin presentarte.`
        },
        { role: 'user', content: `Calienta el chat` }
      ]
    });
    client.say(channel, truncate(response.choices[0].message.content));
    logger.info(`🔥 Warmup mode activado`);
  } catch (err) {
    logger.warn(`Warmup mode: ${err.message}`);
    if (!isSilenced()) client.say(channel, truncate(messagesConfig.warmup_fallback));
  }
}

// Llamado desde eventsub.js tras generar la memoria del stream
function postStreamEnd(client, channel, aiSummary) {
  streamWasLive = false;
  streamEndPostedByEventSub = true;
  invalidateContextCache();
  const msg = aiSummary
    ? `🎬 ¡Fin del stream! ${aiSummary} ¡Hasta la próxima! FUA! 💜🔥`
    : pickRandom(streamEndMessages);
  throttleSay(client, channel, truncate(msg));
}

// --- Conversation hooks --- FIX #6: game hooks enriquecidos con RAWG + comentarios IA espontáneos
let lastHookTime = 0;
const HOOK_INTERVAL = parseInt(process.env.HOOK_INTERVAL_MS || '600000', 10);
const HOOK_MIN_SILENCE = parseInt(process.env.HOOK_SILENCE_MS || '300000', 10);
const MIN_VIEWERS_FOR_HOOKS = 3;

async function checkChatHook(client, channel) {
  if (isSilenced() || isTriviaActive()) return;
  if (!getEventSubLiveStatus()) return;
  const now = Date.now();
  if (now - lastHookTime < HOOK_INTERVAL) return;

  const silenceTime = now - lastChatMessageTime;

  // Si hay raid activa y el chat lleva al menos 1 min sin actividad, dar bienvenida a raiders
  if (isRaidActive() && silenceTime >= 60000) {
    lastHookTime = now;
    client.say(channel, `👋 Bienvenidos a los raiders de @${getRaidUsername()}! Si tenéis preguntas sobre el canal usad !dios_fua, y si os apetece un desafío probad !trivia 🔥`);
    return;
  }

  if (silenceTime < HOOK_MIN_SILENCE) return;
  // Si el chat lleva más de 10 min muerto, no forzar — no hay nadie
  try {
    const viewers = await getViewersWithAppToken(channelConfig.broadcaster_id);
    if (viewers !== null && viewers < MIN_VIEWERS_FOR_HOOKS) return;
  } catch {}

  lastHookTime = now;
  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game;

  // 50% de probabilidad de comentario espontáneo de IA si hay juego detectado
  if (game && Math.random() < 0.5 && canMakeRequest()) {
    try {
      const rawg = await getGameInfo(game).catch(() => null);
      const gameContext = rawg
        ? `${game} (${rawg.genres || 'sin género'}, ${rawg.rating || '?'}/5 en RAWG, ${rawg.released?.slice(0,4) || '?'})`
        : game;

      const response = await groqWithRetry({
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content: `Eres dios_fua, narrador en directo del canal de ${channelConfig.streamer}. Estilo: comentarista deportivo — dramatico, energetico, como si narraras un partido en vivo. El chat lleva unos minutos en silencio y tu llenas el aire. Juego: "${gameContext}". Haz UN comentario narrativo: tension del momento, una jugada que el chat no vio, una prediccion epica, o un dato del juego que ponga en contexto lo que pasa en pantalla. SIEMPRE en espanol. Sin presentarte. Max 1-2 frases. Usa FUA cuando algo merece epica. Se dramatico.`
          },
          { role: 'user', content: (() => { const n = getStreamNarrative(); const storyBlock = n.length > 0 ? ` Momentos clave del stream hasta ahora: ${n.map(e => `[${e.type}] ${e.description}`).join(', ')}.` : ''; return `Narra algo sobre ${game} para llenar el silencio.${storyBlock}`; })() }
        ]
      });
      client.say(channel, truncate(response.choices[0].message.content));
      return;
    } catch (err) {
      logger.warn(`Hook IA espontaneo fallo: ${err.message}`);
      // Si falla la IA, caemos al hook genérico
    }
  }

  // Hooks estáticos de fallback
  const genericHooks = [
    'Alguien tiene alguna pregunta? Usad !dios_fua! 🤖',
    'Sois mas de cooperativo o en solitario? 💬',
    'Chat! Alguien se anima con un !trivia? 🧠',
    'Cuantas muertes creeis que habra hoy? 💀',
    'Cual es vuestro juego favorito de todos los tiempos? 🎮',
    'Usad !chiste para que cuente un chiste! 😂',
  ];

  let gameHooks = [];
  if (game) {
    try {
      const rawg = await getGameInfo(game);
      if (rawg?.genres && rawg?.rating) {
        const year = rawg.released?.slice(0, 4) || '';
        gameHooks = [
          `🎮 ${channelConfig.streamer} jugando a ${game} (${rawg.genres}${year ? ', ' + year : ''}) - ${rawg.rating}/5 en RAWG. Alguien lo ha jugado?`,
          `Que os parece ${game} hasta ahora? Genero: ${rawg.genres} 🎮`,
          `${game} - Nota ${rawg.rating}/5 en RAWG. Estais de acuerdo? 🤔`,
        ];
      } else {
        gameHooks = [
          `Que os parece ${game} hasta ahora? 🎮`,
          `Alguien ha jugado ${game} antes? Es dificil? 🤔`,
        ];
      }
    } catch {
      gameHooks = [
        `Que os parece ${game} hasta ahora? 🎮`,
        `Alguien ha jugado ${game}? Que tal? 🤔`,
      ];
    }
  }

  const allHooks = [...gameHooks, ...genericHooks];
  client.say(channel, allHooks[Math.floor(Math.random() * allHooks.length)]);
}

// --- !chiste ---
const chistesDB = require('../../data/chistes.json');
const chisteCooldowns = new Map();
let lastChisteIndex = -1;
setInterval(() => { const now = Date.now(); for (const [k,v] of chisteCooldowns) if (now > v) chisteCooldowns.delete(k); }, 30 * 60 * 1000);

function handleChiste(client, channel, tags) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  // BUG FIX #2: fallback si user-id es undefined (evita cooldown compartido)
  const userId = tags['user-id'] || tags['username'] || username;
  const key = `chiste-${userId}`;
  const now = Date.now();
  if (chisteCooldowns.has(key) && now < chisteCooldowns.get(key)) {
    client.say(channel, `@${username} espera ${Math.ceil((chisteCooldowns.get(key) - now) / 1000)}s.`);
    return;
  }
  let index, attempts = 0;
  do { index = Math.floor(Math.random() * chistesDB.length); attempts++; } while (index === lastChisteIndex && attempts < 10);
  lastChisteIndex = index;
  chisteCooldowns.set(key, now + 30000);
  persistCooldown(key, now + 30000);
  client.say(channel, truncate(`😂 ${chistesDB[index]}`));
}

// --- !dios_fua --- FIX #4 + #7: prompt mejorado + busqueda web Tavily
const questionCooldowns = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of questionCooldowns) if (now > v) questionCooldowns.delete(k); }, 30 * 60 * 1000);

async function handleQuestion(client, channel, tags, args) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  // BUG FIX #2: fallback si user-id es undefined
  const userId = tags['user-id'] || tags['username'] || username;
  const now = Date.now();

  if (questionCooldowns.has(userId) && now < questionCooldowns.get(userId)) {
    client.say(channel, `@${username} espera ${Math.ceil((questionCooldowns.get(userId) - now) / 1000)}s.`);
    return;
  }

  const rawQuestion = args.slice(1).join(' ');
  if (!rawQuestion) { client.say(channel, `@${username} escribe algo despues de !dios_fua 😅`); return; }
  const question = sanitizeForAI(rawQuestion);
  if (!question) { client.say(channel, `@${username} esa pregunta no la puedo responder 🙅`); return; }
  if (!canMakeRequest()) { client.say(channel, `@${username} demasiadas peticiones globales ⏳`); return; }

  const userType = getUserType(username, tags);
  if (!canUserMakeRequest(userId, userType)) { client.say(channel, `@${username} espera un momento antes de volver a preguntar ⏳`); return; }

  try {
    const personality = await getPersonality(trackMessage(), userType, username);
    const userConv = getUserConversation(userId);

    // FIX #7: busqueda web con Tavily si la pregunta es factual
    let searchContext = '';
    if (needsWebSearch(question)) {
      try {
        const webResult = await searchWeb(question);
        if (webResult) {
          searchContext = `\n[Informacion web]: ${webResult}`;
          logger.info(`Tavily busqueda: "${question.slice(0, 50)}"`);
        }
      } catch (err) {
        logger.warn(`Tavily fallo: ${err.message}`);
      }
    }

    const tone = detectTone(question);
    const toneNote = tone === 'frustration' ? '\nEl usuario suena frustrado. Responde con empatía breve y ánimo, no con chistes.'
      : tone === 'hype' ? '\nEl usuario está emocionado. Responde con energía y entusiasmo.'
      : tone === 'question' ? '\nEl usuario hace una pregunta directa. Responde de forma concisa y clara.'
      : '';
    const trapNote = isConfirmationTrap(question)
      ? '\nEl usuario busca validación automática. NO confirmes por defecto. Responde con tu criterio real, aunque no sea lo que quiere oír. Puedes estar de acuerdo, pero que sea genuino, no automático.'
      : '';
    const systemContent = `${personality}${toneNote}${trapNote}\nPuedes responder sobre CUALQUIER tema, especialmente videojuegos. NUNCA inventes datos especificos. Sin "Lo siento". Responde SIEMPRE en espanol.${searchContext}`;

    const response = await groqWithRetry({
      max_tokens: 150,
      messages: [
        { role: 'system', content: systemContent },
        ...userConv,
        { role: 'user', content: `${username}: ${question}` }
      ]
    });
    const answer = response.choices[0].message.content;
    const qModeConfig = (channelConfig.personality_modes || {})[getPersonalityMode()] || {};
    const qMaxChars = qModeConfig.max_chars ?? TWITCH_MAX_LENGTH;
    client.say(channel, truncate(`@${username} ${answer}`, qMaxChars));
    addBotMessage(truncate(answer, qMaxChars));
    questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
    persistCooldown(`question-${userId}`, now + QUESTION_COOLDOWN_MS);
    addToUserConversation(userId, 'user', `${username}: ${question}`);
    addToUserConversation(userId, 'assistant', answer);
  } catch (err) {
    logger.error(`!dios_fua: ${err.message}`);
    const isTimeout = err.message?.includes('timeout') || err.code === 'ETIMEDOUT';
    const is429 = err.status === 429;
    const ftype = is429 ? 'ratelimit' : isTimeout ? 'timeout' : 'error';
    client.say(channel, truncate(getFallback(ftype, `@${username}`)));
  }
}


// --- !so ---
async function handleShoutout(client, channel, tags, targetUsername) {
  const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';
  if (!isMod) { client.say(channel, `@${tags['display-name']} solo mods pueden usar !so.`); return; }
  if (!targetUsername) { client.say(channel, `Uso: !so @usuario`); return; }

  const target = targetUsername.replace('@', '');
  client.say(channel, `Preparando shoutout para @${target}...`);

  try {
    if (!canMakeRequest()) {
      client.say(channel, `📢 Échad un ojo a @${target}! 💜 twitch.tv/${target}`);
      return;
    }
    const info = await getChannelInfo(target);
    const game = info?.game_name ? `Su ultimo juego: "${info.game_name}".` : '';
    const response = await groqWithRetry({
      max_tokens: 80,
      messages: [
        { role: 'system', content: `Shoutout para @${target}. ${game} En espanol, sin palabras inglesas. 1 frase calida y graciosa. Anima a visitarle.` },
        { role: 'user', content: `Shoutout para @${target}` }
      ]
    });
    client.say(channel, truncate(`📢 ${response.choices[0].message.content.trim()} twitch.tv/${target}`));
  } catch (err) {
    logger.error(`!so: ${err.message}`);
    client.say(channel, `📢 Echad un ojo a @${target}! 💜 twitch.tv/${target}`);
  }
}

// --- Deteccion de highlights para stream markers --- FIX #10
const highlightKeywords = [
  'clip', 'clipa', 'clipalo', 'marca', 'wtf', 'wow', 'fua',
  'increible', 'brutal', 'epico', 'epica', 'locura', 'boom', 'gg', 'no puede ser'
];
const recentHighlightMsgs = [];
const HIGHLIGHT_WINDOW = 15 * 1000;
const HIGHLIGHT_THRESHOLD = 4;
let lastMarkerTime = 0;
const MARKER_COOLDOWN = 3 * 60 * 1000;

async function checkForHighlight(client, channel, message) {
  if (!getEventSubLiveStatus()) return;
  const now = Date.now();
  if (now - lastMarkerTime < MARKER_COOLDOWN) return;

  const lower = message.toLowerCase();
  if (!highlightKeywords.some(kw => lower.includes(kw))) return;

  recentHighlightMsgs.push({ ts: now, message });
  while (recentHighlightMsgs.length > 0 && recentHighlightMsgs[0].ts < now - HIGHLIGHT_WINDOW) {
    recentHighlightMsgs.shift();
  }

  if (recentHighlightMsgs.length >= HIGHLIGHT_THRESHOLD) {
    const triggerMessages = recentHighlightMsgs.map(e => e.message);
    recentHighlightMsgs.length = 0;
    lastMarkerTime = now;
    addNarrativeEvent('victory', 'El chat explotó — momento épico detectado automáticamente');

    const markerResult = await createStreamMarker('Momento epico detectado por el chat');
    const markerCreated = markerResult !== null;
    if (markerCreated) logger.info(`Stream marker creado automaticamente`);

    if (canMakeRequest()) {
      try {
        const gameInfo = await getCurrentGame().catch(() => null);
        const game = gameInfo?.game ? ` Juego: "${gameInfo.game}".` : '';
        const response = await groqWithRetry({
          max_tokens: 70,
          messages: [
            { role: 'system', content: `Eres dios_fua, narrador en directo del canal de ${channelConfig.streamer}. Estilo: comentarista deportivo.${game} El chat acaba de explotar — todos reaccionando a algo epico. Narra este momento en directo. SIEMPRE en espanol. Max 1-2 frases. Usa FUA. Se dramatico.` },
            { role: 'user', content: `El chat acaba de explotar con hype` }
          ]
        });
        const aiDesc = response.choices[0].message.content;
        const prefix = markerCreated ? '🏁' : '🔥';
        client.say(channel, truncate(`${prefix} ${aiDesc}`));
        if (markerCreated) {
          saveHighlight(triggerMessages, markerResult.id, aiDesc)
            .then(r => { if (r?.error) logger.warn(`Highlight no persistido: ${r.error.message}`); })
            .catch(() => {});
        }
      } catch {
        if (markerCreated) {
          saveHighlight(triggerMessages, markerResult.id, 'Momento epico detectado por el chat')
            .then(r => { if (r?.error) logger.warn(`Highlight no persistido: ${r.error.message}`); })
            .catch(() => {});
          client.say(channel, `🏁 Momento marcado para el VOD! FUA! 🔥`);
        } else {
          client.say(channel, `🔥 QUÉ MOMENTO FUA! 💜`);
        }
      }
    } else if (markerCreated) {
      saveHighlight(triggerMessages, markerResult.id, 'Momento epico detectado por el chat')
        .then(r => { if (r?.error) logger.warn(`Highlight no persistido: ${r.error.message}`); })
        .catch(() => {});
      client.say(channel, `🏁 Momento marcado para el VOD! FUA! 🔥`);
    } else {
      client.say(channel, `🔥 QUÉ MOMENTO FUA! 💜`);
    }
  }
}

// --- Emote spam detection ---
const recentEmoteUse = new Map(); // emoteToken → [{user, ts}]
const EMOTE_WINDOW_MS = 20 * 1000;
const EMOTE_SPAM_THRESHOLD = 8;
let lastEmoteCommentTime = 0;
const EMOTE_COMMENT_COOLDOWN = 90 * 1000;

function extractEmoteTokens(tags, message) {
  const tokens = new Set();

  // 1. Emotes nativos de Twitch via tags.emotes: { emoteId: ['start-end', ...] }
  if (tags.emotes && typeof tags.emotes === 'object') {
    for (const positions of Object.values(tags.emotes)) {
      if (positions && positions.length > 0) {
        const [start, end] = positions[0].split('-').map(Number);
        const name = message.slice(start, end + 1);
        if (name) tokens.add(name);
      }
    }
  }

  // 2. Fallback BTTV/FFZ: ALL_CAPS de 4+ chars o CamelCase con uppercase interno
  // 4 chars mínimo para evitar falsos positivos como FUA, GTA, LOL, GG
  if (tokens.size === 0) {
    for (const word of message.split(/\s+/)) {
      if (/^[A-Z]{4,}$/.test(word) || /^[A-Z][a-z]+[A-Z][A-Za-z0-9]*$/.test(word)) {
        tokens.add(word);
      }
    }
  }

  return [...tokens];
}

async function checkEmoteSpam(client, channel, tags, message) {
  if (!getEventSubLiveStatus() || isSilenced()) return;
  const now = Date.now();
  if (now - lastEmoteCommentTime < EMOTE_COMMENT_COOLDOWN) return;

  const username = tags['display-name'];
  const tokens = extractEmoteTokens(tags, message);

  for (const token of tokens) {
    if (!recentEmoteUse.has(token)) {
      // Cap máximo de 100 tokens para evitar memory leak en streams largos
      if (recentEmoteUse.size >= 100) {
        recentEmoteUse.delete(recentEmoteUse.keys().next().value);
      }
      recentEmoteUse.set(token, []);
    }
    const entries = recentEmoteUse.get(token);
    entries.push({ user: username, ts: now });
    const fresh = entries.filter(e => e.ts > now - EMOTE_WINDOW_MS);
    recentEmoteUse.set(token, fresh);

    const uniqueUsers = new Set(fresh.map(e => e.user)).size;
    if (uniqueUsers >= EMOTE_SPAM_THRESHOLD && canMakeRequest()) {
      lastEmoteCommentTime = now;
      recentEmoteUse.delete(token);
      try {
        const response = await groqWithRetry({
          max_tokens: 60,
          messages: [
            { role: 'system', content: `Eres dios_fua, narrador del canal de ${channelConfig.streamer}. El chat acaba de inundarse con "${token}" — reaccion masiva y sincronizada. Narra este momento de reaccion colectiva con energia de comentarista deportivo. SIEMPRE en espanol. Max 1 frase. Usa FUA si merece epica.` },
            { role: 'user', content: `El chat spamea "${token}"` }
          ]
        });
        client.say(channel, truncate(response.choices[0].message.content));
      } catch {}
      return;
    }
  }

  // Limpieza ocasional del mapa
  if (Math.random() < 0.03) {
    for (const [k, v] of recentEmoteUse) {
      const fresh = v.filter(e => e.ts > now - EMOTE_WINDOW_MS);
      if (fresh.length === 0) recentEmoteUse.delete(k);
      else recentEmoteUse.set(k, fresh);
    }
  }
}

// --- CAPS rage detection ---
const capsMessages = []; // {user, ts}
const CAPS_WINDOW_MS = 15 * 1000;
const CAPS_THRESHOLD = 5;
let lastCapsCommentTime = 0;
const CAPS_COMMENT_COOLDOWN = 120 * 1000;

function isCapsMessage(msg) {
  // \p{L} = cualquier letra Unicode (incluye Á É Í Ó Ú Ñ)
  // \p{Lu} = letras mayúsculas Unicode
  // Nota: regex Unicode es ~3x más lento que ASCII pero
  // necesario para chats en español
  const letters = [...msg].filter(c => /\p{L}/u.test(c));
  if (letters.length < 8) return false;
  return letters.filter(c => /\p{Lu}/u.test(c)).length / letters.length >= 0.7;
}

async function checkCapsRage(client, channel, tags, message) {
  if (!getEventSubLiveStatus() || isSilenced()) return;
  if (!isCapsMessage(message)) return;
  const now = Date.now();
  if (now - lastCapsCommentTime < CAPS_COMMENT_COOLDOWN) return;

  const username = tags['display-name'];
  capsMessages.push({ user: username, ts: now });
  while (capsMessages.length > 0 && capsMessages[0].ts < now - CAPS_WINDOW_MS) capsMessages.shift();

  const uniqueUsers = new Set(capsMessages.map(e => e.user)).size;
  if (uniqueUsers >= CAPS_THRESHOLD && canMakeRequest()) {
    lastCapsCommentTime = now;
    setLastCapsRageTime(now);
    capsMessages.length = 0;
    addNarrativeEvent('rage', 'CAPS rage del chat — energía colectiva desbordada');
    try {
      const gameInfo = await getCurrentGame().catch(() => null);
      const game = gameInfo?.game ? ` Juego: "${gameInfo.game}".` : '';
      const response = await groqWithRetry({
        max_tokens: 60,
        messages: [
          { role: 'system', content: `Eres dios_fua, narrador del canal de ${channelConfig.streamer}.${game} El chat ha entrado en MODO CAPS — todos gritando a la vez. Narra este momento de locura colectiva con energia de comentarista deportivo. SIEMPRE en espanol. Max 1 frase. Usa FUA.` },
          { role: 'user', content: `El chat entra en modo CAPS RAGE` }
        ]
      });
      client.say(channel, truncate(response.choices[0].message.content));
    } catch {}
  }
}

// --- Pattern matcher: preguntas naturales sin ! ---

// Menciones directas: cooldown propio (8s global + 10s por usuario)
// Separadas para permitir conversación fluida sin bloquear el global de patrones generales
const DIRECT_MENTION_PATTERNS = [
  /@dios_fua\b/i,
  /\bdios\s*fua\b/i,
];
const DIRECT_MENTION_GLOBAL_COOLDOWN = 8 * 1000;
const DIRECT_MENTION_USER_COOLDOWN = 10 * 1000;
let lastDirectMentionTime = 0;
const directMentionUserCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of directMentionUserCooldowns) if (now > v) directMentionUserCooldowns.delete(k);
}, 15 * 60 * 1000);

const NATURAL_PATTERNS = [
  // Preguntas sobre el juego
  /qu[eé]\s+juego/i,
  /c[oó]mo\s+se\s+llama\s+el\s+juego/i,
  /de\s+qu[eé]\s+va\s+(el\s+)?(juego|esto)/i,
  /qu[eé]\s+(est[aá]n?\s+)?jugando/i,
  // Duración del stream
  /cu[aá]nto\s+(tiempo\s+)?(llevas?|lleva)\b/i,
  // Identidad del bot
  /eres\s+(un\s+)?(bot|ia|inteligencia\s+artificial|robot|real|humano)/i,
  /c[oó]mo\s+te\s+llamas/i,
  /qui[eé]n\s+eres/i,
  // Dificultad del juego
  /es\s+(muy\s+)?(dif[ií]cil|complicado|f[aá]cil)\b/i,
  /qu[eé]\s+(tan\s+)?(dif[ií]cil|f[aá]cil)/i,
];

const PATTERN_GLOBAL_COOLDOWN = 45 * 1000;
const PATTERN_USER_COOLDOWN = 30 * 1000;
let lastPatternTime = 0;
const patternUserCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of patternUserCooldowns) if (now > v) patternUserCooldowns.delete(k);
}, 15 * 60 * 1000);

async function checkPatternMatch(client, channel, tags, message) {
  if (isSilenced() || isTriviaActive()) return false;
  if (!canMakeRequest()) return false;

  const now = Date.now();
  const userId = tags['user-id'] || tags['username'];

  const isDirect = DIRECT_MENTION_PATTERNS.some(re => re.test(message));

  if (isDirect) {
    // 8s global entre usuarios distintos + 10s por usuario
    if (now - lastDirectMentionTime < DIRECT_MENTION_GLOBAL_COOLDOWN) return false;
    if (directMentionUserCooldowns.has(userId) && now < directMentionUserCooldowns.get(userId)) return false;
  } else {
    if (!NATURAL_PATTERNS.some(re => re.test(message))) return false;
    if (now - lastPatternTime < PATTERN_GLOBAL_COOLDOWN) return false;
    if (patternUserCooldowns.has(userId) && now < patternUserCooldowns.get(userId)) return false;
  }

  const username = tags['display-name'];
  const question = sanitizeForAI(message);
  if (!question) return false;

  if (isDirect) {
    lastDirectMentionTime = now;
    directMentionUserCooldowns.set(userId, now + DIRECT_MENTION_USER_COOLDOWN);
  } else {
    lastPatternTime = now;
    patternUserCooldowns.set(userId, now + PATTERN_USER_COOLDOWN);
  }

  try {
    const userType = getUserType(username, tags);
    const personality = await getPersonality(recentMessages.length, userType, username);
    const userConv = getUserConversation(userId);

    const tone = detectTone(question);
    const narrative = getStreamNarrative();
    const recentDeaths = narrative.filter(e => e.type === 'death').length;
    const recentVictories = narrative.filter(e => e.type === 'victory').length;
    const frustrationBlock = (tone === 'frustration' && recentDeaths >= 3 && recentVictories === 0)
      ? ' El usuario está frustrado y hay muchas muertes seguidas. No hagas chistes — muestra empatía y ánimo real.'
      : '';
    const toneNote = tone === 'frustration' ? ' El usuario suena frustrado. Empatía y ánimo, no chistes.' + frustrationBlock
      : tone === 'hype' ? ' El usuario está emocionado. Responde con energía.' : '';
    const trapNote = isConfirmationTrap(question)
      ? '\nEl usuario busca validación automática. NO confirmes por defecto. Responde con tu criterio real, aunque no sea lo que quiere oír. Puedes estar de acuerdo, pero que sea genuino, no automático.'
      : '';

    const response = await groqWithRetry({
      max_tokens: 120,
      messages: [
        { role: 'system', content: `${personality}${toneNote}${trapNote}\nEl usuario escribio de forma natural sin prefijo de comando. Responde conversacionalmente y breve. SIEMPRE en espanol.` },
        ...userConv,
        { role: 'user', content: `${username}: ${question}` }
      ]
    });

    const answer = response.choices[0].message.content;
    client.say(channel, truncate(`@${username} ${answer}`));
    addBotMessage(truncate(answer));
    addToUserConversation(userId, 'user', `${username}: ${question}`);
    addToUserConversation(userId, 'assistant', answer);
    return true;
  } catch (err) {
    logger.warn(`Pattern matcher: ${err.message}`);
    return false;
  }
}

function getStreamChatBuffer() {
  return streamChatBuffer.map(m => `${m.username}: ${m.message}`).join('\n');
}

function resetStreamChatBuffer() {
  streamChatBuffer.length = 0;
}

// Restaurar cooldowns desde Supabase al arrancar (prefijos: question-, chiste-)
function restoreCooldowns(data) {
  const now = Date.now();
  for (const [key, expiresAt] of Object.entries(data)) {
    if (expiresAt <= now) continue;
    if (key.startsWith('question-')) questionCooldowns.set(key.slice('question-'.length), expiresAt);
    if (key.startsWith('chiste-')) chisteCooldowns.set(key, expiresAt);
  }
  logger.info(`✅ Cooldowns restaurados desde Supabase (${Object.keys(data).length})`);
}

module.exports = {
  handleCohost, handleChiste, handleQuestion, handleShoutout,
  addToHistory, updateLastChatTime, getRecentHistory, checkChatHook, checkStreamStatus,
  initStreamStatus, invalidateContextCache, checkForHighlight,
  checkEmoteSpam, checkCapsRage, checkPatternMatch,
  getActiveUsers, getActiveUsersWithMinMessages, resetActiveUsers, onWarmupMode, postStreamEnd,
  getStreamChatBuffer, resetStreamChatBuffer,
  restoreCooldowns, clearUserFactsCache,
};
