// Etnias y vida personal ampliadas tras el directo del 11-11 («gitano desgastado», «la gordi», «una banca de 110kg»).
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { checkOutbound } = require('../src/utils/output-guard');
const { summaryProblem } = require('../src/memory/handler');

describe('etnias y pueblos', () => {
  test('«gitano» y derivados se detectan', () => {
    for (const t of [
      'un gitano desgastado',
      'Gitanos por todas partes',
      'esa gitana de ahí',
      'menuda gitanada',
      'Manu está gitaneando',
      'Menudo payo el jefe',
      'trabajar como un negro',
      'currar como un chino',
      'hacer el indio',
    ])
      assert.ok(quality.mentionsEthnicTerms(t), t);
  });

  test('palabras normales no saltan', () => {
    for (const t of [
      'Manu juega con calma y el chat anima',
      'el jefe final es un indio de Skyrim? no, qué va',
      'un negro azabache en la pantalla',
      'los chinos del tutorial no existen',
    ])
      assert.ok(!quality.mentionsEthnicTerms(t), t);
  });

  test('styleProblem, validadores y resumen las rechazan', () => {
    assert.equal(quality.styleProblem('Manu sufre con un gitano desgastado en el coloso').rule, 'etnia');
    assert.equal(quality.validateMention('@a eso es de gitanos, jefe', { question: 'hola' }).rule, 'etnia');
    assert.equal(quality.validateQueMePerdi('Un gitano desgastado y tres caídas', { deathCount: 3 }) !== null, true);
    assert.ok(summaryProblem('Noche de gitanos y buen rollo'));
  });

  test('menciones: se veta aunque el usuario lo escriba', () => {
    assert.equal(quality.validateMention('Cosas de gitanos, campeón', { question: 'los gitanos' }).ok, false);
  });
});

describe('capa de salida', () => {
  const NOW = 1_000_000;
  const out = (text, o = {}) => checkOutbound(text, { now: NOW, live: true, ...o });

  test('se bloquea en cualquier origen', () => {
    for (const origin of ['cohost', 'timer_ia', 'hook', 'mencion', 'trivia'])
      assert.equal(out('un gitano desgastado', { origin }).reason, 'etnia', origin);
  });

  test('!dios_fua solo si el usuario lo nombró hace poco', () => {
    const asked = [{ text: '!dios_fua de dónde vienen los gitanos', at: NOW - 1000 }];
    assert.equal(out('Los gitanos llegaron desde la India', { origin: 'dios_fua', recent: asked }).ok, true);
    assert.equal(out('Los gitanos llegaron desde la India', { origin: 'dios_fua' }).reason, 'etnia');
    assert.equal(out('Los gitanos llegaron desde la India', { origin: 'comando', recent: asked }).reason, 'etnia');
  });
});

describe('vida personal ampliada', () => {
  test('pareja, gimnasio, peso y kilos', () => {
    for (const t of [
      'la gordi se queda pillao',
      'mi mujer me mata',
      'dile a la parienta que cene',
      'una banca de 110kg',
      'Voy al gimnasio luego',
      'pesaba 60 kg a los 18',
      'cuántos kilos levantas',
      'con la dieta estoy fatal',
    ])
      assert.ok(quality.personalMatch(t), t);
  });

  test('expresiones del juego no cuentan', () => {
    for (const t of [
      'el chat pide un peso pesado para el jefe',
      'la mujer del cuadro mira a Manu',
      'qué peso tiene este jefe en la historia',
      'Manu cae y el FUA sube el ánimo',
    ])
      assert.ok(!quality.personalMatch(t), t);
  });

  test('el cohost las rechaza como vida personal', () => {
    assert.equal(quality.styleProblem('El FUA ya sabe que la gordi se queda pillao').rule, 'personal');
  });
});
