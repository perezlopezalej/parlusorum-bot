process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.TIMER_MIN_GAP_MS = '40';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

stub('src/eventsub.js', { isLiveViaEventSub: () => true, getStreamUptime: () => '1h' });
stub('src/twitch/api.js', { getCurrentGame: async () => null, getGameInfo: async () => null });
stub('src/ai/handler.js', { getBotPersonality: () => '' });
stub('src/lore/handler.js', { getLoreContext: async () => '' });

const { enqueueTimerMessage, stop } = require('../src/timers/handler');

test('los timers que coinciden salen espaciados, no a la vez', async () => {
  const times = [];
  for (let i = 0; i < 3; i++) enqueueTimerMessage(() => times.push(Date.now()));
  await new Promise(r => setTimeout(r, 200));
  stop();
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 35, `hueco 1: ${times[1] - times[0]}`);
  assert.ok(times[2] - times[1] >= 35, `hueco 2: ${times[2] - times[1]}`);
});
