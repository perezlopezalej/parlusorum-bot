// Módulo de IA del bot. Fachada: la lógica vive en los módulos de src/ai/ (chat-memory, prompt-context, cohost, stream-status, quemeperdi, hooks, dios-fua, shoutout, chat-triggers, mentions, common).
const { resetLoreSample } = require('../utils/state');
const logger = require('../utils/logger');
const { addToHistory, addToUserConversation, clearUserFactsCache, forgetUserInMemory, getActiveUserIds, getActiveUsers, getActiveUsersWithMinMessages, getCachedUserFacts, getChatWindow, getRecentHistory, getStreamChatBuffer, getUserConversation, questionCooldowns, resetActiveUsers, streamChatBuffer, updateLastChatTime } = require('./chat-memory');
const { checkChatHook, recentHooks, usedStaticHooks } = require('./hooks');
const { chisteCooldowns, handleChiste, handleQuestion } = require('./dios-fua');
const { enqueueCohostMoment, runCohost, startEventCohost } = require('./cohost');
const { handleShoutout } = require('./shoutout');
const { handleQueMePerdi } = require('./quemeperdi');
const { checkStreamStatus, initStreamStatus, onWarmupMode, postStreamEnd } = require('./stream-status');
const { checkCapsRage, checkEmoteSpam, checkForHighlight } = require('./chat-triggers');
const { checkPatternMatch } = require('./mentions');

function resetStreamChatBuffer() {
  streamChatBuffer.length = 0;
  recentHooks.length = 0;
  usedStaticHooks.clear();
  resetLoreSample();
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
  runCohost, enqueueCohostMoment, startEventCohost, handleChiste, handleQuestion, handleShoutout, handleQueMePerdi,
  addToHistory, updateLastChatTime, getRecentHistory, checkChatHook, checkStreamStatus,
  initStreamStatus, checkForHighlight,
  checkEmoteSpam, checkCapsRage, checkPatternMatch,
  getActiveUsers, getActiveUsersWithMinMessages, resetActiveUsers, onWarmupMode, postStreamEnd,
  getStreamChatBuffer, resetStreamChatBuffer,
  restoreCooldowns, clearUserFactsCache, getCachedUserFacts, getActiveUserIds, forgetUserInMemory,
  // solo tests
  addToUserConversation, getUserConversation,
  getChatWindow,
};
