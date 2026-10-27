const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickOpenSession } = require('../src/utils/supabase');

const T = Date.parse('2026-10-27T18:00:00Z');
const row = (id, startedAt, ended = null) => ({ id, started_at: startedAt, ended_at: ended, death_count: id });

describe('recuperar sesión abierta', () => {
  test('elige la abierta más reciente que encaja con el inicio del stream', () => {
    const rows = [row(1, '2026-10-27T17:58:00Z'), row(2, '2026-10-27T18:01:00Z'), row(3, '2026-10-26T20:00:00Z')];
    assert.equal(pickOpenSession(rows, T).id, 2);
  });

  test('ignora sesiones cerradas y sesiones de streams anteriores', () => {
    const rows = [row(1, '2026-10-27T18:00:00Z', '2026-10-27T19:00:00Z'), row(2, '2026-10-26T20:00:00Z')];
    assert.equal(pickOpenSession(rows, T), null);
  });

  test('sin hora de inicio o sin filas devuelve null', () => {
    assert.equal(pickOpenSession([row(1, '2026-10-27T18:00:00Z')], null), null);
    assert.equal(pickOpenSession(undefined, T), null);
  });
});
