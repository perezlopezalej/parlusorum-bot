const Groq = require('groq-sdk');
const channelConfig = require('../../config/channel.json');
const { getCurrentGame, getGameInfo, getStreamInfo } = require('../twitch/api');
const { isTriviaActive, isSilenced } = require('../utils/state');
const { sanitizeForAI } = require('../utils/filter');
const { canMakeRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TWITCH_MAX_LENGTH = 490;
const COHOST_COOLDOWN = parseInt(process.env.COHOST_COOLDOWN_MS || '180000', 10);
const COHOST_PROBABILITY = parseFloat(process.env.COHOST_PROBABILITY || '0.08');
const QUESTION_COOLDOWN_MS = parseInt(process.env.QUESTION_COOLDOWN_MS || '10000', 10);
const MAX_QUESTION_LENGTH = 200;

function truncate(msg) {
  if (msg.length <= TWITCH_MAX_LENGTH) return msg;
  return msg.slice(0, TWITCH_MAX_LENGTH - 3) + '...';
}

// --- Retry con backoff ---
async function groqWithRetry(params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await groq.chat.completions.create(params); }
    catch (err) {
      const isRateLimit = err.status === 429 || err.message?.includes('rate');
      if (isRateLimit && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
}

// --- Contexto del canal compacto ---
function getChannelContext() {
  const games = (channelConfig.games_played || []).slice(0, 4).join(', ');
  return `Canal: ${channelConfig.streamer}. ${channelConfig.content}. Ambiente: ${channelConfig.vibe}. Juegos: ${games}. ${channelConfig.inside_jokes || ''}`;
}

// --- Contexto completo dinámico (con fallback si RAWG falla) ---
let fullContextCache = null;
let lastContextCheck = 0;
const CONTEXT_CACHE_TTL = 2 * 60 * 1000;

async function getFullContext() {
  const now = Date.now();
  if (fullContextCache && now - lastContextCheck < CONTEXT_CACHE_TTL) return fullContextCache;

  const [gameInfo, streamInfo] = await Promise.all([getCurrentGame(), getStreamInfo()]);
  const base = getChannelContext();
  let context = base;

  if (gameInfo?.game) {
    context += ` Juego actual: "${gameInfo.game}".`;
    // RAWG con fallback — si falla no bloquea el contexto
    try {
      const rawgInfo = await getGameInfo(gameInfo.game);
      if (rawgInfo?.genres) context += ` Géneros: ${rawgInfo.genres}.`;
    } catch {}
  }

  context += streamInfo?.live
    ? ` Stream en directo con ${streamInfo.viewers} viewers.`
    : ` Canal offline.`;

  fullContextCache = context;
  lastContextCheck = now;
  return fullContextCache;
}

// --- Contexto mínimo para comandos de personalidad (sin viewers ni stream info) ---
function getMinimalContext() {
  const games = (channelConfig.games_played || []).slice(0, 3).join(', ');
  return `Canal de ${channelConfig.streamer}: ${channelConfig.vibe}. Juegos: ${games}. ${channelConfig.inside_jokes || ''}`;
}

// --- Historial de chat (sin comandos) ---
const chatHistory = [];
const MAX_HISTORY = 40;
let lastChatMessageTime = Date.now();

function addToHistory(username, message) {
  if (message.startsWith('!')) return;
  chatHistory.push({ username, message, ts: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  lastChatMessageTime = Date.now();
}

function updateLastChatTime() { lastChatMessageTime = Date.now(); }

function getRecentHistory(n = 6) {
  return chatHistory.slice(-n).map(m => `${m.username}: ${m.message}`).join('\n');
}

// --- Memoria de conversación por usuario (máx 1 hora) ---
const userConversations = new Map();
const sessionStart = Date.now();
const MAX_CONV_TURNS = 5;
const MAX_CONV_AGE = 60 * 60 * 1000; // 1 hora

function getUserConversation(userId) {
  const conv = userConversations.get(userId) || [];
  const cutoff = Date.now() - MAX_CONV_AGE;
  return conv
    .filter(m => m.ts > sessionStart && m.ts > cutoff)
    .map(({ role, content }) => ({ role, content }));
}

function addToUserConversation(userId, role, content) {
  const conv = userConversations.get(userId) || [];
  conv.push({ role, content, ts: Date.now() });
  while (conv.length > MAX_CONV_TURNS * 2) conv.shift();
  userConversations.set(userId, conv);
}

// --- Mensajes recientes ---
const recentMessages = [];
function trackMessage() {
  const now = Date.now();
  recentMessages.push(now);
  while (recentMessages.length > 0 && recentMessages[0] < now - 60000) recentMessages.shift();
  return recentMessages.length;
}

// --- Personalidad completa (para !dios_fua y co-host) ---
async function getPersonality(messageCount) {
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  const context = await getFullContext();
  const base = `Eres ${botName}, bot de ${channelConfig.streamer}. ${channelConfig.bot_personality || ''}
${context}
Reglas: español natural siempre. Max 2 frases (400 chars). No te presentes. Directo. Usa "FUA" cuando es épico. Si no sabes: "ni idea" con humor. NUNCA inventes datos. Sin "Lo siento".`;
  if (messageCount >= 20) return `${base} Chat muy activo, sé enérgico.`;
  if (messageCount >= 5) return `${base} Chat tranquilo, sé amigable.`;
  return `${base} Chat tranquilo, sé acogedor.`;
}

// --- Personalidad mínima (para !cita, !consejo, !meme) ---
function getMinimalPersonality() {
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  return `Eres ${botName}, bot gracioso del canal de ${channelConfig.streamer}. ${getMinimalContext()} Responde en español. Max 1-2 frases cortas. Puedes usar "FUA" si es épico.`;
}

// --- Co-host (prompt diferenciado, más espectador) ---
let lastCohostTime = 0;
let cohostRunning = false;

async function handleCohost(client, channel) {
  if (isSilenced() || isTriviaActive() || cohostRunning) return;
  const now = Date.now();
  if (now - lastCohostTime < COHOST_COOLDOWN) return;
  if (Math.random() > COHOST_PROBABILITY) return;
  if (chatHistory.length < 3) return;
  if (!canMakeRequest()) return;

  cohostRunning = true;
  lastCohostTime = now;

  try {
    const context = getRecentHistory(5);
    const gameInfo = await getCurrentGame();
    const game = gameInfo?.game ? `Están jugando a "${gameInfo.game}".` : '';

    const response = await groqWithRetry({
      model: 'llama-3.3-70b-versatile', max_tokens: 70,
      messages: [
        {
          role: 'system',
          content: `Eres un espectador habitual del canal de ${channelConfig.streamer} con mucho buen rollo. ${game} Haces comentarios espontáneos como lo haría alguien del chat, no como un bot. Sin saludos formales. Sin presentarte. 1 frase máximo en español. A veces usas FUA cuando algo es épico.`
        },
        { role: 'user', content: `Chat reciente:\n${context}\nComenta algo natural sobre lo que está pasando.` }
      ]
    });
    client.say(channel, truncate(response.choices[0].message.content));
  } catch (err) { logger.error(`Co-host: ${err.message}`); }
  finally { cohostRunning = false; }
}

// --- Detección de inicio y cierre de stream ---
let streamWasLive = false;
let streamStatusInitialized = false;

// Inicializar estado real del stream al arrancar (evita falso positivo en reinicio)
async function initStreamStatus() {
  const info = await getStreamInfo().catch(() => null);
  streamWasLive = info?.live === true;
  streamStatusInitialized = true;
  logger.info(`📺 Estado inicial del stream: ${streamWasLive ? 'EN DIRECTO' : 'OFFLINE'}`);
}

const streamStartMessages = [
  '🔴 ¡El stream ha arrancado! ¡Bienvenidos todos! ¡FUA! 💪🔥',
  '🎮 ¡El canal ha arrancado! ¡A disfrutar! ¡FUA! 🔥',
  '🔴 ¡ESTAMOS EN DIRECTO! ¡El FUA nos convoca! ¡Bienvenidos! 💪',
  '🚀 ¡Arranca el stream! ¡Preparaos para el caos! ¡FUA! 🔥',
];

const streamEndMessages = [
  '🎬 ¡Y hasta aquí el stream de hoy! ¡Gracias a todos por estar ahí! ¡FUA y hasta la próxima! 💜🔥',
  '💜 ¡Stream terminado! ¡Gracias por acompañarnos! ¡FUA! Hasta la próxima 🔥',
  '🎮 ¡Eso es todo por hoy! ¡Gracias a toda la comunidad! ¡FUA! 💜',
  '🔴➡️⚫ ¡Se acabó! ¡Gracias por el stream! ¡FUA y nos vemos pronto! 🔥💪',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function checkStreamStatus(client, channel) {
  if (!streamStatusInitialized) return;
  const info = await getStreamInfo().catch(() => null);
  if (!info) return;

  if (!streamWasLive && info.live) {
    // Stream acaba de empezar
    streamWasLive = true;
    fullContextCache = null; // Invalidar cache para que coja el juego nuevo
    client.say(channel, pickRandom(streamStartMessages));
  } else if (streamWasLive && !info.live) {
    // Stream acaba de terminar
    streamWasLive = false;
    fullContextCache = null;
    client.say(channel, pickRandom(streamEndMessages));
  }
}

// --- Conversation hooks ---
let lastHookTime = 0;
const HOOK_INTERVAL = parseInt(process.env.HOOK_INTERVAL_MS || '600000', 10);
const HOOK_MIN_SILENCE = parseInt(process.env.HOOK_SILENCE_MS || '300000', 10);

async function checkChatHook(client, channel) {
  if (isSilenced() || isTriviaActive()) return;
  const now = Date.now();
  if (now - lastHookTime < HOOK_INTERVAL) return;
  if (now - lastChatMessageTime < HOOK_MIN_SILENCE) return;
  lastHookTime = now;
  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game;
  const genericHooks = [
    '¿Alguien tiene alguna pregunta? ¡Usad !dios_fua! 🤖',
    '¿Sois más de cooperativo o en solitario? 💬',
    '¡Chat! ¿Alguien se anima con un !trivia? 🧠',
    '¿Cuántas muertes creéis que habrá hoy? 💀',
  ];
  const gameHooks = game ? [
    `¿Qué os parece ${game} hasta ahora? 🎮`,
    `¿Alguien ha jugado ${game}? ¿Es difícil? 🤔`,
  ] : [];
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
  if (!rawQuestion) { client.say(channel, `@${username} escribe algo después de !dios_fua 😅`); return; }
  const question = sanitizeForAI(rawQuestion);
  if (!question) { client.say(channel, `@${username} esa pregunta no la puedo responder 🙅`); return; }
  if (!canMakeRequest()) { client.say(channel, `@${username} demasiadas peticiones ⏳`); return; }
  if (rawQuestion.length > MAX_QUESTION_LENGTH) {
    client.say(channel, `@${username} (pregunta muy larga, respondo a los primeros ${MAX_QUESTION_LENGTH} caracteres)`);
  }
  try {
    const personality = await getPersonality(trackMessage());
    const userConv = getUserConversation(userId);
    const response = await groqWithRetry({
      model: 'llama-3.3-70b-versatile', max_tokens: 150,
      messages: [
        { role: 'system', content: `${personality}\nRespuesta directa. NUNCA inventes viewers/subs. Si no sabes: humor. Sin "Lo siento".` },
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

// --- Comandos de personalidad ---
const personalityPrompts = {
  cita: 'Frase épica o inspiradora de videojuegos. Solo frase y autor. 1 frase en español.',
  consejo: 'Consejo random útil, absurdo o gracioso. 1 frase en español. Puedes usar FUA.',
  meme: 'Describe un meme de internet o gaming. 1 frase graciosa en español.'
};
const personalityCooldowns = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of personalityCooldowns) if (now > v) personalityCooldowns.delete(k); }, 30 * 60 * 1000);

async function handlePersonality(client, channel, tags, command) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const key = `${command}-${userId}`;
  const now = Date.now();
  if (personalityCooldowns.has(key) && now < personalityCooldowns.get(key)) {
    client.say(channel, `@${username} espera ${Math.ceil((personalityCooldowns.get(key) - now) / 1000)}s.`);
    return;
  }
  if (!canMakeRequest()) { client.say(channel, `@${username} demasiadas peticiones ⏳`); return; }
  try {
    const response = await groqWithRetry({
      model: 'llama-3.3-70b-versatile', max_tokens: 90,
      messages: [
        { role: 'system', content: getMinimalPersonality() },
        { role: 'user', content: personalityPrompts[command] }
      ]
    });
    client.say(channel, truncate(response.choices[0].message.content));
    personalityCooldowns.set(key, now + 30000);
  } catch (err) { logger.error(`!${command}: ${err.message}`); client.say(channel, `No puedo responder ahora mismo.`); }
}

// --- !so ---
async function handleShoutout(client, channel, tags, targetUsername) {
  const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';
  if (!isMod) { client.say(channel, `@${tags['display-name']} solo mods pueden usar !so.`); return; }
  if (!targetUsername) { client.say(channel, `Uso: !so @usuario`); return; }
  const { getChannelInfo } = require('../twitch/api');
  try {
    const target = targetUsername.replace('@', '');
    const info = await getChannelInfo(target);
    const game = info?.game_name ? `Su último juego: "${info.game_name}".` : '';
    const response = await groqWithRetry({
      model: 'llama-3.3-70b-versatile', max_tokens: 80,
      messages: [
        { role: 'system', content: `Shoutout para @${target}. ${game} En español. 1 frase cálida y graciosa. Anima a visitarle.` },
        { role: 'user', content: `Shoutout para @${target}` }
      ]
    });
    client.say(channel, truncate(`📢 ${response.choices[0].message.content.trim()} twitch.tv/${target}`));
  } catch (err) {
    logger.error(`!so: ${err.message}`);
    client.say(channel, `📢 ¡Echad un ojo a @${targetUsername.replace('@', '')}! 💜 twitch.tv/${targetUsername.replace('@', '')}`);
  }
}

module.exports = {
  handleCohost,
  handleChiste,
  handleQuestion,
  handlePersonality,
  handleShoutout,
  addToHistory,
  updateLastChatTime,
  checkChatHook,
  checkStreamStatus,
  initStreamStatus
};
