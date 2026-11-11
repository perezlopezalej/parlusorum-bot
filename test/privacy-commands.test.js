process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.BOT_USERNAME = 'dios_fua';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cmds = require('../src/privacy/commands');

const say = [];
const client = { say: (ch, msg) => say.push(msg) };
const tags = (over = {}) => ({ 'display-name': 'Ana_Pro', username: 'ana_pro', 'user-id': 'A1', ...over });
let calls;
const okForget = async args => { calls.push(args); return { ok: true, counts: {}, errors: [], ids: [args.userId] }; };
const failForget = async args => { calls.push(args); return { ok: false, counts: {}, errors: ['quality_log: boom'], ids: [] }; };

beforeEach(() => {
  say.length = 0;
  calls = [];
  cmds._cooldowns.clear();
});

describe('!fua_olvidame', () => {
  test('borra los datos del autor (por su user_id y login) y confirma en el chat', async () => {
    await cmds.handleForgetMe(client, '#c', tags(), { forget: okForget });
    assert.deepEqual(calls, [{ userId: 'A1', login: 'ana_pro' }]);
    assert.match(say[0], /@Ana_Pro listo: he borrado todos tus datos/);
    assert.ok(say[0].length <= 500);
  });

  test('si falla, no dice que está hecho', async () => {
    await cmds.handleForgetMe(client, '#c', tags(), { forget: failForget });
    assert.match(say[0], /no he podido borrar todo/);
    assert.doesNotMatch(say[0], /listo/);
  });

  test('si el borrado lanza una excepción, responde con error y no revienta', async () => {
    await cmds.handleForgetMe(client, '#c', tags(), { forget: async () => { throw new Error('caído'); } });
    assert.match(say[0], /no he podido borrar todo/);
  });

  test('cooldown de 1 minuto por usuario; otro usuario no se ve afectado', async () => {
    const now = 1_000_000;
    await cmds.handleForgetMe(client, '#c', tags(), { forget: okForget, now });
    await cmds.handleForgetMe(client, '#c', tags(), { forget: okForget, now: now + 10_000 });
    assert.equal(calls.length, 1);
    assert.match(say[1], /espera un momento/);
    await cmds.handleForgetMe(client, '#c', tags({ 'display-name': 'Bob', username: 'bob', 'user-id': 'B2' }), { forget: okForget, now: now + 10_000 });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].userId, 'B2');
    await cmds.handleForgetMe(client, '#c', tags(), { forget: okForget, now: now + 61_000 });
    assert.equal(calls.length, 3);
  });
});

describe('!fua_olvidar @usuario', () => {
  const resolveId = async login => ({ bob_xx: 'B2' }[login] || null);

  test('un no mod no puede, y no se borra nada', async () => {
    await cmds.handleForgetUser(client, '#c', tags(), ['fua_olvidar', '@bob_xx'], false, { forget: okForget, resolveId });
    assert.equal(calls.length, 0);
    assert.match(say[0], /solo mods/);
  });

  test('un mod borra al usuario indicado (con @ y mayúsculas) usando su user_id', async () => {
    await cmds.handleForgetUser(client, '#c', tags(), ['fua_olvidar', '@Bob_XX'], true, { forget: okForget, resolveId });
    assert.deepEqual(calls, [{ userId: 'B2', login: 'bob_xx' }]);
    assert.match(say[0], /he borrado todos los datos de @bob_xx/);
  });

  test('si no se resuelve el id, borra igualmente por nick', async () => {
    await cmds.handleForgetUser(client, '#c', tags(), ['fua_olvidar', 'desconocido'], true, { forget: okForget, resolveId });
    assert.deepEqual(calls, [{ userId: null, login: 'desconocido' }]);
  });

  test('sin argumento o con uno no válido muestra el uso', async () => {
    for (const arg of [undefined, '', '@', 'a b', '@@@@', 'x'.repeat(30)]) {
      say.length = 0;
      await cmds.handleForgetUser(client, '#c', tags({ 'user-id': 'M' + String(arg) }), ['fua_olvidar', arg], true, { forget: okForget, resolveId });
      assert.match(say[0], /uso: !fua_olvidar @usuario/, String(arg));
    }
    assert.equal(calls.length, 0);
  });

  test('no se pueden borrar el bot ni el streamer', async () => {
    for (const target of ['dios_fua', '@DIOS_FUA', 'parlusorum']) {
      await cmds.handleForgetUser(client, '#c', tags({ 'user-id': 'M' + target }), ['fua_olvidar', target], true, { forget: okForget, resolveId });
    }
    assert.equal(calls.length, 0);
    assert.ok(say.every(m => /no puedo borrar los datos de esa cuenta/.test(m)));
  });

  test('si el borrado falla, avisa sin decir que está hecho', async () => {
    await cmds.handleForgetUser(client, '#c', tags(), ['fua_olvidar', 'bob_xx'], true, { forget: failForget, resolveId });
    assert.match(say[0], /no he podido borrar todo/);
  });
});

describe('!privacidad', () => {
  test('resumen corto con retención, proveedor y cómo borrar; cooldown global', () => {
    cmds.handlePrivacy(client, '#c', tags(), { now: 5_000_000 });
    cmds.handlePrivacy(client, '#c', tags({ 'display-name': 'Otro' }), { now: 5_001_000 });
    assert.equal(say.length, 1);
    assert.match(say[0], /24 h/);
    assert.match(say[0], /Groq/);
    assert.match(say[0], /!fua_olvidame/);
    assert.ok(say[0].length <= 500);
  });
});

describe('aviso de privacidad', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'aviso-privacidad.md'), 'utf8');

  test('el texto del panel cabe en 300 caracteres y menciona lo esencial', () => {
    const panel = /```\n([\s\S]*?)\n```/.exec(doc)[1];
    assert.ok(panel.length <= 300, `mide ${panel.length}`);
    for (const word of ['24 h', '30 días', 'Groq', 'interés legítimo', '!fua_olvidame', '!privacidad']) assert.ok(panel.includes(word), word);
  });

  test('el aviso dice qué proveedor, base legal, retención y cómo borrar', () => {
    for (const word of ['Groq (EE. UU.)', 'Zero Data Retention', 'Interés legítimo', '24 horas', '30 días', '!fua_olvidame', '!fua_olvidar']) assert.ok(doc.includes(word), word);
  });
});
