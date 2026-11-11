process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const supabase = require('../src/utils/supabase');
const { scrubNicks, nicksFromChatSample, cleanNicks } = require('../src/privacy/names');

describe('scrubNicks', () => {
  test('sustituye el nick (con o sin @) y respeta palabras que lo contienen', () => {
    assert.equal(
      scrubNicks('Ana_Pro hizo clutch y @ana_pro rió; banana_pro no', ['ana_pro']),
      'un espectador hizo clutch y un espectador rió; banana_pro no',
    );
    assert.equal(scrubNicks('ana y banana', ['ana']), 'un espectador y banana');
  });

  test('ignora nicks de menos de 3 letras, vacíos y los públicos (bot, streamers)', () => {
    process.env.BOT_USERNAME = 'dios_fua';
    assert.equal(scrubNicks('el bo y dios_fua', ['bo', 'dios_fua']), 'el bo y dios_fua');
    assert.equal(scrubNicks('hola', []), 'hola');
    assert.equal(scrubNicks(null, ['ana']), null);
  });

  test('nicksFromChatSample lee "usuario: mensaje"', () => {
    assert.deepEqual(nicksFromChatSample('Ana: hola\nbob: qué tal: bien\nsin separador').sort(), ['ana', 'bob']);
    assert.deepEqual(cleanNicks(['@Ana', 'ana', 'x']), ['ana']);
  });
});

describe('hechos de usuario por user_id', () => {
  let fake;
  beforeEach(() => {
    fake = createFakeSupabase({
      users: [
        { user_id: '1', username: 'Ana', last_seen: new Date().toISOString() },
        { user_id: '2', username: 'Bob', last_seen: new Date().toISOString() },
      ],
    });
    supabase.setClientForTests(fake);
  });

  test('incrementUserCounter / getUserCounter: por id, independientes entre usuarios', async () => {
    assert.equal(await supabase.incrementUserCounter('1', 'trivia_wins'), 1);
    assert.equal(await supabase.incrementUserCounter('1', 'trivia_wins'), 2);
    assert.equal(await supabase.incrementUserCounter('2', 'trivia_wins'), 1);
    assert.equal(await supabase.getUserCounter('1', 'trivia_wins'), 2);
    assert.equal(await supabase.getUserCounter('2', 'trivia_wins'), 1);
    assert.equal(
      fake.rows('user_facts').every((r) => r.username === undefined),
      true,
      'no se guarda el nick',
    );
  });

  test('sin user_id no se guarda ni se lee nada', async () => {
    assert.equal(await supabase.incrementUserCounter(null, 'trivia_wins'), null);
    assert.equal(await supabase.getUserCounter('', 'trivia_wins'), 0);
    assert.deepEqual(await supabase.getUserFacts(undefined), []);
    assert.equal(fake.rows('user_facts').length, 0);
  });

  test('getCounterLeaderboard devuelve el nick desde users', async () => {
    await supabase.incrementUserCounter('2', 'trivia_wins');
    await supabase.incrementUserCounter('2', 'trivia_wins');
    await supabase.incrementUserCounter('1', 'trivia_wins');
    const top = await supabase.getCounterLeaderboard('trivia_wins', 5);
    assert.deepEqual(
      top.map((r) => [r.userId, r.username, r.count]),
      [
        ['2', 'bob', 2],
        ['1', 'ana', 1],
      ],
    );
  });

  test('saveUserFact guarda por id y getUserFacts lo lee', async () => {
    supabase.saveUserFact('1', 'is_regular', 'true');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await supabase.getUserFacts('1'), [{ fact_type: 'is_regular', value: 'true' }]);
    assert.deepEqual(await supabase.getUserFacts('2'), []);
  });
});
