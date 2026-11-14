// scripts/limpiar-memoria.js: el plan de limpieza de filas de stream_memory (puro, sin Supabase)
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { planCleanup, DEFAULT_IDS } = require('../scripts/limpiar-memoria');

const row = (id, session_id) => ({ id, session_id, stream_date: '2026-11-13', game: 'X', summary: 'inventado' });

describe('planCleanup', () => {
  test('por defecto son las filas 216-220', () => assert.deepEqual(DEFAULT_IDS, [216, 217, 218, 219, 220]));

  test('menos de 20 min se borra; el resto se reescribe con hechos, sin momentos ni frases', () => {
    const plan = planCleanup(
      [row(1, 10), row(2, 11), row(3, 12)],
      [
        { id: 10, duration_minutes: 7, game: 'Shadow of the Colossus', death_count: 0 },
        { id: 11, duration_minutes: 19, game: 'Shadow of the Colossus' },
        { id: 12, duration_minutes: 212, game: 'FINAL FANTASY XVI', death_count: 1, boss_count: 1 },
      ],
    );
    assert.deepEqual(
      plan.map((p) => p.action),
      ['delete', 'delete', 'rewrite'],
    );
    assert.equal(plan[2].after.summary, 'Directo de FINAL FANTASY XVI: tres horas y media, 1 caída y 1 jefe superado.');
    assert.deepEqual(plan[2].after.highlights, []);
    assert.deepEqual(plan[2].after.recurring_phrases, []);
    assert.equal(plan[2].after.game, 'FINAL FANTASY XVI');
  });

  test('20 minutos justos ya se reescribe', () => {
    const [p] = planCleanup([row(1, 10)], [{ id: 10, duration_minutes: 20, game: 'X' }]);
    assert.equal(p.action, 'rewrite');
  });

  test('sin sesión o sin duración no se toca', () => {
    const plan = planCleanup([row(1, null), row(2, 99), row(3, 10)], [{ id: 10, duration_minutes: null }]);
    assert.deepEqual(
      plan.map((p) => p.action),
      ['skip', 'skip', 'skip'],
    );
  });

  test('no hay ninguna acción para ids que no están en las filas recibidas', () => {
    assert.deepEqual(planCleanup([], [{ id: 1, duration_minutes: 50 }]), []);
  });
});
