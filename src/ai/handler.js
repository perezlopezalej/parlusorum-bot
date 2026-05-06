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

function truncate(msg) {
  if (msg.length <= TWITCH_MAX_LENGTH) return msg;
  return msg.slice(0, TWITCH_MAX_LENGTH - 3) + '...';
}

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

function getChannelContext() {
  const games = (channelConfig.games_played || []).slice(0, 4).join(', ');
  return `Canal: ${channelConfig.streamer}. ${channelConfig.content}. Ambiente: ${channelConfig.vibe}. Juegos recientes: ${games}. ${channelConfig.inside_jokes || ''}`;
}

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
    const rawgInfo = await getGameInfo(gameInfo.game).catch(() => null);
    if (rawgInfo?.genres) context += ` Géneros: ${rawgInfo.genres}.`;
  }
  context += streamInfo?.live
    ? ` Stream en directo con ${streamInfo.viewers} viewers.`
    : ` Canal offline.`;
  fullContextCache = context;
  lastContextCheck = now;
  return fullContextCache;
}

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

const userConversations = new Map();
const sessionStart = Date.now();
const MAX_CONV_TURNS = 5;

function getUserConversation(userId) {
  const conv = userConversations.get(userId) || [];
  return conv.filter(m => m.ts > sessionStart).map(({ role, content }) => ({ role, content }));
}

function addToUserConversation(userId, role, content) {
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

async function getPersonality(messageCount) {
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  const context = await getFullContext();
  const base = `Eres ${botName}, bot de ${channelConfig.streamer}. ${channelConfig.bot_personality || ''}
${context}
Reglas: español natural siempre. Max 2 frases (400 chars). No te presentes. Directo al grano. Usa "FUA" cuando algo es épico. Si no sabes: "ni idea" con humor. NUNCA inventes datos. Sin "Lo siento".`;
  if (messageCount >= 20) return `${base} Chat muy activo, sé enérgico.`;
  if (messageCount >= 5) return `${base} Chat tranquilo, sé amigable.`;
  return `${base} Chat muy tranquilo, sé acogedor.`;
}

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
    const personality = await getPersonality(trackMessage());
    const response = await groqWithRetry({
      model: 'llama-3.3-70b-versatile', max_tokens: 70,
      messages: [
        { role: 'system', content: `${personality} Co-presentador espontáneo. Sin saludos. 1 frase.` },
        { role: 'user', content: `Chat:\n${context}\nComentario natural en español.` }
      ]
    });
    client.say(channel, truncate(response.choices[0].message.content));
  } catch (err) { logger.error(`Co-host: ${err.message}`); }
  finally { cohostRunning = false; }
}

let lastHookTime = 0;
const HOOK_INTERVAL = parseInt(process.env.HOOK_INTERVAL_MS || '600000', 10);
const HOOK_MIN_SILENCE = parseInt(process.env.HOOK_SILENCE_MS || '300000', 10);
const chatQuestions = [
  '¿Qué tal está yendo el stream? 👀',
  '¿Cuál es vuestro juego favorito del canal? 🎮',
  '¡Chat! ¿Alguien se anima con un !trivia? 🧠',
  '¿Alguna pregunta? ¡Usad !dios_fua! 🤖',
  '¿Cooperativo o en solitario? ¡FUA! 💪',
  '¿Cuántas muertes creéis que habrá hoy? 💀',
];

function checkChatHook(client, channel) {
  if (isSilenced() || isTriviaActive()) return;
  const now = Date.now();
  if (now - lastHookTime < HOOK_INTERVAL) return;
  if (now - lastChatMessageTime < HOOK_MIN_SILENCE) return;
  lastHookTime = now;
  client.say(channel, chatQuestions[Math.floor(Math.random() * chatQuestions.length)]);
}

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
  try {
    const personality = await getPersonality(trackMessage());
    const userConv = getUserConversation(userId);
    const response = await groqWithRetry({
      model: 'llama-3.3-70b-versatile', max_tokens: 150,
      messages: [
        { role: 'system', content: `${personality}\nRespuesta directa. NUNCA inventes viewers/subs. Si no sabes: humor. No "Lo siento".` },
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
    const personality = await getPersonality(trackMessage());
    const response = await groqWithRetry({
      model: 'llama-3.3-70b-versatile', max_tokens: 100,
      messages: [
        { role: 'system', content: personality },
        { role: 'user', content: personalityPrompts[command] }
      ]
    });
    client.say(channel, truncate(response.choices[0].message.content));
    personalityCooldowns.set(key, now + 30000);
  } catch (err) { logger.error(`!${command}: ${err.message}`); client.say(channel, `No puedo responder ahora mismo.`); }
}

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
        { role: 'system', content: `Shoutout para @${target}. ${game} En español. 1 frase. Anima a visitarle.` },
        { role: 'user', content: `Shoutout para @${target}` }
      ]
    });
    client.say(channel, truncate(`📢 ${response.choices[0].message.content.trim()} twitch.tv/${target}`));
  } catch (err) {
    logger.error(`!so: ${err.message}`);
    client.say(channel, `📢 ¡Echad un ojo a @${targetUsername.replace('@', '')}! 💜 twitch.tv/${targetUsername.replace('@', '')}`);
  }
}

module.exports = { handleCohost, handleChiste, handleQuestion, handlePersonality, handleShoutout, addToHistory, updateLastChatTime, checkChatHook };
