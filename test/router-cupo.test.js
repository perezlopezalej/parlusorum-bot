process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const { parseDurationMs, parseRateHeaders } = require('../src/utils/groq-utils');
const { formatFilterStats } = require('../src/eventsub');

const ok = () => ({ choices: [{ message: { content: 'hola' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const quota = (msg = 'tokens per minute (TPM)', retryAfter) =>
  Object.assign(new Error(msg), { status: 429, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} });
const ask = (kind) => router.aiChat(kind, { max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
let calls;
const fake = (handler) =>
  router.setTransport('groq', async (p, o) => {
    calls.push(p.model);
    return handler(p, o);
  });
beforeEach(() => {
  calls = [];
  state.resetAiBlocks();
  state.resetAiUsage();
  state.resetChatters();
  state.resetGroqFallbackUse();
  state.resetGroqLimits();
  state.resetFilterStats();
});

describe('cabeceras x-ratelimit de Groq', () => {
  test('parseDurationMs entiende los formatos de Groq', () => {
    assert.equal(parseDurationMs('7.66s'), 7660);
    assert.equal(parseDurationMs('2m59.56s'), 179560);
    assert.equal(parseDurationMs('1h2m'), 3720000);
    assert.equal(parseDurationMs('120ms'), 120);
    assert.equal(parseDurationMs('5'), 5000);
    assert.equal(parseDurationMs('nada'), null);
    assert.equal(parseDurationMs(undefined), null);
  });
  test('parseRateHeaders con objeto plano y con Headers', () => {
    const raw = {
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '999',
      'x-ratelimit-remaining-tokens': '7500',
      'x-ratelimit-reset-tokens': '7.66s',
      'x-ratelimit-reset-requests': '2m59.56s',
    };
    const a = parseRateHeaders(raw);
    assert.equal(a.remainingTokens, 7500);
    assert.equal(a.resetTokensMs, 7660);
    assert.equal(a.limitRequests, 1000);
    assert.deepEqual(parseRateHeaders(new Headers(raw)), a);
    assert.equal(parseRateHeaders({}), null);
    assert.equal(parseRateHeaders(null), null);
  });
  test('el cupo real vigente hace saltar el modelo antes del 429 y caduca con su reposición', () => {
    const l = { key: 'groq:m' };
    const t = 1_000_000;
    state.noteGroqLimits('groq:m', { remainingTokens: 50, resetTokensMs: 8000 }, t);
    assert.equal(router.overBudget(l, 200, t + 1000), true);
    assert.equal(router.overBudget(l, 20, t + 1000), false);
    assert.equal(router.overBudget(l, 200, t + 9000), false, 'pasada la reposición ya no cuenta');
    state.noteGroqLimits('groq:m', { remainingRequests: 0, resetRequestsMs: 60000 }, t);
    assert.equal(router.overBudget(l, 1, t + 1000), true);
  });
  test('las cabeceras de cada respuesta llegan al estado mediante el transporte', async () => {
    router.setTransport('groq', async (p, o) => {
      o.onHeaders({ 'x-ratelimit-remaining-tokens': '123', 'x-ratelimit-reset-tokens': '5s' });
      return ok();
    });
    await ask('mention');
    assert.equal(state.getGroqLimits('groq:openai/gpt-oss-20b').remainingTokens, 123);
  });
});

describe('espera con aleatoriedad ante 429', () => {
  test('backoffMs respeta retry-after, añade jitter y se acota', () => {
    assert.equal(
      router.backoffMs(0, quota('x', 3), () => 0),
      3000,
    );
    assert.equal(
      router.backoffMs(0, quota('x', 3), () => 1),
      3500,
    );
    assert.equal(
      router.backoffMs(0, quota(), () => 0),
      500,
    );
    assert.equal(
      router.backoffMs(0, quota(), () => 1),
      1000,
    );
    assert.equal(
      router.backoffMs(10, quota(), () => 0),
      4000,
    );
    assert.equal(
      router.backoffMs(10, quota(), () => 1),
      8000,
    );
    for (let i = 0; i < 50; i++) {
      const d = router.backoffMs(2, quota());
      assert.ok(d >= 2000 && d <= 4000, String(d));
    }
  });
});

describe('callar si no hay cupo (solo lo espontáneo)', () => {
  test('cohost con 429 en el 120b no baja al 20b ni espera; luego ni llama', async () => {
    fake(() => {
      throw quota();
    });
    await assert.rejects(ask('cohost'), (e) => e.status === 429);
    assert.equal(calls.length, 1, 'un solo intento, sin modelos de reserva ni espera');
    await assert.rejects(ask('cohost'), (e) => e.code === 'NO_QUOTA');
    assert.equal(calls.length, 1, 'bloqueado: ya ni llama');
  });
  test('timer, hook y quemeperdi también callan; !dios_fua y menciones conservan reservas', async () => {
    for (const k of ['timer', 'hook', 'quemeperdi']) assert.ok(router.SILENT_KINDS.has(k), k);
    for (const k of ['diosfua', 'mention', 'provocation', 'command', 'alert'])
      assert.ok(!router.SILENT_KINDS.has(k), k);
    fake((p) => {
      if (/20b/.test(p.model)) throw quota();
      return ok();
    });
    const r = await ask('mention');
    assert.equal(r.choices[0].message.content, 'hola');
    assert.ok(calls.length >= 2, 'la mención pasó a un modelo de reserva');
  });
  test('sin presupuesto según las cabeceras reales, el cohost calla sin llamar', async () => {
    fake(() => ok());
    state.noteGroqLimits('groq:openai/gpt-oss-120b', { remainingTokens: 10, resetTokensMs: 60000 });
    await assert.rejects(ask('cohost'), (e) => e.code === 'NO_QUOTA');
    assert.equal(calls.length, 0);
  });
  test('un modelo retirado (404) sí pasa al siguiente aunque sea espontáneo', async () => {
    fake((p) => {
      if (/120b/.test(p.model)) throw Object.assign(new Error('404 model_not_found'), { status: 404 });
      return ok();
    });
    const r = await ask('cohost');
    assert.equal(r.choices[0].message.content, 'hola');
  });
});

describe('tasa de descarte por filtro', () => {
  test('cuenta descartes por motivo frente a enviados y excluye los que no son filtro', () => {
    state.recordCohostDiscard('quality:repeticion');
    state.recordCohostDiscard('selector');
    state.recordCohostDiscard('selector');
    state.recordCohostDiscard('silencio');
    state.recordCohostDiscard('sin_cupo');
    state.recordCohostSent('free');
    state.recordFilterSent('salida');
    const s = state.getFilterStats();
    assert.equal(s.cohost.discarded, 3);
    assert.equal(s.cohost.sent, 1);
    assert.deepEqual(s.cohost.reasons, { repeticion: 1, selector: 2 });
    const txt = formatFilterStats(s);
    assert.match(txt, /cohost 3\/4 \(75 %\) \[selector 2, repeticion 1\]/);
    assert.match(txt, /salida 0\/1 \(0 %\)/);
  });
  test('sin datos no rompe', () => {
    assert.match(formatFilterStats({}), /sin mensajes/);
  });
});
