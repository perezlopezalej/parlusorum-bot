process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const supabase = require('../src/utils/supabase');
const ql = require('../src/privacy/quality-log');
const { chooseExport } = require('../src/utils/chatlog');

const SECRET = 'secreto-de-pruebas';
const EXCL = new Set(['dios_fua', 'parlusorum']);
const T0 = Date.parse('2026-11-10T20:00:00Z');
let n = 0;
const at = (s) => new Date(T0 + s * 1000).toISOString();
const user = (s, username, message, extra = {}) => ({
  id: ++n,
  created_at: at(s),
  username,
  user_id: 'id-' + username,
  message,
  is_bot: false,
  session_id: 7,
  ...extra,
});
const bot = (s, message, extra = {}) => ({
  id: ++n,
  created_at: at(s),
  username: 'dios_fua',
  message,
  is_bot: true,
  origin: 'cohost',
  model: 'm',
  latency_ms: 300,
  session_id: 7,
  ...extra,
});

// 20 líneas de chat con dos mensajes del bot lejanos entre sí y otro cercano
function sampleChat() {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(user(i, i % 2 ? 'ana_pro' : 'bob_xx', `línea ${i}`));
  rows.push(bot(10, '@ana_pro menudo clutch, ana_pro'));
  rows.push(user(11, 'ana_pro', 'jajaja', { reply_parent_login: 'dios_fua' }));
  rows.push(user(12, 'carla', 'dios_fua qué bueno'));
  for (let i = 13; i < 30; i++) rows.push(user(i, 'bob_xx', `relleno ${i}`));
  rows.push(bot(40, 'otro comentario'));
  rows.push(user(41, 'carla', 'ok'));
  return rows;
}

describe('registro de calidad: construcción', () => {
  test('una entrada por ventana: ±3 líneas de contexto, y ventanas separadas no se mezclan', () => {
    const { entries } = ql.buildQualityLog(sampleChat(), { secret: SECRET, exclude: EXCL });
    assert.equal(entries.length, 2);
    const lines = entries[0].payload.lines;
    assert.equal(lines.filter((l) => l.who === 'bot').length, 1);
    const i = lines.findIndex((l) => l.who === 'bot');
    assert.equal(i, 3, '3 líneas antes');
    assert.equal(lines.length - i - 1, 3, '3 líneas después');
  });

  test('ventanas que se solapan se fusionan', () => {
    const rows = [user(0, 'ana_pro', 'a'), bot(1, 'x'), user(2, 'bob_xx', 'b'), bot(3, 'y'), user(4, 'ana_pro', 'c')];
    const { entries } = ql.buildQualityLog(rows, { secret: SECRET, exclude: EXCL });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.lines.length, 5);
  });

  test('seudónimos consistentes: mismo nick → mismo usuarioN en todo el stream, también en @menciones y texto', () => {
    const { entries } = ql.buildQualityLog(sampleChat(), { secret: SECRET, exclude: EXCL });
    const all = entries.flatMap((e) => e.payload.lines);
    const ana = all.find((l) => l.text === 'jajaja').who;
    assert.match(ana, /^usuario\d+$/);
    const botLine = all.find((l) => l.text.includes('menudo clutch'));
    assert.equal(botLine.text, `@${ana} menudo clutch, ${ana}`);
    assert.ok(all.filter((l) => l.who === ana).length >= 2);
    // el bot y los nombres excluidos no se tocan
    assert.ok(all.some((l) => l.who === 'bot'));
    assert.ok(all.some((l) => l.text === 'dios_fua qué bueno'));
  });

  test('el resultado no contiene ningún nick ni user_id reales', () => {
    const built = ql.buildQualityLog(sampleChat(), {
      secret: SECRET,
      exclude: EXCL,
      report: 'ana_pro y carla cayeron bien',
      metrics: { tokens: {} },
    });
    const json = JSON.stringify([built.entries.map((e) => e.payload), built.summary.payload]);
    for (const nick of ['ana_pro', 'bob_xx', 'carla', 'id-ana_pro', 'id-bob_xx', 'id-carla']) {
      assert.equal(json.includes(nick), false, `aparece ${nick}`);
    }
  });

  test('user_keys: hashes estables de los participantes de la entrada, sin el id en claro', () => {
    const { entries } = ql.buildQualityLog(sampleChat(), { secret: SECRET, exclude: EXCL });
    const keys = entries[0].user_keys;
    assert.ok(keys.includes(ql.userKey({ userId: 'id-ana_pro' }, SECRET)));
    assert.ok(keys.includes(ql.userKey({ userId: 'id-carla' }, SECRET)));
    assert.ok(keys.every((k) => /^[0-9a-f]{32}$/.test(k)));
    assert.equal(ql.userKey({ userId: 'id-ana_pro' }, SECRET), ql.userKey({ userId: 'id-ana_pro' }, SECRET));
    assert.notEqual(ql.userKey({ userId: 'id-ana_pro' }, SECRET), ql.userKey({ userId: 'id-ana_pro' }, 'otro'));
  });

  test('sin user_id (filas antiguas) la clave sale del nick, y userKeysFor cubre ambas', () => {
    const rows = [user(0, 'vieja', 'hola', { user_id: null }), bot(1, 'x')];
    const { entries } = ql.buildQualityLog(rows, { secret: SECRET, exclude: EXCL });
    assert.deepEqual(entries[0].user_keys, [ql.userKey({ username: 'VIEJA' }, SECRET)]);
    assert.deepEqual(
      ql.userKeysFor({ userId: '5', login: 'Vieja' }, SECRET).sort(),
      [ql.userKey({ userId: '5' }, SECRET), ql.userKey({ username: 'vieja' }, SECRET)].sort(),
    );
  });

  test('el bot lleva origen, modelo, latencia y reacción; el resumen lleva métricas y cifras', () => {
    const { entries, summary } = ql.buildQualityLog(sampleChat(), {
      secret: SECRET,
      exclude: EXCL,
      metrics: { tokens: { m: { total: 10 } } },
    });
    const b = entries[0].payload.lines.find((l) => l.who === 'bot');
    assert.equal(b.origin, 'cohost');
    assert.equal(b.model, 'm');
    assert.equal(b.latency_ms, 300);
    assert.ok(b.reaction && typeof b.reaction.reactors === 'number');
    assert.equal(summary.payload.bot_messages, 2);
    assert.equal(summary.payload.speakers, 3);
    assert.deepEqual(summary.payload.metrics, { tokens: { m: { total: 10 } } });
    assert.equal(summary.payload.reactions.total, 2);
    assert.deepEqual(summary.user_keys, []);
  });

  test('sin mensajes del bot no hay entradas, solo el resumen', () => {
    const { entries, summary } = ql.buildQualityLog([user(0, 'ana_pro', 'hola')], { secret: SECRET, exclude: EXCL });
    assert.equal(entries.length, 0);
    assert.equal(summary.payload.bot_messages, 0);
  });

  test('formatQualityLog produce texto legible', () => {
    const built = ql.buildQualityLog(sampleChat(), { secret: SECRET, exclude: EXCL });
    const rows = [...built.entries.map((e) => ({ kind: 'entry', ...e })), { kind: 'summary', ...built.summary }];
    const text = ql.formatQualityLog(rows);
    assert.match(text, /RESUMEN DEL STREAM/);
    assert.match(text, /--- entrada 1 ---/);
    assert.match(text, /bot \[cohost m\]/);
  });
});

