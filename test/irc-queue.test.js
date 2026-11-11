const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { wrapClientSay, _testHooks } = require('../src/utils/irc-ratelimit');
const state = require('../src/utils/state');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const t = Date.now();
  while (!fn() && Date.now() - t < ms) await wait(5);
};

function makeClient({ sayImpl, open = true } = {}) {
  const sent = [];
  const client = {
    say: async (ch, msg) => {
      if (sayImpl) await sayImpl(msg);
      sent.push(msg);
    },
    readyState: () => (open ? 'OPEN' : 'CLOSED'),
  };
  wrapClientSay(client);
  return { client, sent };
}

describe('cola IRC', () => {
  beforeEach(() => {
    _testHooks({ gapMs: 5, sayTimeoutMs: 80, reset: true });
    state.setStreamIsLive(true);
    state.setStreamEndGraceUntil(0);
    state.resetRecentUserTexts();
  });

  test('un mensaje caducado se descarta y no atasca la cola', async () => {
    const { client, sent } = makeClient();
    client.say('#c', 'tarde', undefined, { expiresAt: Date.now() - 1 });
    client.say('#c', 'a tiempo');
    await until(() => sent.length >= 1);
    assert.deepEqual(sent, ['a tiempo']);
    assert.equal(_testHooks().queued, 0);
  });

  test('varios caducados seguidos y luego uno bueno', async () => {
    const { client, sent } = makeClient();
    for (let i = 0; i < 5; i++) client.say('#c', `viejo ${i}`, undefined, { expiresAt: Date.now() - 1 });
    client.say('#c', 'bueno');
    await until(() => sent.length >= 1);
    assert.deepEqual(sent, ['bueno']);
  });

  test('un say() que nunca contesta no deja la cola parada', async () => {
    let first = true;
    const { client, sent } = makeClient({
      sayImpl: () => {
        if (first) {
          first = false;
          return new Promise(() => {});
        }
      },
    });
    client.say('#c', 'colgado');
    client.say('#c', 'siguiente');
    await until(() => sent.length >= 1);
    assert.deepEqual(sent, ['siguiente']);
  });

  test('un say() que lanza no impide enviar los siguientes', async () => {
    let first = true;
    const { client, sent } = makeClient({
      sayImpl: async () => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
      },
    });
    client.say('#c', 'falla');
    client.say('#c', 'sigue');
    await until(() => sent.length >= 1);
    assert.deepEqual(sent, ['sigue']);
  });

  test('cliente desconectado: se descarta sin bloquear', async () => {
    const { client, sent } = makeClient({ open: false });
    client.say('#c', 'nada');
    await wait(40);
    assert.deepEqual(sent, []);
    assert.equal(_testHooks().queued, 0);
  });

  test('el filtro de salida descarta URLs y ofensivos y sigue con el resto', async () => {
    const { client, sent } = makeClient();
    client.say('#c', 'entra en https://malo.example/x');
    client.say('#c', 'eres un nazi');
    client.say('#c', 'hola chat');
    await until(() => sent.length >= 1);
    assert.deepEqual(sent, ['hola chat']);
  });

  test('descarta el eco literal de un usuario', async () => {
    state.pushUserText('el mejor streamer del mundo mundial');
    const { client, sent } = makeClient();
    client.say('#c', 'Dicen que el mejor streamer del mundo mundial es otro');
    client.say('#c', 'otra cosa distinta');
    await until(() => sent.length >= 1);
    assert.deepEqual(sent, ['otra cosa distinta']);
  });

  test('con el directo apagado no habla nada autónomo, pero sí responde a comandos', async () => {
    state.setStreamIsLive(false);
    const { client, sent } = makeClient();
    client.say('#c', 'cohost suelto', { origin: 'cohost' });
    client.say('#c', 'sin origen');
    client.say('#c', 'respuesta a comando', { origin: 'comando' });
    await until(() => sent.length >= 1);
    await wait(30);
    assert.deepEqual(sent, ['respuesta a comando']);
  });

  test('tras el fin del stream el resumen aún puede salir (margen)', async () => {
    state.setStreamIsLive(false);
    state.setStreamEndGraceUntil(Date.now() + 60_000);
    const { client, sent } = makeClient();
    client.say('#c', '🎬 ¡Fin del stream!', { origin: 'alerta' });
    await until(() => sent.length >= 1);
    assert.deepEqual(sent, ['🎬 ¡Fin del stream!']);
  });
});
