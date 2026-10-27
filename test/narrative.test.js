const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  pruneNarrative, restoreNarrative, buildStoryBlock, condenseChat,
  cohostProbability, hourlyCapReached, pruneHourly,
} = require('../src/utils/narrative');
const state = require('../src/utils/state');

const ev = (type, ts, description = type) => ({ type, description, ts });

describe('poda de la narrativa', () => {
  test('por debajo del tope no toca nada', () => {
    const events = [ev('death', 1), ev('rage', 2)];
    assert.deepEqual(pruneNarrative(events, 5), events);
  });

  test('descarta primero lo de menor prioridad y, a igualdad, lo más antiguo', () => {
    const events = [ev('rage', 1), ev('sub', 2), ev('rage', 3), ev('raid', 4)];
    assert.deepEqual(pruneNarrative(events, 3).map(e => e.ts), [2, 3, 4]);
    assert.deepEqual(pruneNarrative(events, 2).map(e => e.ts), [2, 4]);
  });

  test('un tipo desconocido cuenta como prioridad baja', () => {
    const events = [ev('otro', 1), ev('death', 2), ev('death', 3)];
    assert.deepEqual(pruneNarrative(events, 2).map(e => e.ts), [2, 3]);
  });
});

describe('restaurar la narrativa guardada', () => {
  test('lo que no es un array da []', () => {
    assert.deepEqual(restoreNarrative(null), []);
    assert.deepEqual(restoreNarrative('x'), []);
  });

  test('filtra eventos inválidos, ordena por hora y aplica el tope', () => {
    const raw = [ev('death', 30), { type: 'x' }, null, ev('sub', 10), { type: 'sub', description: 'd', ts: 'ayer' }];
    assert.deepEqual(restoreNarrative(raw).map(e => e.ts), [10, 30]);
    assert.equal(restoreNarrative(Array.from({ length: 30 }, (_, i) => ev('death', i)), 12).length, 12);
  });

  test('recorta tipo y descripción excesivos', () => {
    const [e] = restoreNarrative([ev('t'.repeat(50), 1, 'd'.repeat(500))]);
    assert.equal(e.type.length, 20);
    assert.equal(e.description.length, 200);
  });
});

describe('buildStoryBlock', () => {
  test('sin eventos devuelve cadena vacía', () => {
    assert.equal(buildStoryBlock([]), '');
    assert.equal(buildStoryBlock(undefined), '');
  });

  test('incluye tiempo relativo, tipo y descripción', () => {
    const now = 10 * 60000;
    const block = buildStoryBlock([ev('death', 2 * 60000, 'Muerte #3'), ev('sub', now - 10000, 'Ana se suscribió')], now);
    assert.equal(block, '\n<stream_story>[hace 8min] [death] Muerte #3 | [ahora] [sub] Ana se suscribió</stream_story>');
  });
});

describe('condenseChat', () => {
  const lines = [
    { username: 'ana', message: 'que boss tan dificil' },
    { username: 'ana', message: 'otra vez el boss' },
    { username: 'bob', message: 'el boss es imposible' },
  ];

  test('sin líneas devuelve cadena vacía', () => {
    assert.equal(condenseChat([]), '');
  });

  test('resume usuarios activos, palabras repetidas y últimos mensajes', () => {
    const out = condenseChat(lines);
    assert.match(out, /^3 mensajes de 2 usuarios\./);
    assert.match(out, /ana\(2\), bob\(1\)/);
    assert.match(out, /Se repite: boss\./);
    assert.match(out, /Últimos: .*bob: el boss es imposible$/);
  });

  test('trunca los últimos mensajes y omite palabras de relleno', () => {
    const out = condenseChat([{ username: 'a', message: 'x'.repeat(300) }], { maxLast: 10 });
    assert.ok(out.endsWith(`a: ${'x'.repeat(10)}`));
    assert.ok(!out.includes('Se repite'));
  });
});

