process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-1234';

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const supabase = require('../src/utils/supabase');
const state = require('../src/utils/state');
const { forgetUser } = require('../src/privacy/forget');
const { userKey } = require('../src/privacy/quality-log');

// Tres usuarios: A (el que se olvida), B (otro cualquiera) y C («anaxpro», casi igual que «ana_pro» salvo el «_»)
const A = { id: 'A1', login: 'ana_pro', display: 'Ana_Pro' };
const B = { id: 'B2', login: 'bob_xx', display: 'Bob_xx' };
const C = { id: 'C3', login: 'anaxpro', display: 'AnaXPro' };
const iso = '2026-11-10T20:00:00.000Z';
const key = id => userKey({ userId: id });
const keyNick = login => userKey({ username: login });

function seed() {
  return {
    chat_log: [
      { id: 1, created_at: iso, user_id: A.id, username: A.display, message: 'hola', is_bot: false, reply_parent_login: null },
      { id: 2, created_at: iso, user_id: null, username: 'ana_pro', message: 'fila antigua sin id', is_bot: false, reply_parent_login: null },
      { id: 3, created_at: iso, user_id: B.id, username: B.display, message: 'adiós', is_bot: false, reply_parent_login: null },
      { id: 4, created_at: iso, user_id: B.id, username: B.display, message: 'respondo a ana', is_bot: false, reply_parent_login: 'ana_pro' },
      { id: 5, created_at: iso, user_id: C.id, username: C.display, message: 'soy otro', is_bot: false, reply_parent_login: null },
      { id: 6, created_at: iso, user_id: null, username: 'dios_fua', message: 'fua', is_bot: true, reply_parent_login: null },
    ],
    quality_log: [
      { id: 1, kind: 'entry', session_id: 1, stream_date: '2026-11-10', payload: { n: 'solo A' }, user_keys: [key(A.id)] },
      { id: 2, kind: 'entry', session_id: 1, stream_date: '2026-11-10', payload: { n: 'solo B' }, user_keys: [key(B.id)] },
      { id: 3, kind: 'entry', session_id: 1, stream_date: '2026-11-10', payload: { n: 'A y B' }, user_keys: [key(A.id), key(B.id)] },
      { id: 4, kind: 'entry', session_id: 1, stream_date: '2026-11-10', payload: { n: 'A sin id' }, user_keys: [keyNick(A.login)] },
      { id: 5, kind: 'entry', session_id: 1, stream_date: '2026-11-10', payload: { n: 'solo C' }, user_keys: [key(C.id)] },
      { id: 6, kind: 'summary', session_id: 1, stream_date: '2026-11-10', payload: { chat_messages: 9 }, user_keys: [] },
    ],
    users: [
      { user_id: A.id, username: A.display, last_seen: iso, message_count: 10 },
      { user_id: B.id, username: B.display, last_seen: iso, message_count: 20 },
      { user_id: C.id, username: C.display, last_seen: iso, message_count: 30 },
    ],
    user_facts: [
      { user_id: A.id, channel: 'parlusorum', fact_type: 'trivia_wins', value: '5', updated_at: iso },
      { user_id: A.id, channel: 'parlusorum', fact_type: 'is_regular', value: 'true', updated_at: iso },
      { user_id: B.id, channel: 'parlusorum', fact_type: 'trivia_wins', value: '7', updated_at: iso },
      { user_id: C.id, channel: 'parlusorum', fact_type: 'is_regular', value: 'true', updated_at: iso },
      { user_id: null, username: 'ana_pro', channel: 'parlusorum', fact_type: 'recurring_joke', value: 'frase antigua', updated_at: iso },
      { user_id: null, username: 'bob_xx', channel: 'parlusorum', fact_type: 'recurring_joke', value: 'otra antigua', updated_at: iso },
    ],
    stream_memory: [
      { id: 1, summary: 'ana_pro hizo un clutch y bob_xx lo celebró', highlights: ['el clutch de @Ana_Pro', 'risas'], recurring_phrases: ['fua'], active_users: ['ana_pro', 'bob_xx'] },
      { id: 2, summary: 'stream tranquilo', highlights: [], recurring_phrases: [], active_users: ['bob_xx'] },
    ],
    bot_self_reviews: [
      { id: 1, report: 'ana_pro se quejó; bob_xx no' },
    ],
    channel_lore: [
      { id: 1, channel: 'parlusorum', term: 'el gran pollo', term_key: 'el gran pollo', status: 'active', users: [A.id, B.id, C.id], users_count: 3 },
      { id: 2, channel: 'parlusorum', term: 'Ana Pro es crack', term_key: 'ana pro es crack', status: 'pending', users: [B.id], users_count: 1 },
      { id: 3, channel: 'parlusorum', term: 'banana pro', term_key: 'banana pro', status: 'active', users: [B.id], users_count: 1 },
      { id: 4, channel: 'parlusorum', term: 'viejo', term_key: 'viejo', status: 'pending', users: ['ana_pro', 'bob_xx'], users_count: 2 },
    ],
    cooldowns: [
      { key: `lurk-${A.id}`, expires_at: iso },
      { key: `chiste-${A.id}`, expires_at: iso },
      { key: `lurk-${B.id}`, expires_at: iso },
      { key: 'x-ana_pro', expires_at: iso },
      { key: 'x-anaxpro', expires_at: iso },
    ],
  };
}

