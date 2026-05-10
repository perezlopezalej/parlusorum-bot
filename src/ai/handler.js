const Groq = require('groq-sdk');
const channelConfig = require('../../config/channel.json');
const { getCurrentGame, getGameInfo, getStreamInfo } = require('../twitch/api');
const { isTriviaActive, isSilenced, setTriviaActive } = require('../utils/state');
const { sanitizeForAI } = require('../utils/filter');
const { canMakeRequest, canUserMakeRequest } = require('../utils/ratelimit');
const { searchWeb, needsWebSearch } = require('../utils/search');
const { getMemoryContext } = require('../memory/handler');
const logger = require('../utils/logger');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const TWITCH_MAX_LENGTH = 490;
const COHOST_COOLDOWN = parseInt(process.env.COHOST_COOLDOWN_MS || '120000', 10);
const COHOST_PROBABILITY = parseFloat(process.env.COHOST_PROBABILITY || '0.25');
const QUESTION_COOLDOWN_MS = parseInt(process.env.QUESTION_COOLDOWN_MS || '10000', 10);

const CREATOR_USERNAME = (channelConfig.creator_username || '').toLowerCase();
const STREAMER_USERNAME = (channelConfig.streamer_username || '').toLowerCase();

function truncate(msg) {
  if (msg.length <= TWITCH_MAX_LENGTH) return msg;
  return msg.slice(0, TWITCH_MAX_LENGTH - 3) + '...';
}

