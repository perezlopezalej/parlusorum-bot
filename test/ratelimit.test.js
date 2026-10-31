const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { canMakeRequest, canMakeAuxRequest, canUserMakeRequest, getRequestsRemaining } = require('../src/utils/ratelimit');

// Los límites por defecto son 30 global/min, 3 usuario, 8 mod y 15 creador
describe('rate limit de Groq', () => {
  beforeEach(() => {
    mock.timers.reset();
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60 * 1000 });
  });

  test('límite global: 30 por minuto y se libera al pasar la ventana', () => {
    for (let i = 0; i < 30; i++) assert.ok(canMakeRequest(), `petición ${i + 1}`);
    assert.equal(getRequestsRemaining(), 0);
    assert.equal(canMakeRequest(), false);
    mock.timers.tick(60_001);
    assert.ok(canMakeRequest());
    assert.equal(getRequestsRemaining(), 29);
  });

  test('límite por usuario normal: 3 por minuto', () => {
    assert.ok(canUserMakeRequest('u1'));
    assert.ok(canUserMakeRequest('u1'));
    assert.ok(canUserMakeRequest('u1'));
    assert.equal(canUserMakeRequest('u1'), false);
    assert.ok(canUserMakeRequest('u2'), 'otro usuario no se ve afectado');
    mock.timers.tick(60_001);
    assert.ok(canUserMakeRequest('u1'));
  });

  test('mods tienen 8 por minuto y el creador 15', () => {
    for (let i = 0; i < 8; i++) assert.ok(canUserMakeRequest('mod1', 'mod'));
    assert.equal(canUserMakeRequest('mod1', 'mod'), false);
    for (let i = 0; i < 15; i++) assert.ok(canUserMakeRequest('creator1', 'creator'));
    assert.equal(canUserMakeRequest('creator1', 'creator'), false);
    for (let i = 0; i < 15; i++) assert.ok(canUserMakeRequest('streamer1', 'streamer'));
    assert.equal(canUserMakeRequest('streamer1', 'streamer'), false);
  });

  test('una petición rechazada no consume cupo', () => {
    for (let i = 0; i < 3; i++) canUserMakeRequest('u3');
    for (let i = 0; i < 10; i++) assert.equal(canUserMakeRequest('u3'), false);
    mock.timers.tick(60_001);
    assert.ok(canUserMakeRequest('u3'));
  });
});

describe('cupo auxiliar del factcheck', () => {
  test('15 por minuto, aparte del límite global', () => {
    mock.timers.reset();
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 30 * 60 * 1000 });
    const before = getRequestsRemaining();
    for (let i = 0; i < 15; i++) assert.ok(canMakeAuxRequest(), `aux ${i + 1}`);
    assert.equal(canMakeAuxRequest(), false);
    assert.equal(getRequestsRemaining(), before, 'no consume el cupo global');
    mock.timers.tick(60_001);
    assert.ok(canMakeAuxRequest());
  });
});
