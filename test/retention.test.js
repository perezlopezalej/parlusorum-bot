process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const supabase = require('../src/utils/supabase');
const { runRetention } = require('../src/privacy/retention');

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600_000;
const D = 24 * H;

let fake;
beforeEach(() => {
  fake = createFakeSupabase({
    chat_log: [
      { id: 1, created_at: ago(25 * H), username: 'viejo', message: 'x' },
      { id: 2, created_at: ago(23 * H), username: 'nuevo', message: 'y' },
    ],
    quality_log: [
      { id: 1, created_at: ago(31 * D), kind: 'entry', payload: {}, user_keys: [] },
      { id: 2, created_at: ago(29 * D), kind: 'entry', payload: {}, user_keys: [] },
    ],
    users: [
      { user_id: 'u-viejo', username: 'viejo', last_seen: ago(400 * D), message_count: 50 },
      { user_id: 'u-medio', username: 'medio', last_seen: ago(120 * D), message_count: 20 },
      { user_id: 'u-activo', username: 'activo', last_seen: ago(2 * D), message_count: 5 },
    ],
    user_facts: [
      { user_id: 'u-viejo', channel: 'parlusorum', fact_type: 'trivia_wins', value: '9', updated_at: ago(400 * D) },
      { user_id: 'u-viejo', channel: 'parlusorum', fact_type: 'is_regular', value: 'true', updated_at: ago(400 * D) },
      { user_id: 'u-medio', channel: 'parlusorum', fact_type: 'trivia_wins', value: '4', updated_at: ago(120 * D) },
      { user_id: 'u-medio', channel: 'parlusorum', fact_type: 'is_regular', value: 'true', updated_at: ago(120 * D) },
      { user_id: 'u-activo', channel: 'parlusorum', fact_type: 'is_regular', value: 'true', updated_at: ago(10 * D) },
      { user_id: 'u-activo', channel: 'parlusorum', fact_type: 'trivia_wins', value: '2', updated_at: ago(10 * D) },
    ],
    cooldowns: [
      { key: 'a', expires_at: ago(H) },
      { key: 'b', expires_at: new Date(NOW + H).toISOString() },
    ],
  });
  supabase.setClientForTests(fake);
});

describe('caducidad de datos', () => {
  test('chat_log: borra lo de más de 24 h y conserva lo reciente', async () => {
    const r = await runRetention({ now: NOW });
    assert.equal(r.chat, 1);
    assert.deepEqual(
      fake.rows('chat_log').map((x) => x.id),
      [2],
    );
  });

  test('quality_log: 30 días', async () => {
    await runRetention({ now: NOW });
    assert.deepEqual(
      fake.rows('quality_log').map((x) => x.id),
      [2],
    );
  });

  test('usuarios: contadores caducan al año; hechos de texto a los 90 días', async () => {
    const r = await runRetention({ now: NOW });
    assert.deepEqual(
      fake
        .rows('users')
        .map((x) => x.user_id)
        .sort(),
      ['u-activo', 'u-medio'],
    );
    const facts = fake
      .rows('user_facts')
      .map((f) => `${f.user_id}/${f.fact_type}`)
      .sort();
    // u-viejo desaparece entero; u-medio conserva su contador (<1 año) pero pierde el hecho de texto (>90 d)
    assert.deepEqual(facts, ['u-activo/is_regular', 'u-activo/trivia_wins', 'u-medio/trivia_wins']);
    assert.equal(r.users, 1);
  });

  test('cooldowns: solo los caducados', async () => {
    await runRetention({ now: NOW });
    assert.deepEqual(
      fake.rows('cooldowns').map((x) => x.key),
      ['b'],
    );
  });

  test('el registro de calidad se genera antes de borrar el chat', async () => {
    const order = [];
    await runRetention({
      now: NOW,
      beforeChatPurge: async () => {
        order.push('calidad');
        assert.equal(fake.rows('chat_log').length, 2);
      },
    });
    order.push('hecho');
    assert.deepEqual(order, ['calidad', 'hecho']);
    assert.equal(fake.rows('chat_log').length, 1);
  });

  test('si el registro de calidad falla, el chat de 25 h aún se conserva (margen hasta 48 h)', async () => {
    const r = await runRetention({
      now: NOW,
      beforeChatPurge: async () => {
        throw new Error('fallo');
      },
    });
    assert.equal(fake.rows('chat_log').length, 2);
    assert.match(r.errors[0], /registro de calidad/);
  });

  test('un fallo en un paso no impide los demás', async () => {
    const db = {
      ...supabase,
      deleteQualityLogBefore: async () => {
        throw new Error('caído');
      },
    };
    const r = await runRetention({ now: NOW, db });
    assert.equal(r.chat, 1);
    assert.equal(r.users, 1);
    assert.equal(r.errors.length, 1);
  });
});
