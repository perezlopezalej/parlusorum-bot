process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isAnswerMatch, buildHints, normalizeAnswer } = require('../src/games/handler');

describe('normalizeAnswer', () => {
  test('minúsculas, sin tildes ni puntuación', () => {
    assert.equal(normalizeAnswer('  ¡Júpiter! '), 'jupiter');
    assert.equal(normalizeAnswer('Pacífico'), 'pacifico');
  });

  test('ignora artículos', () => {
    assert.equal(normalizeAnswer('El Pacífico'), 'pacifico');
    assert.equal(normalizeAnswer('the last of us'), 'last of us');
  });

  test('ignora conectores solo en respuestas de varias palabras', () => {
    assert.equal(normalizeAnswer('Torre de Pisa'), 'torre pisa');
    assert.equal(normalizeAnswer('de'), 'de');
  });

  test('entradas vacías o nulas no rompen', () => {
    assert.equal(normalizeAnswer(''), '');
    assert.equal(normalizeAnswer(null), '');
    assert.equal(normalizeAnswer(undefined), '');
  });
});

describe('isAnswerMatch', () => {
  test('coincidencia exacta e ignorando tildes/mayúsculas/artículos', () => {
    assert.ok(isAnswerMatch('JUPITER', 'júpiter'));
    assert.ok(isAnswerMatch('el pacifico', 'pacifico'));
  });

  test('tolera erratas leves en respuestas largas', () => {
    assert.ok(isAnswerMatch('minecrafy', 'minecraft'));
    assert.ok(isAnswerMatch('nintendoo', 'nintendo'));
    assert.ok(isAnswerMatch('fuerza universal aplicda', 'fuerza universal aplicada'));
  });

  test('rechaza respuestas distintas', () => {
    assert.equal(isAnswerMatch('sony', 'microsoft'), false);
    assert.equal(isAnswerMatch('', 'sony'), false);
  });

  test('respuestas cortas y numéricas: solo exactas', () => {
    assert.ok(isAnswerMatch('7', '7'));
    assert.equal(isAnswerMatch('8', '7'), false);
    assert.equal(isAnswerMatch('2012', '2011'), false);
    assert.equal(isAnswerMatch('soni', 'sony'), false);
    assert.equal(isAnswerMatch('rusa', 'rusia'), false); // similitud 0.8 < umbral 0.85
  });

  test('respuestas alternativas (aliases)', () => {
    assert.ok(isAnswerMatch('cdmx', 'ciudad de mexico', ['cdmx', 'df']));
    assert.ok(isAnswerMatch('ciudad de méxico', 'ciudad de mexico', ['cdmx']));
    assert.equal(isAnswerMatch('madrid', 'ciudad de mexico', ['cdmx']), false);
  });

  describe('fechas', () => {
    const answer = '22 de junio de 2023';

    test('acepta formatos equivalentes', () => {
      assert.ok(isAnswerMatch('22 de junio de 2023', answer));
      assert.ok(isAnswerMatch('22 junio 2023', answer));
      assert.ok(isAnswerMatch('22/06/2023', answer));
      assert.ok(isAnswerMatch('22-6-2023', answer));
      assert.ok(isAnswerMatch('2023-06-22', answer));
      assert.ok(isAnswerMatch('22 de Junio de 2023', answer));
    });

    test('rechaza fechas distintas o incompletas', () => {
      assert.equal(isAnswerMatch('23 de junio de 2023', answer), false);
      assert.equal(isAnswerMatch('22 de julio de 2023', answer), false);
      assert.equal(isAnswerMatch('22 de junio de 2024', answer), false);
      assert.equal(isAnswerMatch('2023', answer), false);
      assert.equal(isAnswerMatch('junio 2023', answer), false);
    });

    test('la respuesta puede estar en formato numérico', () => {
      assert.ok(isAnswerMatch('22 de junio de 2023', '2023-06-22'));
    });

    test('un alias de solo año acepta "2023"', () => {
      assert.ok(isAnswerMatch('2023', answer, ['2023']));
    });
  });
});

describe('buildHints', () => {
  const answers = [
    'jupiter', 'minecraft', 'it takes two', 'fuerza universal aplicada',
    'the last of us part ii remastered', 'sony', 'rusia', 'dios_fua', 'ab', '2011', '12345',
  ];

  test('ninguna pista contiene la respuesta completa', () => {
    for (const answer of answers) {
      for (const hint of buildHints(answer)) {
        assert.ok(!hint.toLowerCase().includes(answer.toLowerCase()), `"${hint}" revela "${answer}"`);
      }
    }
  });

  test('la máscara oculta todas las letras salvo la primera', () => {
    const hints = buildHints('jupiter');
    assert.equal(hints.length, 2);
    assert.match(hints[1], /J______/);
    assert.ok(!/[a-z]/.test(hints[1].replace(/empieza por "J": /, '').replace('J', '')));
  });

  test('cuenta palabras y letras', () => {
    assert.equal(buildHints('it takes two')[0], '3 palabras, 10 letras');
    assert.equal(buildHints('sony')[0], '4 letras');
  });

  test('respuestas numéricas dicen cifra/cifras en vez de letra/letras', () => {
    assert.equal(buildHints('7')[0], '1 cifra');
    assert.equal(buildHints('1985')[0], '4 cifras');
    assert.equal(buildHints('sony')[0], '4 letras');
  });

  test('respuestas cortas (<5 letras) solo dan una pista', () => {
    assert.equal(buildHints('sony').length, 1);
    assert.equal(buildHints('ab').length, 1);
  });

  test('máscara de varias palabras mantiene la longitud de cada una', () => {
    assert.equal(buildHints('it takes two')[1], 'empieza por "I": I_ _____ ___');
  });
});
