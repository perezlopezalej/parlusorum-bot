process.env.EVENTSUB_SECRET = 'secreto-de-pruebas-123';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEventSubHandler } = require('../src/eventsub');

const SECRET = process.env.EVENTSUB_SECRET;
let seq = 0;

const sign = (id, ts, body) =>
  'sha256=' + crypto.createHmac('sha256', SECRET).update(id + ts + body).digest('hex');

// Petición firmada por defecto; `over` pisa cabeceras (null/undefined = quitarla)
function makeReq({ type = 'notification', id = `msg-${++seq}`, ts = new Date().toISOString(), body, signature, over = {} } = {}) {
  const raw = body ?? JSON.stringify({ subscription: { type: 'channel.follow' }, event: { user_name: 'Pepe' } });
  const headers = {
    'twitch-eventsub-message-id': id,
    'twitch-eventsub-message-timestamp': ts,
    'twitch-eventsub-message-signature': signature ?? sign(id, ts, raw),
    'twitch-eventsub-message-type': type,
    ...over,
  };
  for (const k of Object.keys(headers)) if (headers[k] == null) delete headers[k];
  return { req: { headers }, raw };
}

function setup() {
  const said = [];
  const client = { say: (...a) => said.push(a), readyState: () => 'OPEN' };
  const handler = createEventSubHandler(client, '#canal', {});
  const res = {
    status: null, payload: null,
    writeHead(s) { this.status = s; },
    end(p) { this.payload = p; },
  };
  return { said, handler, res };
}

describe('EventSub — firma HMAC', () => {
  test('firma válida: 204 y se procesa la notificación', async () => {
    const { handler, res, said } = setup();
    const { req, raw } = makeReq();
    await handler(req, res, raw);
    assert.equal(res.status, 204);
    assert.equal(said.length, 1);
    assert.match(said[0][1], /Pepe/);
  });

  test('firma inválida: 403 y no se procesa', async () => {
    const { handler, res, said } = setup();
    const { req, raw } = makeReq({ signature: 'sha256=' + 'a'.repeat(64) });
    await handler(req, res, raw);
    assert.equal(res.status, 403);
    assert.equal(said.length, 0);
  });

  test('firma de otro secreto o cuerpo alterado: 403', async () => {
    const a = setup();
    const r1 = makeReq();
    await a.handler(r1.req, a.res, r1.raw + ' ');
    assert.equal(a.res.status, 403);

    const b = setup();
    const id = 'otro-id', ts = new Date().toISOString();
    const forged = 'sha256=' + crypto.createHmac('sha256', 'otro-secreto').update(id + ts + '{}').digest('hex');
    const r2 = makeReq({ id, ts, body: '{}', signature: forged });
    await b.handler(r2.req, b.res, r2.raw);
    assert.equal(b.res.status, 403);
  });

  test('firma con longitud distinta no lanza y da 403', async () => {
    const { handler, res } = setup();
    const { req, raw } = makeReq({ signature: 'sha256=corta' });
    await handler(req, res, raw);
    assert.equal(res.status, 403);
  });

  test('cabeceras ausentes: 403 (cada una de las tres)', async () => {
    for (const h of ['twitch-eventsub-message-id', 'twitch-eventsub-message-timestamp', 'twitch-eventsub-message-signature']) {
      const { handler, res, said } = setup();
      const { req, raw } = makeReq({ over: { [h]: null } });
      await handler(req, res, raw);
      assert.equal(res.status, 403, `sin ${h}`);
      assert.equal(said.length, 0);
    }
  });
});

describe('EventSub — antigüedad y duplicados', () => {
  test('mensaje de hace más de 10 minutos (bien firmado): 403', async () => {
    const { handler, res, said } = setup();
    const { req, raw } = makeReq({ ts: new Date(Date.now() - 10 * 60 * 1000 - 5000).toISOString() });
    await handler(req, res, raw);
    assert.equal(res.status, 403);
    assert.equal(said.length, 0);
  });

  test('timestamp con más de 10 minutos en el futuro: 403', async () => {
    const { handler, res } = setup();
    const { req, raw } = makeReq({ ts: new Date(Date.now() + 11 * 60 * 1000).toISOString() });
    await handler(req, res, raw);
    assert.equal(res.status, 403);
  });

  test('timestamp ilegible: 403', async () => {
    const { handler, res } = setup();
    const { req, raw } = makeReq({ ts: 'no-es-una-fecha' });
    await handler(req, res, raw);
    assert.equal(res.status, 403);
  });

  test('mensaje reciente (9 min) se acepta', async () => {
    const { handler, res } = setup();
    const { req, raw } = makeReq({ ts: new Date(Date.now() - 9 * 60 * 1000).toISOString() });
    await handler(req, res, raw);
    assert.equal(res.status, 204);
  });

  test('message-id duplicado: 204 pero solo se procesa una vez', async () => {
    const { handler, res, said } = setup();
    const { req, raw } = makeReq({ id: 'duplicado-1' });
    await handler(req, res, raw);
    const res2 = { ...res, status: null, writeHead(s) { this.status = s; }, end() {} };
    await handler(req, res2, raw);
    assert.equal(res.status, 204);
    assert.equal(res2.status, 204);
    assert.equal(said.length, 1, 'el duplicado no debe repetir el follow');
  });

  test('ids distintos sí se procesan por separado', async () => {
    const { handler, res, said } = setup();
    for (const id of ['distinto-a', 'distinto-b']) {
      const { req, raw } = makeReq({ id });
      await handler(req, res, raw);
    }
    assert.equal(said.length, 2);
  });
});

describe('EventSub — challenge y otros tipos', () => {
  test('webhook_callback_verification responde 200 con el challenge', async () => {
    const { handler, res } = setup();
    const body = JSON.stringify({ challenge: 'abc-123-challenge', subscription: { type: 'stream.online' } });
    const { req, raw } = makeReq({ type: 'webhook_callback_verification', body });
    await handler(req, res, raw);
    assert.equal(res.status, 200);
    assert.equal(res.payload, 'abc-123-challenge');
  });

  test('el challenge con firma inválida no se responde', async () => {
    const { handler, res } = setup();
    const body = JSON.stringify({ challenge: 'abc', subscription: { type: 'stream.online' } });
    const { req, raw } = makeReq({ type: 'webhook_callback_verification', body, signature: 'sha256=' + '0'.repeat(64) });
    await handler(req, res, raw);
    assert.equal(res.status, 403);
    assert.ok(!res.payload, "no debe devolver el challenge");
  });

  test('JSON inválido bien firmado: 400', async () => {
    const { handler, res } = setup();
    const { req, raw } = makeReq({ body: '{no es json' });
    await handler(req, res, raw);
    assert.equal(res.status, 400);
  });
});