async function groqWithRetry(params, maxRetries = 2) {
  params.model = GROQ_MODEL;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await groq.chat.completions.create(params); }
    catch (err) {
      if ((err.status === 429 || err.message?.includes('rate')) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
}

function getEventSubLiveStatus() {
  try { return require('../eventsub').isLiveViaEventSub(); }
  catch { return false; }
}

function getChannelContext() {
  const games = (channelConfig.games_played || []).slice(0, 4).join(', ');
  return `Canal: ${channelConfig.streamer} (streamer/host). Bot creado por: @${CREATOR_USERNAME} (amo creador, NO es el streamer). ${channelConfig.content}. Ambiente: ${channelConfig.vibe}. Juegos recientes: ${games}. ${channelConfig.inside_jokes || ''}`;
}

let fullContextCache = null;
let lastContextCheck = 0;
const CONTEXT_CACHE_TTL = 2 * 60 * 1000;

async function getFullContext() {
  const now = Date.now();
  if (fullContextCache && now - lastContextCheck < CONTEXT_CACHE_TTL) return fullContextCache;

  const gameInfo = await getCurrentGame();
  const base = getChannelContext();
  let context = base;

  if (gameInfo?.game) {
    context += ` Juego actual: "${gameInfo.game}".`;
    try {
      const rawgInfo = await getGameInfo(gameInfo.game);
      if (rawgInfo) {
        if (rawgInfo.genres) context += ` Generos: ${rawgInfo.genres}.`;
        if (rawgInfo.rating) context += ` Nota RAWG: ${rawgInfo.rating}/5.`;
        if (rawgInfo.released) context += ` Anio: ${rawgInfo.released?.slice(0, 4)}.`;
      }
    } catch {}
  }

  const isLive = getEventSubLiveStatus();
  context += isLive ? ` El canal ESTA EN DIRECTO ahora mismo.` : ` El canal esta offline ahora mismo.`;

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

function trackActiveUser(username) {
  if (username) activeUsersThisStream.add(username.toLowerCase());
}

function getActiveUsers() {
  return [...activeUsersThisStream];
}

function resetActiveUsers() {
  activeUsersThisStream.clear();
}

// --- Historial de chat ---
const chatHistory = [];
const MAX_HISTORY = 40;
let lastChatMessageTime = Date.now();
const MAX_CONVERSATION_USERS = 200;

function addToHistory(username, message) {
  if (message.startsWith('!')) return;
  chatHistory.push({ username, message, ts: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  lastChatMessageTime = Date.now();
  trackActiveUser(username);
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

// --- Personalidad ---
async function getPersonality(messageCount, userType = 'normal') {
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  const context = await getFullContext();

  let specialNote = '';
  if (userType === 'creator') {
    specialNote = ` ATENCION: Hablas con @${CREATOR_USERNAME}, quien te PROGRAMO y CREO. Es tu amo creador. NO es el streamer del canal (eso es @${STREAMER_USERNAME}). Tratale con humor reverente como a tu creador literal.`;
  } else if (userType === 'streamer') {
    specialNote = ` ATENCION: Hablas con @${STREAMER_USERNAME}, el streamer/host del canal. No es tu creador (eso es @${CREATOR_USERNAME}). Tratale con respeto y complicidad como el jefe del canal.`;
  }

  const base = `Eres ${botName}, bot del canal de Twitch de ${channelConfig.streamer}. Nombre del bot viene del meme del FUA (Fuerza Universal Aplicada). Fuiste creado/programado por @${CREATOR_USERNAME}.
${context}${specialNote}

REGLAS ABSOLUTAS (no negociables):
- SIEMPRE en espanol. NUNCA uses palabras en ingles si existe equivalente en espanol.
- Eres EXPERTO en videojuegos: cualquier consola, PC, movil, genero y epoca. Responde con datos reales.
- Puedes hablar de CUALQUIER tema: ciencia, historia, deportes, musica, cultura general.
- Si no sabes algo: admitelo con humor ("ni idea") pero NUNCA inventes datos especificos.
- Maximo 2 frases cortas (400 chars). Directo al grano. Sin presentarte ni saludar.
- Usa "FUA" cuando algo es epico o impresionante.
- Sin "Lo siento". Sin "como IA". Sin formalismos.`;

  if (messageCount >= 20) return base + ' Chat muy activo, se energico y rapido.';
  if (messageCount >= 5) return base + ' Chat tranquilo, se amigable.';
  return base + ' Chat tranquilo, se acogedor.';
}

function getMinimalPersonality() {
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  return `Eres ${botName}, bot gracioso del canal de ${channelConfig.streamer}. ${getMinimalContext()} Responde SIEMPRE en espanol, sin palabras inglesas. Max 1-2 frases. Usa "FUA" si algo es epico. Experto en videojuegos y cultura general.`;
}

function getUserType(username) {
  const lower = username.toLowerCase();
  if (CREATOR_USERNAME && lower === CREATOR_USERNAME) return 'creator';
  if (STREAMER_USERNAME && lower === STREAMER_USERNAME) return 'streamer';
  return 'normal';
}

// --- Co-host ---
let lastCohostTime = 0;
let cohostRunning = false;

async function handleCohost(client, channel) {
  if (isSilenced() || isTriviaActive() || cohostRunning) return;
  const now = Date.now();
  if (now - lastCohostTime < COHOST_COOLDOWN) return;
  if (Math.random() > COHOST_PROBABILITY) return;
  const recentContext = getRecentHistory(5);
  if (!recentContext) return;
  if (!canMakeRequest()) return;

  cohostRunning = true;
  lastCohostTime = now;

  try {
    const gameInfo = await getCurrentGame();
    const game = gameInfo?.game ? `Estan jugando a "${gameInfo.game}".` : '';
    const response = await groqWithRetry({
      max_tokens: 70,
      messages: [
        {
          role: 'system',
          content: `Eres un espectador habitual del canal de ${channelConfig.streamer} con buen rollo. ${game} Haces comentarios espontaneos como alguien del chat. Sin saludos. Sin presentarte. 1 frase en espanol, sin palabras en ingles. A veces usas FUA cuando es epico.`
        },
        { role: 'user', content: `Chat reciente:\n${recentContext}\nComenta algo natural sobre lo que se habla.` }
      ]
    });
    client.say(channel, truncate(response.choices[0].message.content));
  } catch (err) { logger.error(`Co-host: ${err.message}`); }
  finally { cohostRunning = false; }
}

// --- Stream status ---
let streamWasLive = false;
let streamStatusInitialized = false;

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

const streamStartMessages = [
  'LIVE! Bienvenidos todos! FUA! 💪🔥',
  'El canal ha arrancado! A disfrutar! FUA! 🔥',
  'ESTAMOS EN DIRECTO! El FUA nos convoca! 💪',
  'Arranca el stream! Preparaos para el caos! FUA! 🔥',
];

const streamEndMessages = [
  'Y hasta aqui el stream! Gracias a todos! FUA y hasta la proxima! 💜🔥',
  'Stream terminado! Gracias por acompanarhos! FUA! 🔥',
  'Eso es todo por hoy! Gracias a la comunidad! FUA! 💜',
  'Se acabo! FUA y nos vemos pronto! 🔥💪',
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function checkStreamStatus(client, channel) {
  if (!streamStatusInitialized) return;
  const isLive = getEventSubLiveStatus();

  if (!streamWasLive && isLive) {
    streamWasLive = true;
    invalidateContextCache();
    client.say(channel, pickRandom(streamStartMessages));
  } else if (streamWasLive && !isLive) {
    streamWasLive = false;
    invalidateContextCache();
    client.say(channel, pickRandom(streamEndMessages));
  }
}

// --- Conversation hooks ---
let lastHookTime = 0;
const HOOK_INTERVAL = parseInt(process.env.HOOK_INTERVAL_MS || '600000', 10);
const HOOK_MIN_SILENCE = parseInt(process.env.HOOK_SILENCE_MS || '300000', 10);
const HOOK_MAX_SILENCE = parseInt(process.env.HOOK_MAX_SILENCE_MS || '600000', 10);
const MIN_VIEWERS_FOR_HOOKS = 3;

async function checkChatHook(client, channel) {
  if (isSilenced() || isTriviaActive()) return;
  if (!getEventSubLiveStatus()) return;
  const now = Date.now();
  if (now - lastHookTime < HOOK_INTERVAL) return;

  const silenceTime = now - lastChatMessageTime;
  if (silenceTime < HOOK_MIN_SILENCE) return;
  if (silenceTime > HOOK_MAX_SILENCE) return;

  try {
    const eventsub = require('../eventsub');
    const viewers = await eventsub.getViewersWithAppToken(channelConfig.broadcaster_id);
    if (viewers !== null && viewers < MIN_VIEWERS_FOR_HOOKS) return;
  } catch {}

  lastHookTime = now;
  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game;

  // 50% comentario espontaneo de IA si hay juego detectado
  if (game && Math.random() < 0.5 && canMakeRequest()) {
    try {
      const rawg = await getGameInfo(game).catch(() => null);
      const gameContext = rawg
        ? `${game} (${rawg.genres || 'sin genero'}, ${rawg.rating || '?'}/5 en RAWG, ${rawg.released?.slice(0,4) || '?'})`
        : game;

      const response = await groqWithRetry({
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content: `Eres dios_fua, bot del canal de ${channelConfig.streamer}. El chat lleva unos minutos callado. Haz UN comentario espontaneo e interesante sobre el juego "${gameContext}". Puede ser una curiosidad real, una opinion, o una pregunta al chat. SIEMPRE en espanol. Sin presentarte. Max 1-2 frases. A veces usa FUA si es epico.`
          },
          { role: 'user', content: `Comenta algo sobre ${game} para animar el chat.` }
        ]
      });
      client.say(channel, truncate(response.choices[0].message.content));
      return;
    } catch (err) {
      logger.warn(`Hook IA espontaneo fallo: ${err.message}`);
    }
  }

  // Hooks estaticos de fallback
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
  const userId = tags['user-id'];
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
  client.say(channel, truncate(`😂 ${chistesDB[index]}`));
}

// --- !dios_fua ---
const questionCooldowns = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of questionCooldowns) if (now > v) questionCooldowns.delete(k); }, 30 * 60 * 1000);

async function handleQuestion(client, channel, tags, args) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  const userId = tags['user-id'];
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

  const userType = getUserType(username);
  if (!canUserMakeRequest(userId, userType)) { client.say(channel, `@${username} espera un momento antes de volver a preguntar ⏳`); return; }

  try {
    const personality = await getPersonality(trackMessage(), userType);
    const userConv = getUserConversation(userId);

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

    const systemContent = `${personality}\nPuedes responder sobre CUALQUIER tema, especialmente videojuegos. NUNCA inventes datos especificos. Sin "Lo siento". Responde SIEMPRE en espanol.${searchContext}`;

    const response = await groqWithRetry({
      max_tokens: 150,
      messages: [
        { role: 'system', content: systemContent },
        ...userConv,
        { role: 'user', content: `${username}: ${question}` }
      ]
    });
    const answer = response.choices[0].message.content;
    client.say(channel, truncate(`@${username} ${answer}`));
    questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
    addToUserConversation(userId, 'user', `${username}: ${question}`);
    addToUserConversation(userId, 'assistant', answer);
  } catch (err) {
    logger.error(`!dios_fua: ${err.message}`);
    client.say(channel, `@${username} no puedo responder ahora mismo.`);
  }
}

