// "el FUA" siempre en masculino: la regla se aplica a todos los tipos de mensaje
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { summaryProblem } = require('../src/memory/handler');

const BAD = 'Soy el signo de la FUA: el que no se queda quieto, siempre en acción.';
const GOOD = 'Soy el signo del FUA: el que no se queda quieto, siempre en acción.';

test('la regla vale para cohost, menciones, timer, hook, alertas, resumen y !quemeperdi', () => {
  assert.equal(q.validateCohost(BAD, { deathCount: 5 }).rule, 'fua');
  assert.equal(q.validateMention(BAD).rule, 'fua');
  assert.equal(q.validateTimerIA(BAD, { deathCount: 5 }).ok, false);
  assert.equal(q.validateHook(`${BAD} ¿Y vosotros?`, { deathCount: 5 }).ok, false);
  assert.equal(q.validateAuto(BAD).ok, false);
  assert.ok(summaryProblem('Gran directo con la FUA presente en cada caída de Manu.'));
  assert.match(
    q.validateQueMePerdi('Llevamos un rato con la FUA a tope y poco más que contar.', {}) || '',
    /masculino/,
  );
  assert.equal(q.validateMention(GOOD).ok, true);
});

test('!dios_fua: "la FUA" se corrige a "el FUA" sin tocar el resto', () => {
  assert.equal(q.fixFuaGender(BAD), 'Soy el signo de el FUA: el que no se queda quieto, siempre en acción.');
  assert.equal(q.fixFuaGender('Tu FUA y la Fuaventura siguen igual.'), 'Tu FUA y la Fuaventura siguen igual.');
  assert.equal(q.fixFuaGender('Una FUA gigante, esa FUA.'), 'Un FUA gigante, ese FUA.');
});
