const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildQuestionSystemContent, LORE_RULE } = require('../src/ai/prompts');

describe('prompt de !dios_fua', () => {
  const p = buildQuestionSystemContent({ personality: 'P.', toneNote: ' T.', trapNote: ' X.' });
  test('conserva personalidad y notas', () => assert.ok(p.startsWith('P. T. X.')));
  test('obliga a buscar_juego también para opiniones', () => {
    assert.match(p, /buscar_juego/);
    assert.match(p, /opinión/);
    assert.match(p, /SIEMPRE/);
  });
  test('sin datos, que lo diga con humor sin inventar', () => assert.match(p, /con humor en vez de inventar/));
  test('incluye la regla de lore', () => {
    assert.ok(p.includes(LORE_RULE));
    assert.match(LORE_RULE, /no inventes personajes, títulos, cargos/);
    assert.match(LORE_RULE, /lore manual o en el lore aprendido activo/);
  });
});
