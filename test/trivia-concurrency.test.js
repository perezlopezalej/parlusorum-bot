process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

// getCurrentGame tarda: simula la ventana en la que dos !trivia seguidos se cruzan
stub('src/twitch/api.js', {
  getCurrentGame: () => new Promise(r => setTimeout(() => r(null), 30)),
  getGameInfo: async () => null
});
stub('src/utils/supabase.js', {
  incrementUserCounter: async () => {}, getCounterLeaderboard: async () => [],
  getRecentSessionDeaths: async () => [], getLoreRows: async () => []
});

const { handleTrivia } = require('../src/games/handler');

test('dos !trivia seguidos lanzan una sola trivia', async () => {
  const said = [];
  const client = { say: (_c, msg) => said.push(msg) };
  const origRandom = Math.random;
  Math.random = () => 0.99; // sin pregunta de canal
  try {
    await Promise.all([handleTrivia(client, '#c'), handleTrivia(client, '#c')]);
  } finally { Math.random = origRandom; }
  assert.equal(said.filter(m => m.includes('TRIVIA:')).length, 1);
});
