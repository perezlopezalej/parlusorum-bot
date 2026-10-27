process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { markGiftBatch, isGiftBatch } = require('../src/utils/state');
const { canMakeRequest } = require('../src/utils/ratelimit');
const { onSubGift, onMysteryGift, throttleSay } = require('../src/alerts/handler');

const CHANNEL = '#parlusorum';
const QUEUE_GAP_MS = 1600;

function fakeClient() {
  const said = [];
  return { said, say: (channel, msg) => said.push(msg) };
}

// Vacía la cola de alertas avanzando el reloj simulado
function drain() {
  for (let i = 0; i < 30; i++) mock.timers.tick(QUEUE_GAP_MS);
}

describe('lotes de subs regaladas (state)', () => {
  test('un origin-id marcado se reconoce; uno desconocido o vacío no', () => {
    markGiftBatch('origin-a');
    assert.ok(isGiftBatch('origin-a'));
    assert.equal(isGiftBatch('origin-b'), false);
    assert.equal(isGiftBatch(undefined), false);
    markGiftBatch(undefined);
    assert.equal(isGiftBatch(undefined), false);
  });

  test('el lote caduca a los 10 minutos', () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    markGiftBatch('origin-ttl');
    mock.timers.tick(10 * 60 * 1000 - 1);
    assert.ok(isGiftBatch('origin-ttl'));
    mock.timers.tick(2);
    assert.equal(isGiftBatch('origin-ttl'), false);
    mock.timers.reset();
  });
});

describe('agrupación de alertas de subs', () => {
  beforeEach(() => {
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    // Agota el cupo de Groq: los anuncios usan el texto fijo y no llaman a la IA
    while (canMakeRequest());
  });

  test('un regalo masivo se anuncia una vez y sus subgift individuales se ignoran', async () => {
    const client = fakeClient();
    const tags = { 'msg-param-origin-id': 'batch-1' };
    await onMysteryGift(client, CHANNEL, 'generoso', 5, {}, tags);
    for (let i = 0; i < 5; i++) await onSubGift(client, CHANNEL, 'generoso', `viewer${i}`, {}, tags);
    drain();
    assert.equal(client.said.length, 1);
    assert.match(client.said[0], /generoso/);
  });

  test('subgift sin lote o con otro origin-id sí se anuncian', async () => {
    const client = fakeClient();
    await onMysteryGift(client, CHANNEL, 'a', 3, {}, { 'msg-param-origin-id': 'batch-2' });
    await onSubGift(client, CHANNEL, 'b', 'v1', {}, { 'msg-param-origin-id': 'otro' });
    await onSubGift(client, CHANNEL, 'c', 'v2', {}, undefined);
    drain();
    assert.equal(client.said.length, 3);
  });

  test('lote grande: se descartan las alertas antiguas y los nombres se juntan en un mensaje final', async () => {
    const client = fakeClient();
    // 1 sale al instante, 8 quedan en cola y el máximo descartable es 6 → se pierden 2
    for (let i = 1; i <= 9; i++) {
      await onSubGift(client, CHANNEL, `gifter${i}`, `v${i}`, {}, { 'msg-param-origin-id': `solo-${i}` });
    }
    drain();
    assert.equal(client.said.length, 8, '1 inmediata + 6 en cola + 1 mensaje de desbordamiento');
    const overflow = client.said.at(-1);
    assert.match(overflow, /gifter2/);
    assert.match(overflow, /gifter3/);
    assert.doesNotMatch(overflow, /gifter9/);
  });

  test('los mensajes no descartables nunca se pierden', () => {
    const client = fakeClient();
    for (let i = 0; i < 20; i++) throttleSay(client, CHANNEL, `msg-${i}`);
    drain();
    assert.equal(client.said.length, 20);
  });
});