describe('registro de calidad: persistencia y recuperación', () => {
  let fake;
  beforeEach(() => {
    fake = createFakeSupabase({ chat_log: sampleChat().map(({ id, ...r }) => ({ id, ...r })), quality_log: [] });
    supabase.setClientForTests(fake);
  });

  test('persistStream guarda entradas y un resumen', async () => {
    const saved = await ql.persistStream({
      sessionId: 7,
      rows: fake.rows('chat_log'),
      db: supabase,
      botName: 'dios_fua',
    });
    assert.equal(saved, 3);
    assert.deepEqual(
      fake
        .rows('quality_log')
        .map((r) => r.kind)
        .sort(),
      ['entry', 'entry', 'summary'],
    );
    assert.equal(fake.rows('quality_log')[0].stream_date, '2026-11-10');
  });

  test('catchUp genera el registro de sesiones antiguas sin resumen, y solo una vez', async () => {
    const now = T0 + 20 * 3600_000; // el chat tiene 20 h
    assert.equal(await ql.catchUp({ now, db: supabase }), 1);
    assert.equal(fake.rows('quality_log').filter((r) => r.kind === 'summary').length, 1);
    assert.equal(await ql.catchUp({ now, db: supabase }), 0);
  });

  test('catchUp no toca chat reciente (aún no está a punto de caducar)', async () => {
    assert.equal(await ql.catchUp({ now: T0 + 3600_000, db: supabase }), 0);
    assert.equal(fake.rows('quality_log').length, 0);
  });
});

describe('npm run chatlog: chat completo o registro de calidad', () => {
  const now = new Date(2026, 10, 11, 15).getTime();
  test('con fecha: dentro de 24 h → chat; antes → calidad', () => {
    assert.equal(chooseExport({ dateStr: '2026-11-11', now }), 'chat');
    assert.equal(chooseExport({ dateStr: '2026-11-10', now }), 'chat');
    assert.equal(chooseExport({ dateStr: '2026-11-09', now }), 'quality');
  });

  test('sin fecha: según cuándo empezó la última sesión (límite exacto de 24 h → calidad)', () => {
    assert.equal(chooseExport({ startedAt: new Date(now - 23 * 3600_000).toISOString(), now }), 'chat');
    assert.equal(chooseExport({ startedAt: new Date(now - 24 * 3600_000).toISOString(), now }), 'quality');
    assert.equal(chooseExport({ startedAt: 'basura', now }), 'quality');
  });
});
