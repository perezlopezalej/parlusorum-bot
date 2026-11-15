// 15-11: con una sola muerte en 2,5 horas el cohost la comentó 5 veces («¡Otra muerte!» siendo la primera, «Una caída ya…»).
// Una caída nueva se comenta una vez; el total, sin caídas nuevas, como mucho una vez por hora; «otra» solo si ya había alguna.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { buildMomentFacts } = require('../src/ai/moment-facts');

const NOW = Date.parse('2026-11-15T13:30:00Z');
const death = (minAgo) => ({ type: 'death', ts: NOW - minAgo * 60000, description: 'Muerte', n: 1 });
const base = { game: 'Horizon Forbidden West', minutes: 80, player: 'Manu', now: NOW };

describe('hechos de caídas', () => {
  test('una caída nueva se ofrece; después de comentarla no vuelve como «acaba de caer»', () => {
    const facts = buildMomentFacts({ ...base, deathCount: 1, events: [death(2)] });
    assert.ok(facts.some((f) => f.muertes === 'nueva' && /acaba de caer/.test(f.texto)));
    const after = buildMomentFacts({
      ...base,
      deathCount: 1,
      events: [death(2)],
      deathCommentedAt: NOW - 60000,
      offerDeathTotal: false,
    });
    assert.ok(!after.some((f) => f.muertes));
  });

  test('el total sin caídas nuevas solo sale si toca (una vez por hora)', () => {
    const due = buildMomentFacts({ ...base, deathCount: 3, events: [], offerDeathTotal: true });
    assert.ok(due.some((f) => f.muertes === 'total'));
    const notDue = buildMomentFacts({ ...base, deathCount: 3, events: [], offerDeathTotal: false });
    assert.ok(!notDue.some((f) => f.muertes));
  });

  test('una caída nueva no repite el total si ya se dijo en la última hora', () => {
    const facts = buildMomentFacts({ ...base, deathCount: 4, events: [death(1)], offerDeathTotal: false });
    const fact = facts.find((f) => f.muertes === 'nueva');
    assert.ok(fact);
    assert.ok(!/van /.test(fact.texto));
  });

  test('un suceso de muerte de la cola va marcado como caída nueva', () => {
    const facts = buildMomentFacts({
      ...base,
      deathCount: 1,
      moment: { kind: 'first_death', description: 'Muerte número 1 del streamer en este stream' },
    });
    assert.equal(facts[0].muertes, 'nueva');
    const boss = buildMomentFacts({ ...base, moment: { kind: 'boss', description: 'Ha caído un jefe' } });
    assert.ok(!boss.some((f) => f.muertes));
  });
});

describe('reglas de caídas del cohost', () => {
  const ctx = { deathCount: 1, game: 'Horizon Forbidden West' };

  test('caidas: sin hecho de caídas ofrecido, hablar de caídas se rechaza', () => {
    const r = quality.validateCohost('Una caída épica de Manu hoy, ¿el FUA la siente o solo el chat?', {
      ...ctx,
      deathsOffered: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.rule, 'caidas');
    assert.equal(quality.validateCohost('Manu, ¿te pierdes en el mapa?', { ...ctx, deathsOffered: false }).ok, true);
    assert.equal(
      quality.validateCohost('Una caída épica de Manu hoy, ¿el FUA la siente?', { ...ctx, deathsOffered: true }).ok,
      true,
    );
  });

  test('otra: «¡Otra muerte!» siendo la primera se rechaza; con 2 o más vale', () => {
    const text = '¡Otra muerte, Manu! ¿Quién lleva el botiquín del FUA?';
    assert.equal(quality.validateCohost(text, ctx).rule, 'otra');
    assert.equal(quality.validateCohost(text, { ...ctx, deathCount: 2 }).ok, true);
  });

  test('againDeathWrong y talksDeaths', () => {
    assert.ok(quality.againDeathWrong('Una caída más para Manu', 1));
    assert.ok(quality.againDeathWrong('Vuelve a caer el pobre', 0));
    assert.ok(!quality.againDeathWrong('Una caída más para Manu', 2));
    assert.ok(!quality.againDeathWrong('Manu sigue en pie', 1));
    assert.ok(quality.talksDeaths('Manu se ha liado una caída'));
    assert.ok(!quality.talksDeaths('Manu explora el mapa'));
  });

  test('el hook y el timer IA también rechazan «otra caída» con la primera', () => {
    assert.equal(
      quality.validateHook('¿Otra caída, Lusorums, o es el mando?', { deathCount: 1, requireQuestion: true }).ok,
      false,
    );
    assert.equal(
      quality.validateTimerIA('Otra caída de Manu y el chat lo anima con ganas.', { deathCount: 1 }).ok,
      false,
    );
  });
});