const noMemory = { clear: () => 0 };
const snapshot = (fake, table, pick) => JSON.stringify(fake.rows(table).filter(pick));
let fake;
let before;

beforeEach(() => {
  fake = createFakeSupabase(seed());
  supabase.setClientForTests(fake);
  before = createFakeSupabase(seed()); // copia pristina para comparar lo ajeno
});

describe('forgetUser: borra todo lo de ese usuario y nada de otros', () => {
  test('no queda ninguna fila de A en ninguna tabla', async () => {
    const res = await forgetUser({ userId: A.id, login: A.login, memory: noMemory });
    assert.equal(res.ok, true, res.errors.join(';'));

    assert.equal(fake.rows('chat_log').some(r => r.user_id === A.id || String(r.username).toLowerCase() === 'ana_pro'), false, 'chat_log');
    assert.equal(fake.rows('chat_log').some(r => r.reply_parent_login === 'ana_pro'), false, 'respuestas a A');
    assert.deepEqual(fake.rows('quality_log').map(r => r.id), [2, 5, 6], 'quality_log: entradas de A (con id, con nick y compartidas) fuera');
    assert.equal(fake.rows('users').some(r => r.user_id === A.id), false, 'users');
    assert.equal(fake.rows('user_facts').some(r => r.user_id === A.id || r.username === 'ana_pro'), false, 'user_facts');
    assert.equal(fake.rows('cooldowns').some(r => /A1$|ana_pro$/.test(r.key)), false, 'cooldowns');

    const mem = fake.rows('stream_memory');
    assert.equal(JSON.stringify(mem).toLowerCase().includes('ana_pro'), false, 'stream_memory sin su nick');
    assert.equal(mem[0].summary, 'un espectador hizo un clutch y bob_xx lo celebró');
    assert.deepEqual(mem[0].active_users, ['bob_xx']);
    assert.equal(JSON.stringify(fake.rows('bot_self_reviews')).includes('ana_pro'), false, 'informes');

    const lore = fake.rows('channel_lore');
    assert.equal(lore.some(r => r.id === 2), false, 'lore que lo menciona, borrado');
    assert.deepEqual(lore.find(r => r.id === 1).users, [B.id, C.id]);
    assert.equal(lore.find(r => r.id === 1).users_count, 2);
    assert.deepEqual(lore.find(r => r.id === 4).users, ['bob_xx'], 'nick antiguo en users de lore');
  });

  test('todo lo de B y de C queda intacto', async () => {
    await forgetUser({ userId: A.id, login: A.login, memory: noMemory });
    const keep = (table, pick) => assert.equal(snapshot(fake, table, pick), snapshot(before, table, pick), table);
    keep('chat_log', r => r.id === 3);
    keep('chat_log', r => r.user_id === C.id);
    keep('chat_log', r => r.is_bot);
    keep('quality_log', r => r.id === 2 || r.id === 5 || r.id === 6);
    keep('users', r => r.user_id !== A.id);
    keep('user_facts', r => r.user_id === B.id || r.user_id === C.id || r.username === 'bob_xx');
    keep('cooldowns', r => r.key === `lurk-${B.id}` || r.key === 'x-anaxpro');
    keep('channel_lore', r => r.id === 3);
    assert.equal(fake.rows('stream_memory')[1].summary, 'stream tranquilo');
    // la fila de B que respondía a A se conserva (solo se anula el login de A)
    const reply = fake.rows('chat_log').find(r => r.id === 4);
    assert.equal(reply.message, 'respondo a ana');
    assert.equal(reply.reply_parent_login, null);
  });

  test('«ana_pro» no borra a «anaxpro»: los comodines de LIKE van escapados', async () => {
    await forgetUser({ userId: A.id, login: A.login, memory: noMemory });
    assert.ok(fake.rows('users').some(r => r.user_id === C.id));
    assert.ok(fake.rows('chat_log').some(r => r.user_id === C.id));
    assert.ok(fake.rows('cooldowns').some(r => r.key === 'x-anaxpro'));
    assert.ok(fake.rows('quality_log').some(r => r.id === 5));
  });

  test('«ana» como subcadena de «banana» no borra el lore de otros términos', async () => {
    const f = createFakeSupabase({ channel_lore: [{ id: 1, channel: 'x', term: 'banana split', term_key: 'banana split', status: 'active', users: [], users_count: 0 }], users: [{ user_id: '9', username: 'ana' }] });
    supabase.setClientForTests(f);
    await forgetUser({ userId: '9', login: 'ana', memory: noMemory });
    assert.equal(f.rows('channel_lore').length, 1);
  });

  test('solo con el nick (sin user_id) lo resuelve en users y borra igual', async () => {
    const res = await forgetUser({ login: 'ANA_PRO', memory: noMemory });
    assert.equal(res.ok, true);
    assert.deepEqual(res.ids, [A.id]);
    assert.equal(fake.rows('users').some(r => r.user_id === A.id), false);
    assert.equal(fake.rows('quality_log').some(r => r.id === 1), false);
  });

  test('es idempotente: repetirlo no falla ni borra nada más', async () => {
    await forgetUser({ userId: A.id, login: A.login, memory: noMemory });
    const snap = JSON.stringify(fake.tables);
    const res = await forgetUser({ userId: A.id, login: A.login, memory: noMemory });
    assert.equal(res.ok, true);
    assert.equal(JSON.stringify(fake.tables), snap);
  });

  test('sin user_id ni nick no hace nada (nunca un delete sin filtro)', async () => {
    const snap = JSON.stringify(fake.tables);
    for (const args of [{}, { userId: '', login: '' }, { userId: null, login: '@' }]) {
      const res = await forgetUser({ ...args, memory: noMemory });
      assert.equal(res.ok, false);
    }
    assert.equal(JSON.stringify(fake.tables), snap);
  });

  test('si una tabla falla, el resto se borra igualmente y el resultado es ok:false', async () => {
    const client = { from: t => (t === 'quality_log'
      ? { delete: () => ({ contains: () => Promise.resolve({ error: { message: 'boom' } }) }) }
      : fake.from(t)) };
    const res = await forgetUser({ userId: A.id, login: A.login, memory: noMemory, db: { getClient: () => client } });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /quality_log: boom/);
    assert.equal(fake.rows('users').some(r => r.user_id === A.id), false, 'users sí se borró');
    assert.equal(fake.rows('chat_log').some(r => r.user_id === A.id), false, 'chat_log sí se borró');
    // reintento con la base ya sana: termina el trabajo
    const again = await forgetUser({ userId: A.id, login: A.login, memory: noMemory });
    assert.equal(again.ok, true);
    assert.equal(fake.rows('quality_log').some(r => r.id === 1), false);
  });

  test('una tabla inexistente (migración sin aplicar o ya retirada) no cuenta como error', async () => {
    const client = { from: t => (t === 'bot_self_reviews'
      ? { select: () => Promise.resolve({ error: { message: 'relation "public.bot_self_reviews" does not exist' } }) }
      : fake.from(t)) };
    const res = await forgetUser({ userId: A.id, login: A.login, memory: noMemory, db: { getClient: () => client } });
    assert.equal(res.ok, true);
  });

  test('--dry-run cuenta pero no borra', async () => {
    const snap = JSON.stringify(fake.tables);
    const res = await forgetUser({ userId: A.id, login: A.login, memory: noMemory, dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(JSON.stringify(fake.tables), snap);
    assert.equal(res.counts.users, 1);
    assert.equal(res.counts['chat_log (id)'], 1);
    assert.equal(res.counts.quality_log, 3);
    assert.equal(res.counts.channel_lore, 3);
  });
});

describe('forgetUser: memoria RAM', () => {
  test('la cola del registro de chat y la muestra de lore pierden solo lo de A', async () => {
    while (state.getChatLogSize()) state.takeChatLog(1000);
    state.pushChatLog({ user_id: A.id, username: A.display, message: 'a' });
    state.pushChatLog({ user_id: null, username: 'ana_pro', message: 'a sin id' });
    state.pushChatLog({ user_id: B.id, username: B.display, message: 'b' });
    state.resetLoreSample();
    state.addLoreSample(A.display, 'frase de A', A.id);
    state.addLoreSample(B.display, 'frase de B', B.id);

    await forgetUser({ userId: A.id, login: A.login });

    const left = state.takeChatLog(100);
    assert.deepEqual(left.map(r => r.message), ['b']);
    assert.equal(state.getLoreSample(), `${B.display}: frase de B`);
    state.resetLoreSample();
  });

  test('conversación, historial, caché de hechos y usuarios activos de A desaparecen; los de B no', async () => {
    const ai = require('../src/ai/handler');
    ai.addToHistory(A.display, 'mensaje de A', A.id);
    ai.addToHistory(B.display, 'mensaje de B', B.id);
    ai.addToUserConversation(A.id, 'user', 'pregunta de A');
    ai.addToUserConversation(B.id, 'user', 'pregunta de B');
    await ai.getCachedUserFacts(A.id);

    await forgetUser({ userId: A.id, login: A.login });

    assert.deepEqual(ai.getUserConversation(A.id), []);
    assert.equal(ai.getUserConversation(B.id).length, 1);
    assert.equal(ai.getRecentHistory(20).includes('mensaje de A'), false);
    assert.equal(ai.getRecentHistory(20).includes('mensaje de B'), true);
    assert.equal(ai.getActiveUsers().includes('ana_pro'), false);
    assert.equal(ai.getActiveUsers().includes('bob_xx'), true);
    assert.equal(state.wasRecentlyForgotten(A.id), true, 'aviso de 10 min para no saludarlo de nuevo');
    assert.equal(state.wasRecentlyForgotten(B.id), false);
    ai.resetActiveUsers();
  });

  test('un guardado diferido de users pendiente NO reescribe la fila después de olvidar', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await supabase.saveUser(A.id, { username: A.display, firstSeen: iso, lastSeen: iso, messageCount: 11, achievements: [] });
      await forgetUser({ userId: A.id, login: A.login });
      mock.timers.tick(5000);
      await new Promise(r => setImmediate(r));
      assert.equal(fake.rows('users').some(r => r.user_id === A.id), false);
    } finally {
      mock.timers.reset();
    }
  });
});
