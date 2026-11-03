process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');

describe('muletillas (tío, tía, colega, bro, chaval)', () => {
  test('stripFillers limpia la puntuación sin dejar ", ." ni dobles espacios', () => {
    const casos = [
      ['Menuda caída, tío.', 'Menuda caída.'],
      ['Menuda caída, tío!', 'Menuda caída!'],
      ['Tío, menuda caída.', 'Menuda caída.'],
      ['¡Venga, tío, que tú puedes!', '¡Venga, que tú puedes!'],
      ['Oye tío, eso ha dolido, colega.', 'Oye, eso ha dolido.'],
      ['Eso no se hace tío porque duele', 'Eso no se hace porque duele'],
      ['¡Bro, qué susto! Tía, casi muere.', '¡Qué susto! Casi muere.'],
      ['Vaya partida, chaval... ¿no?', 'Vaya partida... ¿no?'],
    ];
    for (const [entrada, esperado] of casos) {
      const out = q.stripFillers(entrada);
      assert.equal(out, esperado, entrada);
      assert.ok(!/, ?[.!?]|\s{2}|\s,/.test(out), out);
    }
  });

  test('no toca nombres de usuario, palabras que la contienen ni el sustantivo', () => {
    for (const s of ['@tio_pepe gracias por el sub, histórico', 'el tiovivo de Manu', 'un broche de oro', 'Ese tío es un crack', 'Mi colega Pao juega genial', 'Menuda tía, qué nivel']) {
      assert.equal(q.limitFillers(s), s);
    }
  });

  test('limitFillers quita el apelativo en todos los mensajes, sin descartarlos', () => {
    const msgs = ['Qué bueno, tío.', 'Otra caída, tío.', 'Ánimo, colega.', 'Menuda racha, tío.'];
    assert.deepEqual(msgs.map(q.limitFillers), ['Qué bueno.', 'Otra caída.', 'Ánimo.', 'Menuda racha.']);
  });

  test('un mensaje sin muletilla no cambia', () => {
    assert.equal(q.limitFillers('Gran raid.'), 'Gran raid.');
  });
});

describe('Lusorums (comunidad)', () => {
  test('limitLusorums: 1 de cada 4 mensajes', () => {
    const flags = [];
    const msgs = ['¡Vamos, Lusorums!', 'Lusorums, qué racha.', 'Ánimo, Lusorums.', '¡Fuerza, Lusorums!', '¡Otra vez, Lusorums!'];
    const out = msgs.map(m => { const r = q.limitLusorums(m, flags.slice(-3)); flags.push(r.had); return r.text; });
    assert.deepEqual(out, ['¡Vamos, Lusorums!', 'Qué racha.', 'Ánimo.', '¡Fuerza!', '¡Otra vez, Lusorums!']);
  });

  test('nunca en un mensaje dirigido a una persona', () => {
    assert.equal(q.limitLusorums('@pepe vamos, Lusorums, que se puede', []).text, '@pepe vamos, que se puede');
  });

  test('no toca "parlusorum"', () => {
    assert.equal(q.hasLusorums('Gran directo en parlusorum'), false);
  });
});