describe('cohostProbability', () => {
  const base = { base: 0.1, cooldownMs: 100000 };

  test('es 0 dentro del cooldown', () => {
    assert.equal(cohostProbability({ ...base, elapsedMs: 99999 }), 0);
  });

  test('vale la base al salir del cooldown y crece con el tiempo', () => {
    assert.ok(Math.abs(cohostProbability({ ...base, elapsedMs: 100000 }) - 0.1) < 1e-9);
    assert.ok(Math.abs(cohostProbability({ ...base, elapsedMs: 200000 }) - 0.4) < 1e-9);
  });

  test('aplica el multiplicador del modo y no pasa del tope', () => {
    assert.ok(Math.abs(cohostProbability({ ...base, multiplier: 2, elapsedMs: 100000 }) - 0.2) < 1e-9);
    assert.equal(cohostProbability({ ...base, elapsedMs: 10_000_000 }), 0.9);
    assert.equal(cohostProbability({ ...base, multiplier: 0.3, elapsedMs: 100000 }) < 0.1, true);
  });
});

describe('tope de cohosts por hora', () => {
  const NOW = 10 * 3600000;

  test('descarta marcas de más de una hora', () => {
    assert.deepEqual(pruneHourly([NOW - 3600001, NOW - 1000], NOW), [NOW - 1000]);
  });

  test('se alcanza al llegar al máximo dentro de la hora', () => {
    const stamps = Array.from({ length: 10 }, (_, i) => NOW - i * 1000);
    assert.equal(hourlyCapReached(stamps, 10, NOW), true);
    assert.equal(hourlyCapReached(stamps.slice(1), 10, NOW), false);
    assert.equal(hourlyCapReached(stamps, 10, NOW + 3600000), false);
  });
});

describe('estado: narrativa, cohost y pausas', () => {
  test('la narrativa conserva hasta 12 eventos y avisa al listener en cada cambio', () => {
    state.resetStreamNarrative();
    const seen = [];
    state.onNarrativeChange(events => seen.push(events.length));
    for (let i = 0; i < 15; i++) state.addNarrativeEvent('death', `Muerte ${i}`);
    assert.equal(state.getStreamNarrative().length, 12);
    assert.equal(seen.length, 15);
    state.onNarrativeChange(null);
    state.resetStreamNarrative();
  });

  test('setStreamNarrative restaura sin avisar al listener', () => {
    let calls = 0;
    state.onNarrativeChange(() => calls++);
    state.setStreamNarrative([ev('sub', 5), { basura: true }]);
    assert.equal(state.getStreamNarrative().length, 1);
    assert.equal(calls, 0);
    state.onNarrativeChange(null);
    state.resetStreamNarrative();
  });

  test('un fallo del listener no rompe addNarrativeEvent', () => {
    state.onNarrativeChange(() => { throw new Error('db caída'); });
    assert.doesNotThrow(() => state.addNarrativeEvent('boss', 'x'));
    state.onNarrativeChange(null);
    state.resetStreamNarrative();
  });

  test('recordCohost cuenta el cupo horario salvo que falle la IA', () => {
    const before = state.getCohostTimes().length;
    state.recordCohost(Date.now(), false);
    assert.equal(state.getCohostTimes().length, before);
    state.recordCohost();
    assert.equal(state.getCohostTimes().length, before + 1);
  });

  test('un hook por pausa; otra pausa, otro hook', () => {
    assert.equal(state.claimHookPause(111, 1000), true);
    assert.equal(state.claimHookPause(111, 2000), false);
    assert.equal(state.claimHookPause(222, 3000), true);
  });

  test('el cohost solo puede hablar tras el hook de esa pausa, pasado el tiempo, y una vez', () => {
    assert.equal(state.canCohostOnPause(333, 1000, 5000), false); // aún no habló el hook
    state.claimHookPause(333, 10000);
    assert.equal(state.canCohostOnPause(333, 1000, 10500), false); // demasiado pronto
    assert.equal(state.canCohostOnPause(333, 1000, 11000), true);
    assert.equal(state.canCohostOnPause(444, 1000, 11000), false); // otra pausa
    state.markCohostPause(333);
    assert.equal(state.canCohostOnPause(333, 1000, 20000), false); // ya habló el cohost
  });

  test('tras el cohost la pausa sigue cerrada al hook (nunca dos mensajes del mismo tipo)', () => {
    state.claimHookPause(555, 1000);
    state.markCohostPause(555);
    assert.equal(state.claimHookPause(555, 9000), false);
  });
});
