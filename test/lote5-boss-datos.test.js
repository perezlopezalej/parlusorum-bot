process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { parseBossArgs, applyBossDelta, sumGameDeaths } = require('../src/commands/stats');
const state = require('../src/utils/state');

// Casos reales del directo del 02-11-2026 (logs/chat-2026-11-02.txt)
const RAWG_PHANTOM = 'Nombre: Phantom Blade Zero\nSalida: 2026-09-09\nDesarrolladora: S-Game\nGéneros: Acción, Aventura\nDescripción: Action game set in a fantasy world.';

describe('!boss', () => {
  test('parseBossArgs: ver, sumar, restar, reset y juego', () => {
    assert.deepEqual(parseBossArgs(['boss']), { type: 'show' });
    assert.deepEqual(parseBossArgs(['boss', '+3']), { type: 'add', n: 3 });
    assert.deepEqual(parseBossArgs(['boss', '-2']), { type: 'sub', n: 2 });
    assert.deepEqual(parseBossArgs(['boss', 'reset']), { type: 'reset' });
    assert.deepEqual(parseBossArgs(['boss', 'Phantom', 'Blade', 'Zero']), { type: 'game', game: 'Phantom Blade Zero' });
    assert.equal(parseBossArgs(['boss', '+0']).type, 'bad_format');
    assert.equal(parseBossArgs(['boss', '+99']).type, 'bad_format');
    assert.equal(parseBossArgs(['boss', '3']).type, 'bad_format');
    assert.equal(parseBossArgs(['boss', '-']).type, 'bad_format');
  });
  test('applyBossDelta suma N y no baja de 0', () => {
    assert.deepEqual(applyBossDelta(2, { type: 'add', n: 3 }), { wins: 5, removed: 0 });
    assert.deepEqual(applyBossDelta(1, { type: 'sub', n: 5 }), { wins: 0, removed: 1 });
  });
  test('total por juego con boss_count y el directo en curso', () => {
    const rows = [
      { id: 1, game: 'Phantom Blade Zero', boss_count: 3 },
      { id: 2, game: 'Phantom Blade Zero', boss_count: 2 },
      { id: 3, game: 'Hades', boss_count: 7 },
    ];
    const res = sumGameDeaths('phantom blade zero', rows, { id: 2, deaths: 4 }, 'boss_count');
    assert.equal(res.total, 7);
    assert.equal(res.streams, 2);
  });
  test('el contador de jefes vive en state y no baja de 0', () => {
    state.setBossCount(4);
    assert.equal(state.getBossCount(), 4);
    state.setBossCount(-3);
    assert.equal(state.getBossCount(), 0);
    state.setBossCount(2);
    state.resetBossCount();
    assert.equal(state.getBossCount(), 0);
  });
});

describe('datos inventados', () => {
  test('país de la desarrolladora que RAWG no da', () => {
    assert.equal(q.unsupportedAttributes('S-Game, una desarrolladora japonesa', RAWG_PHANTOM), 'japonesa');
    assert.equal(q.unsupportedAttributes('Lo hace S-Game, un estudio chino, ni sé más', RAWG_PHANTOM), 'chino');
  });
  test('respaldado o sin atributos: pasa', () => {
    assert.equal(q.unsupportedAttributes('Lo hace S-Game y sale en 2026, acción pura.', RAWG_PHANTOM), '');
    assert.equal(q.unsupportedAttributes('Lo hace un estudio japonés', `${RAWG_PHANTOM}\nStudio based in Japan`), '');
    assert.equal(q.unsupportedAttributes('Los chinos inventaron la pólvora', ''), '');
  });
  test('presupuestos, cifras y personas', () => {
    assert.equal(q.unsupportedAttributes('Tuvo un presupuesto enorme para el juego', RAWG_PHANTOM), 'presupuesto');
    assert.ok(q.unsupportedAttributes('Ha vendido 2.000.000 de copias', RAWG_PHANTOM));
    assert.equal(q.unsupportedAttributes('Dirigido por Wang Li, el estudio S-Game', RAWG_PHANTOM), 'Wang Li');
    assert.equal(q.unsupportedAttributes('Desarrollado por S-Game', RAWG_PHANTOM), '');
  });
  test('los mensajes automáticos sin datos no afirman país ni presupuesto', () => {
    assert.ok(q.gameTalkProblem('El estudio japonés detrás de este juego sabe lo que hace'));
    assert.equal(q.gameTalkProblem('Manu cae como si fuera un deporte olímpico'), null);
  });
});

