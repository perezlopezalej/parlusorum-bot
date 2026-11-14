const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/utils/state');
const messages = require('../config/messages.json');
const { wrapClientSay, _testHooks } = require('../src/utils/irc-ratelimit');

describe('un comando nunca se queda sin respuesta', () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  beforeEach(() => {
    _testHooks({ gapMs: 5, sayTimeoutMs: 80, reset: true });
    state.setStreamIsLive(true);
    state.setStreamEndGraceUntil(0);
  });
  test('si el filtro de salida descarta la respuesta, sale el aviso de reserva (una sola vez)', async () => {
    const sent = [];
    const client = { say: async (c, m) => sent.push(m), readyState: () => 'OPEN' };
    wrapClientSay(client);
    client.say('#c', 'entra en https://malo.example/x', { origin: 'comando' });
    await wait(150);
    assert.deepEqual(sent, [messages.comando_descartado]);
  });
  test('los orígenes que no son comandos se descartan sin aviso', async () => {
    const sent = [];
    const client = { say: async (c, m) => sent.push(m), readyState: () => 'OPEN' };
    wrapClientSay(client);
    client.say('#c', 'entra en https://malo.example/x', { origin: 'cohost' });
    await wait(150);
    assert.deepEqual(sent, []);
  });
});
