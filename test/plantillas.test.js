const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { template, pickIndex, fill, TEMPLATES } = require('../src/utils/plantillas');
const { checkOutbound } = require('../src/utils/output-guard');

const VARS = {
  username: 'ana',
  token: 'Kappa',
  title: '¿Gana Manu?',
  options: '1) Sí | 2) No',
  winner: 'Sí',
  winners: '¡3 acertaron!',
  pct: 61,
  votes: 40,
  game: 'X',
};

describe('plantillas fijas', () => {
  test('todas las claves esperadas existen con varias variantes', () => {
    for (const k of [
      'lurk',
      'highlight_marker',
      'highlight',
      'emote_spam',
      'caps_rage',
      'prediction_begin',
      'prediction_lock',
      'prediction_end',
      'poll_begin',
      'poll_end',
      'poll_end_close',
    ]) {
      assert.ok(Array.isArray(TEMPLATES[k]) && TEMPLATES[k].length >= 3, k);
    }
  });
  test('ninguna variante deja marcadores sin sustituir ni pasa de 300 caracteres', () => {
    for (const [k, list] of Object.entries(TEMPLATES)) {
      if (k.startsWith('_')) continue;
      for (const t of list) {
        const out = fill(t, VARS);
        assert.doesNotMatch(out, /[{}]/, `${k}: ${t}`);
        assert.ok(out.length <= 300, `${k} mide ${out.length}`);
      }
    }
  });
  test('todas pasan el filtro de salida', () => {
    for (const [k, list] of Object.entries(TEMPLATES)) {
      if (k.startsWith('_')) continue;
      for (const t of list) assert.equal(checkOutbound(fill(t, VARS), { origin: 'otro' }).ok, true, `${k}: ${t}`);
    }
  });
  test('nunca repite la variante anterior, aunque el azar sea el peor', () => {
    let last = null;
    for (let i = 0; i < 200; i++) {
      const rng = () => (i % 2 ? 0.9999 : 0);
      const out = template('lurk', { username: 'ana' }, { rng });
      assert.notEqual(out, last);
      last = out;
    }
  });
  test('pickIndex cubre todas las demás posiciones y evita la última', () => {
    const seen = new Set();
    for (let r = 0; r < 1; r += 0.01) seen.add(pickIndex(5, 2, () => r));
    assert.deepEqual([...seen].sort(), [0, 1, 3, 4]);
    assert.equal(pickIndex(1, 0), 0);
  });
  test('clave desconocida lanza error y el hueco de un marcador vacío no deja espacios raros', () => {
    assert.throws(() => template('nope'));
    assert.equal(fill('A {x} B', { x: '' }), 'A B');
    assert.equal(fill('¡Ganó "S"! {winners} 🎉', { winners: '' }), '¡Ganó "S"! 🎉');
  });
});
