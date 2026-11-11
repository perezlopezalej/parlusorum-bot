// !so: shoutout a otro canal.
const { getChannelInfo } = require('../twitch/api');
const { canMakeRequest } = require('../utils/ratelimit');
const { buildShoutoutSystem } = require('./style');
const logger = require('../utils/logger');
const { truncate } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');

// --- !so ---
async function handleShoutout(client, channel, tags, targetUsername) {
  const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';
  if (!isMod) {
    client.say(channel, `@${tags['display-name']} solo mods pueden usar !so.`);
    return;
  }
  if (!targetUsername) {
    client.say(channel, `Uso: !so @usuario`);
    return;
  }

  const target = targetUsername.replace('@', '');
  client.say(channel, `Preparando shoutout para @${target}...`);

  try {
    if (!canMakeRequest()) {
      client.say(channel, `📢 ¡Échad un ojo a @${target}! 💜 twitch.tv/${target}`);
      return;
    }
    const info = await getChannelInfo(target);
    const lastGame = info?.game_name ? `, su último juego: «${info.game_name}»` : '';
    const response = await aiChat('command', {
      max_tokens: 80,
      messages: [
        { role: 'system', content: buildShoutoutSystem() },
        { role: 'user', content: `<canal>@${target}${lastGame}</canal>` },
      ],
    });
    client.say(channel, truncate(`📢 ${response.choices[0].message.content.trim()} twitch.tv/${target}`));
  } catch (err) {
    logger.error(`!so: ${err.message}`);
    client.say(channel, `📢 ¡Échad un ojo a @${target}! 💜 twitch.tv/${target}`);
  }
}

module.exports = { handleShoutout };
