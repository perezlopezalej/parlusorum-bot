const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildRow, formatLine, formatChat, dayRange, retentionCutoff, runWithOrigin, noteAiCall, noteTool, currentMeta } = require('../src/utils/chatlog');
const { pushChatLog, takeChatLog, requeueChatLog, getChatLogSize } = require('../src/utils/state');

const at = new Date(2026, 9, 28, 21, 5, 9); // hora local

describe('buildRow', () => {
  test('mensaje de usuario: sin datos de bot', () => {
    const r = buildRow({ username: 'ana', message: 'hola', origin: 'cohost', model: 'x', usedTool: true, latencyMs: 5, sessionId: 7, at });
    assert.equal(r.is_bot, false);
    assert.equal(r.origin, null);
    assert.equal(r.model, null);
    assert.equal(r.used_buscar_juego, false);
    assert.equal(r.latency_ms, null);
    assert.equal(r.session_id, 7);
  });

  test('mensaje del bot: origen, modelo, herramienta y latencia', () => {
    const r = buildRow({ username: 'dios_fua', message: 'fua', isBot: true, origin: 'dios_fua', model: 'm', usedTool: true, latencyMs: 812.6, at });
    assert.equal(r.origin, 'dios_fua');
    assert.equal(r.model, 'm');
    assert.equal(r.used_buscar_juego, true);
    assert.equal(r.latency_ms, 813);
    assert.equal(r.created_at, at.toISOString());
  });

  test('bot sin origen → "otro"; sesión ausente → null; mensaje largo se recorta', () => {
    const r = buildRow({ username: 'b', message: 'x'.repeat(900), isBot: true, at });
    assert.equal(r.origin, 'otro');
    assert.equal(r.session_id, null);
    assert.equal(r.message.length, 500);
    assert.equal(r.latency_ms, null);
  });
});

describe('formato de exportación', () => {
  test('usuario y bot con origen entre corchetes', () => {
    assert.equal(formatLine({ created_at: at.toISOString(), username: 'ana', message: 'hola', is_bot: false }), '21:05:09 ana: hola');
    assert.equal(formatLine({ created_at: at.toISOString(), username: 'dios_fua', message: 'fua', is_bot: true, origin: 'cohost' }), '21:05:09 dios_fua [cohost]: fua');
  });

  test('saltos de línea aplanados y fichero terminado en salto', () => {
    const out = formatChat([{ created_at: at.toISOString(), username: 'a', message: 'l1\nl2', is_bot: false }]);
    assert.equal(out, '21:05:09 a: l1 l2\n');
    assert.equal(formatChat([]), '');
  });
});

describe('fechas', () => {
  test('dayRange: empieza a medianoche local y termina a la del día siguiente', () => {
    const r = dayRange('2026-10-28');
    const from = new Date(r.from);
    const to = new Date(r.to);
    assert.deepEqual([from.getDate(), from.getHours(), from.getMinutes()], [28, 0, 0]);
    assert.deepEqual([to.getDate(), to.getHours(), to.getMinutes()], [29, 0, 0]);
  });

  test('dayRange rechaza fechas inválidas', () => {
    for (const bad of ['', null, '28-10-2026', '2026-02-30', '2026-13-01', 'hoy']) assert.equal(dayRange(bad), null, String(bad));
  });

  test('retentionCutoff: 60 días por defecto', () => {
    const now = Date.UTC(2026, 9, 28);
    assert.equal(retentionCutoff(now), '2026-08-29T00:00:00.000Z');
    assert.equal(retentionCutoff(now, 1), '2026-10-27T00:00:00.000Z');
  });
});

describe('contexto de origen', () => {
  test('hereda origen, modelo y latencia acumulada dentro del contexto', async () => {
    await runWithOrigin('dios_fua', async () => {
      noteAiCall('m1', 100);
      await new Promise(r => setTimeout(r, 1));
      noteAiCall('m2', 50);
      noteTool('buscar_juego');
      assert.deepEqual(currentMeta(), { origin: 'dios_fua', model: 'm2', usedTool: true, latencyMs: 150 });
    });
  });

  test('lo explícito gana; sin contexto → "otro" sin latencia', () => {
    assert.deepEqual(currentMeta(), { origin: 'otro', model: null, usedTool: false, latencyMs: null });
    runWithOrigin('trivia', () => assert.equal(currentMeta({ origin: 'hook' }).origin, 'hook'));
  });

  test('contextos independientes entre sí', () => {
    runWithOrigin('a', () => noteAiCall('x', 10));
    runWithOrigin('b', () => assert.equal(currentMeta().latencyMs, null));
  });
});

describe('cola en memoria', () => {
  test('lotes en orden, reencolado al principio y tope', () => {
    takeChatLog(10_000);
    for (let i = 0; i < 5; i++) pushChatLog({ i });
    const batch = takeChatLog(3);
    assert.deepEqual(batch.map(r => r.i), [0, 1, 2]);
    requeueChatLog(batch);
    assert.deepEqual(takeChatLog(10).map(r => r.i), [0, 1, 2, 3, 4]);
    for (let i = 0; i < 1100; i++) pushChatLog({ i });
    assert.equal(getChatLogSize(), 1000);
    assert.equal(takeChatLog(1)[0].i, 100, 'se descartan los más antiguos');
    takeChatLog(10_000);
  });
});
