// 17-11: cuatro «sale de las sombras» a habituales que habían hablado poco antes (umbral de 15 min y sin mirar quién era).
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldGreetLurker,
  isChannelRegular,
  LURKER_THRESHOLD_MS,
  REGULAR_MIN_MESSAGES,
} = require('../src/alerts/lurker');

const MIN = 60 * 1000;
const NOW = 1_000_000_000_000;
const base = { now: NOW, lastSeenAt: NOW - 60 * MIN, userData: { messageCount: 8 }, tags: { badges: {} } };

describe('shouldGreetLurker', () => {
  test('el umbral por defecto es de 45 minutos', () => {
    assert.equal(LURKER_THRESHOLD_MS, 45 * MIN);
  });

  test('un espectador normal que vuelve tras una hora de silencio, sí', () => {
    assert.equal(shouldGreetLurker(base), true);
  });

  test('con un silencio corto (los 15-20 min del 17-11) no se avisa', () => {
    for (const gap of [5, 15, 20, 44])
      assert.equal(shouldGreetLurker({ ...base, lastSeenAt: NOW - gap * MIN }), false, `${gap} min`);
    assert.equal(shouldGreetLurker({ ...base, lastSeenAt: NOW - 45 * MIN }), true);
  });

  test('VIP, mods, suscriptores y streamer no salen «de las sombras»', () => {
    for (const tags of [
      { badges: { vip: '1' } },
      { badges: { moderator: '1' } },
      { mod: true, badges: {} },
      { 'user-type': 'mod', badges: {} },
      { badges: { subscriber: '12' } },
      { badges: { broadcaster: '1' } },
    ])
      assert.equal(shouldGreetLurker({ ...base, tags }), false, JSON.stringify(tags));
  });

  test('un habitual por mensajes tampoco', () => {
    assert.equal(shouldGreetLurker({ ...base, userData: { messageCount: REGULAR_MIN_MESSAGES } }), false);
    assert.equal(shouldGreetLurker({ ...base, userData: { messageCount: REGULAR_MIN_MESSAGES - 1 } }), true);
    assert.equal(isChannelRegular({}, { messageCount: 500 }), true);
  });

  test('solo una vez por persona y directo, y nunca sin haberla visto antes', () => {
    assert.equal(shouldGreetLurker({ ...base, greeted: true }), false);
    assert.equal(shouldGreetLurker({ ...base, lastSeenAt: 0 }), false);
  });

  test('sin datos del usuario ni insignias se trata como espectador normal', () => {
    assert.equal(shouldGreetLurker({ now: NOW, lastSeenAt: NOW - 90 * MIN }), true);
  });
});
