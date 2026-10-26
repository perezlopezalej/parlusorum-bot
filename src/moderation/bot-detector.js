'use strict';

const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

const BROADCASTER_ID = channelConfig.broadcaster_id;
const BATCH_DELAY_MS = 5000;
const MAX_BATCH_SIZE = 100;
const TWITCHBOTS_API = 'https://api.twitchbots.info/v2/bot';

const WHITELIST = new Set([
  ...(channelConfig.bot_whitelist || []),
  process.env.BOT_USERNAME || '',
  channelConfig.streamer_username || '',
].map(n => String(n).toLowerCase()).filter(Boolean));

function isWhitelisted(username) {
  return WHITELIST.has(String(username || '').toLowerCase());
}

const verifiedIds = new Set();
let pendingBatch = new Map();
let batchTimer = null;

function getHelixHeaders() {
  const token = (process.env.BROADCASTER_TOKEN || '').replace('oauth:', '');
  return {
    'Client-ID': process.env.CLIENT_ID,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function banUser(userId, username) {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${BROADCASTER_ID}&moderator_id=${BROADCASTER_ID}`,
      {
        method: 'POST',
        headers: getHelixHeaders(),
        body: JSON.stringify({ data: { user_id: userId, reason: 'Bot conocido detectado automáticamente' } })
      }
    );
    if (res.ok) {
      logger.info(`[BotDetector] Bot baneado: ${username} (${userId})`);
    } else if (res.status === 422) {
      logger.info(`[BotDetector] ${username} (${userId}) ya estaba baneado`);
    } else {
      const body = await res.text();
      logger.warn(`[BotDetector] Ban fallido para ${username}: ${res.status} ${body}`);
    }
  } catch (e) {
    logger.warn(`[BotDetector] Error al banear ${username}: ${e.message}`);
  }
}

async function processBatch(batch) {
  const ids = [...batch.keys()];
  if (ids.length === 0) return;
  try {
    const res = await fetch(
      `${TWITCHBOTS_API}?ids=${ids.join(',')}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) {
      logger.warn(`[BotDetector] twitchbots.info error: ${res.status}`);
      return;
    }
    const data = await res.json();
    const botIds = new Set((data.bots || []).map(b => String(b.id ?? b.user_id)));
    for (const id of ids) {
      if (botIds.has(String(id))) {
        if (isWhitelisted(batch.get(id))) continue;
        if (channelConfig.bot_autoban_dry_run !== false) {
          logger.info(`[BotDetector] [DRY-RUN] Baneraria a ${batch.get(id) || id} (${id}) — bot conocido, no se banea`);
          continue;
        }
        banUser(id, batch.get(id) || id);
      }
    }
  } catch (e) {
    logger.warn(`[BotDetector] Error consultando twitchbots.info: ${e.message}`);
  }
}

function checkNewUser(tags) {
  const userId = tags['user-id'];
  if (!userId || verifiedIds.has(userId)) return;
  verifiedIds.add(userId);
  if (isWhitelisted(tags.username) || isWhitelisted(tags['display-name'])) return;
  const username = tags['display-name'] || tags.username || userId;
  pendingBatch.set(userId, username);
  if (pendingBatch.size >= MAX_BATCH_SIZE) {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    const batch = pendingBatch;
    pendingBatch = new Map();
    processBatch(batch);
    return;
  }
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      batchTimer = null;
      const batch = pendingBatch;
      pendingBatch = new Map();
      processBatch(batch);
    }, BATCH_DELAY_MS);
  }
}

module.exports = { checkNewUser };