// --- !so ---
async function handleShoutout(client, channel, tags, targetUsername) {
  const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';
  if (!isMod) { client.say(channel, `@${tags['display-name']} solo mods pueden usar !so.`); return; }
  if (!targetUsername) { client.say(channel, `Uso: !so @usuario`); return; }

  const target = targetUsername.replace('@', '');
  client.say(channel, `Preparando shoutout para @${target}...`);

  const { getChannelInfo } = require('../twitch/api');
  try {
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

// --- Deteccion de highlights para stream markers ---
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

  recentHighlightMsgs.push(now);
  while (recentHighlightMsgs.length > 0 && recentHighlightMsgs[0] < now - HIGHLIGHT_WINDOW) {
    recentHighlightMsgs.shift();
  }

  if (recentHighlightMsgs.length >= HIGHLIGHT_THRESHOLD) {
    recentHighlightMsgs.length = 0;
    lastMarkerTime = now;

    try {
      const { createStreamMarker } = require('../twitch/api');
      const markerResult = await createStreamMarker('Momento epico detectado por el chat');
      if (markerResult) {
        logger.info(`Stream marker creado automaticamente`);
        client.say(channel, `🏁 Momento marcado para el VOD! FUA! 🔥`);
      }
    } catch (err) {
      logger.warn(`No se pudo crear marker: ${err.message}`);
    }
  }
}

module.exports = {
  handleCohost, handleChiste, handleQuestion, handleShoutout,
  addToHistory, updateLastChatTime, getRecentHistory, checkChatHook, checkStreamStatus,
  initStreamStatus, invalidateContextCache, checkForHighlight,
  getActiveUsers, resetActiveUsers
};