process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { isDailyQuota, stripThinking } = require('../src/utils/groq-utils');
const { recordGroqTokens, getGroqTokenUse, resetGroqTokenUse } = require('../src/utils/state');
const { formatTokenUse } = require('../src/eventsub');

const quota = (msg = 'Rate limit reached: tokens per minute (TPM)', retryAfter) =>
  Object.assign(new Error(msg), { status: 429, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} });

describe('cupo de Groq', () => {
  test('isDailyQuota distingue diario de por minuto (también PerDay de Gemini)', () => {
    assert.ok(isDailyQuota(quota('tokens per day (TPD): Limit 200000')));
    assert.ok(isDailyQuota(quota('limit: 500, RequestsPerDay')));
    assert.ok(isDailyQuota(quota('x', 3600)));
    assert.equal(isDailyQuota(quota('tokens per minute (TPM)', 5)), false);
  });

  test('stripThinking quita el razonamiento visible', () => {
    const r = { choices: [{ message: { content: '<think>pienso\nmucho</think>\nHola chat' } }] };
    assert.equal(stripThinking(r).choices[0].message.content, 'Hola chat');
  });
});

describe('contador de tokens por modelo', () => {
  beforeEach(() => resetGroqTokenUse());

  test('suma prompt y completion por modelo y cuenta llamadas', () => {
    const t = Date.UTC(2026, 8, 30, 12);
    recordGroqTokens('m1', { prompt_tokens: 100, completion_tokens: 20 }, t);
    recordGroqTokens('m1', { prompt_tokens: 50, completion_tokens: 10 }, t);
    recordGroqTokens('m2', undefined, t);
    const u = getGroqTokenUse();
    assert.equal(u.stream.m1.total, 180);
    assert.equal(u.stream.m1.calls, 2);
    assert.equal(u.stream.m2.total, 0);
  });

  test('el acumulado diario sobrevive al reset del stream y cambia con el día UTC', () => {
    const d1 = Date.UTC(2026, 9, 31, 23);
    recordGroqTokens('m1', { prompt_tokens: 10, completion_tokens: 0 }, d1);
    resetGroqTokenUse();
    assert.deepEqual(getGroqTokenUse().stream, {});
    assert.equal(getGroqTokenUse().day.m1.total, 10);
    recordGroqTokens('m1', { prompt_tokens: 5, completion_tokens: 0 }, Date.UTC(2026, 10, 1, 1));
    assert.equal(getGroqTokenUse().day.m1.total, 5);
  });

  test('formatTokenUse muestra % del cupo y lo que queda', () => {
    const txt = formatTokenUse(
      { stream: { m1: { total: 1000, calls: 3 } }, day: { m1: { total: 50000, calls: 9 } } },
      200000,
    );
    assert.match(txt, /m1: 1000 este stream \(3 llamadas\), 50000 hoy \(25% de 200000, quedan ~150000\)/);
    assert.match(formatTokenUse({ stream: {}, day: {} }), /sin llamadas/);
  });
});