describe('menciones', () => {
  test('"¿Qué juego es?" se detecta; otras preguntas no', () => {
    for (const t of ['Que juego es?', 'Dios fua que juego es?', '¿Qué juego es este?', 'a que juego juegan hoy?', 'cual es el juego de hoy?']) assert.ok(q.isCurrentGameQuestion(t), t);
    for (const t of ['que juego es mejor, este o hades?', 'Dios fua cuantas crees que habrá?', 'me recomiendas un juego?']) assert.ok(!q.isCurrentGameQuestion(t), t);
  });
  test('una opinión sobre las muertes no es pregunta de juego ni del contador', () => {
    assert.ok(!q.isGameQuestion('Dios fua cuantas crees que habrá?'));
    assert.ok(!q.isDeathQuestion('Dios fua cuantas crees que habrá?'));
  });
  test('singular: 1 muerte, 1 bit', () => {
    assert.equal(q.countDeaths(1), '1 muerte');
    assert.equal(q.countDeaths(16), '16 muertes');
    assert.equal(q.countBits(1), '1 bit');
    assert.equal(q.countBits(100), '100 bits');
  });
});

describe('nombre de usuario en bienvenidas y alertas', () => {
  test('insertUsername pone el nombre del código, no el de la IA', () => {
    assert.equal(q.insertUsername('¡Bienvenido {usuario}, que tus golpes sean épicos!', 'aldairbonilla16'), '¡Bienvenido @aldairbonilla16, que tus golpes sean épicos!');
    assert.ok(!q.insertUsername('¡Bienvenido @aldorbonilla16, a por el FUA!', 'aldairbonilla16').includes('aldorbonilla16'));
    assert.ok(q.insertUsername('¡Bienvenido @aldorbonilla16, a por el FUA!', 'aldairbonilla16').startsWith('@aldairbonilla16 '));
    assert.equal(q.insertUsername('Qué alegría verte', 'javifresco'), '@javifresco Qué alegría verte');
  });
  test('fixMentions corrige un nombre mal escrito o quita el que no existe', () => {
    assert.equal(q.fixMentions('¡Gracias @aldorbonilla16 por el sub!', ['aldairbonilla16']), '¡Gracias @aldairbonilla16 por el sub!');
    assert.equal(q.fixMentions('Hola @Javifresco', ['javifresco']), 'Hola @javifresco');
    assert.equal(q.fixMentions('Hola @otrapersona total', ['javifresco']), 'Hola total');
  });
});

describe('cohost', () => {
  test('alguien de bajón: el cohost libre calla', () => {
    assert.ok(q.hasPersonalDistress('gangar79: Qué me dió bajona'));
    assert.ok(q.hasPersonalDistress('hoy estoy mal, la verdad'));
    assert.ok(!q.hasPersonalDistress('Manu cae otra vez jajaja'));
  });
  test('la fórmula "Manu lleva N caídas y el FUA…" no se repite en el stream', () => {
    const t = 'Manu lleva 13 caídas y el FUA parece estar de vacaciones, ¡a ver si vuelve pronto!';
    assert.equal(q.structureKey(t), 'lleva-caidas');
    assert.equal(q.validateCohost(t, { deathCount: 13, usedStructures: new Set() }).ok, true);
    const again = q.validateCohost('Manu lleva 16 caídas y el FUA ya se prepara para la próxima ronda.', { deathCount: 16, usedStructures: new Set(['lleva-caidas']) });
    assert.equal(again.ok, false);
    assert.equal(again.rule, 'estructura');
  });
  test('el timer IA tampoco repite la estructura', () => {
    const r = q.validateTimerIA('¡Manu lleva 11 caídas y el FUA lo levanta con energía!', { deathCount: 11, usedStructures: new Set(['lleva-caidas']) });
    assert.equal(r.ok, false);
  });
  test('state recuerda las estructuras y las olvida al reiniciar el stream', () => {
    state.markStructure('lleva-caidas');
    assert.ok(state.getUsedStructures().has('lleva-caidas'));
    state.resetBotHistory();
    assert.equal(state.getUsedStructures().size, 0);
  });
});

describe('resumen final', () => {
  test('"logrando 16 muertes" se detecta y se descarta; "con 16 caídas" vale', () => {
    assert.ok(q.achievesDeaths('ParLusorum disfrutó de una larga partida, logrando 16 muertes y enfrentando varios jefes'));
    assert.ok(q.achievesDeaths('consiguió 3 caídas'));
    assert.ok(!q.achievesDeaths('Cayó 16 veces pero el chat no paró'));
    assert.ok(!q.achievesDeaths('Una partida con 16 caídas y mucho FUA'));
    assert.ok(q.validateQueMePerdi('Manu ha logrado 5 muertes ya', { deathCount: 5, bosses: 0 }));
  });
});
