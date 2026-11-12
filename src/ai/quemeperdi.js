// !quemeperdi: resumen de lo que se ha perdido quien llega tarde.
const channelConfig = require('../../config/channel.json');
const messagesConfig = require('../../config/messages.json');
const { getCurrentGame } = require('../twitch/api');
const {
  getPlayer,
  isSilenced,
  getStreamNarrative,
  getBotHistory,
  addBotMessage,
  getStreamIsLive,
  getDeathCount,
  getBossCount,
  getStreamStartedAt,
} = require('../utils/state');
const { buildStoryBlock } = require('../utils/narrative');
const factcheck = require('./factcheck');
const quality = require('./quality');
const { spokenDuration, spokenSeconds } = quality;
const { canMakeRequest, canUserMakeRequest } = require('../utils/ratelimit');
const { buildQueMePerdiSystem, retryNote } = require('./style');
const logger = require('../utils/logger');
const { truncate, TWITCH_MAX_LENGTH } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const { getUserType } = require('./common');
const { getStreamChatBuffer } = require('./chat-memory');

// --- !quemeperdi ---
const queMePerdiCooldowns = new Map();

const QUEMEPERDI_COOLDOWN_MS = 120000;
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of queMePerdiCooldowns) if (now > v) queMePerdiCooldowns.delete(k);
  },
  30 * 60 * 1000,
);

async function handleQueMePerdi(client, channel, tags) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  const userId = tags['user-id'] || tags['username'] || username;
  const msgs = messagesConfig.quemeperdi;
  if (!getStreamIsLive()) {
    client.say(channel, truncate(msgs.offline.replace('{username}', username)));
    return;
  }

  const now = Date.now();
  const until = queMePerdiCooldowns.get(userId);
  if (until && now < until) {
    client.say(
      channel,
      truncate(
        msgs.cooldown
          .replace('{username}', username)
          .replace('{seconds}', spokenSeconds(Math.ceil((until - now) / 1000))),
      ),
    );
    return;
  }

  const chat = getStreamChatBuffer();
  const narrative = getStreamNarrative();
  if (!chat && narrative.length === 0) {
    client.say(channel, truncate(msgs.nothing_yet.replace('{username}', username)));
    return;
  }
  queMePerdiCooldowns.set(userId, now + QUEMEPERDI_COOLDOWN_MS);

  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game || null;
  const startedAt = getStreamStartedAt();
  const minutes = startedAt ? Math.floor((now - startedAt) / 60000) : 0;
  const deaths = getDeathCount();

  if (!canMakeRequest() || !canUserMakeRequest(userId, getUserType(username, tags))) {
    client.say(
      channel,
      truncate(
        msgs.fallback
          .replace('{minutes}', spokenDuration(minutes))
          .replace('{game}', game || 'directo')
          .replace('{deaths}', quality.countDeaths(deaths)),
      ),
    );
    return;
  }
  try {
    const story = buildStoryBlock(narrative);
    const bosses = getBossCount();
    const facts = `Minutos de stream: ${minutes}. Muertes del streamer (veces que ha caído): ${deaths}. Jefes derrotados: ${bosses}.`;
    let text = '';
    let feedback = '';
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      if (attempt > 0 && !canMakeRequest()) break;
      const response = await aiChat('quemeperdi', {
        max_tokens: 150,
        messages: [
          {
            role: 'system',
            content: `${buildQueMePerdiSystem({ game: game || '', player: getPlayer() })}${retryNote(feedback)}`,
          },
          {
            role: 'user',
            content: `<datos>${facts}</datos>${story}
<chat>
${chat}
</chat>
Cuenta lo ocurrido.`,
          },
        ],
      });
      const choice = response.choices[0];
      const out = (
        choice.finish_reason === 'length'
          ? quality.dropTrailingFragment(choice.message.content)
          : choice.message.content || ''
      ).trim();
      const problem = quality.validateQueMePerdi(out, {
        deathCount: deaths,
        bosses,
        minutes,
        source: `${chat}\n${story}\n${facts}`,
      });
      if (problem) {
        feedback = problem;
        logger.info(`!quemeperdi descartado (${problem}): ${out.slice(0, 80)}`);
        continue;
      }
      if (await factcheck.shouldDiscard(out, `Juego: ${game || 'desconocido'}. ${facts}`)) {
        feedback = 'afirma datos del juego sin respaldo; no hables del juego';
        continue;
      }
      text = out;
    }
    if (!text) throw new Error('sin respuesta válida');
    // Emote como en el resto (1 de cada 3, siempre al final) y nunca partido: si el mensaje no cabe, se quita el emote
    const qEmotes = channelConfig.channel_emotes || [];
    const qAllow = quality.emoteAllowed(
      getBotHistory().map((e) => e.msg),
      qEmotes,
    );
    const qBody = quality.applyEmotePolicy(
      text,
      qAllow,
      qEmotes,
      getBotHistory().map((e) => e.msg),
    );
    const qOut = truncate(quality.fitWithEmotes(`@${username} ${qBody}`, TWITCH_MAX_LENGTH, qEmotes));
    client.say(channel, qOut);
    addBotMessage(qOut.replace(/^@\S+\s*/, ''));
  } catch (err) {
    logger.warn(`!quemeperdi: ${err.message}`);
    queMePerdiCooldowns.delete(userId);
    client.say(
      channel,
      truncate(
        msgs.fallback
          .replace('{minutes}', spokenDuration(minutes))
          .replace('{game}', game || 'directo')
          .replace('{deaths}', quality.countDeaths(deaths)),
      ),
    );
  }
}

module.exports = { handleQueMePerdi };
