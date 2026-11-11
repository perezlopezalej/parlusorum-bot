const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildQuestionSystem } = require('../src/ai/style');

describe('prompt de !dios_fua', () => {
  const p = buildQuestionSystem({
    context: 'Se está jugando a «X».',
    role: 'Es suscriptor.',
    tone: 'Suena frustrado.',
    modeLine: 'MODO CHILL.',
  });
  test('lleva etiquetas de contexto, quién escribe, modo, forma, ejemplos y tarea al final', () => {
    for (const tag of ['contexto', 'quien_escribe', 'modo', 'forma', 'ejemplos'])
      assert.match(p, new RegExp('<' + tag + '>'));
    assert.match(
      p,
      /<tarea>Responde a la pregunta del usuario; si nombra un videojuego, consulta antes buscar_juego\.<\/tarea>$/,
    );
  });
  test('usa buscar_juego para videojuegos y reconoce con humor lo que los datos no dicen', () => {
    assert.match(p, /lo primero es llamar a la herramienta buscar_juego/);
    assert.match(p, /reconócelo con humor/);
  });
  test('entre 3 y 5 ejemplos de !dios_fua', () => {
    const n = p.split('<example>').length - 1;
    assert.ok(n >= 3 && n <= 5, String(n));
  });
});
