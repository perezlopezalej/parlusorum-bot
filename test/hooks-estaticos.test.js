// Un solo hook fijo de juego por stream («¿Alguien lo conocía ya?», «¿Alguien lo ha jugado?»…).
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { pickStaticHook, GAME_HOOK_MARK } = require('../src/ai/hooks');

const gameHooks = ['¿Alguien lo ha jugado?', '¿Qué os parece el juego?', '¿Alguien lo conocía ya?'];
const genericHooks = ['¿Cooperativo o en solitario?', '¡Chat! ¿Alguien se anima con un !trivia?'];

describe('pickStaticHook', () => {
  test('mientras no haya salido uno de juego, entran los tres', () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++)
      seen.add(pickStaticHook({ gameHooks, genericHooks, rng: () => (i % 5) / 5 + 0.01 }).hook);
    for (const h of gameHooks) assert.ok(seen.has(h), h);
  });

  test('tras uno de juego, solo genéricos, aunque se agoten y se reinicie la lista', () => {
    for (let i = 0; i < 20; i++) {
      const { hook, isGame } = pickStaticHook({ gameHooks, genericHooks, gameHookUsed: true, rng: Math.random });
      assert.ok(genericHooks.includes(hook), hook);
      assert.equal(isGame, false);
    }
    const all = pickStaticHook({ gameHooks, genericHooks, gameHookUsed: true, used: new Set(genericHooks) });
    assert.equal(all.reset, true);
    assert.ok(genericHooks.includes(all.hook));
  });

  test('marca si el elegido es de juego y no repite los ya dichos', () => {
    const used = new Set([...gameHooks.slice(1), ...genericHooks]);
    const r = pickStaticHook({ gameHooks, genericHooks, used, rng: () => 0 });
    assert.equal(r.hook, gameHooks[0]);
    assert.equal(r.isGame, true);
    assert.equal(r.reset, false);
    assert.equal(GAME_HOOK_MARK, 'hook-juego');
  });
});
