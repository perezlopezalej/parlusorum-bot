process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { runWithFallback, isDailyQuota, orderChain, blockModel, resetModelBlocks, stripThinking } = require('../src/utils/groq-utils');
const { recordGroqTokens, getGroqTokenUse, resetGroqTokenUse } = require('../src/utils/state');
const { formatTokenUse } = require('../src/eventsub');
const { normalizeProfile, pickExamples, buildLeanBase, buildMicroBase } = require('../src/ai/persona');
const { buildQuestionSystemContent, SPAIN_RULE, LORE_RULE } = require('../src/ai/prompts');

const quota = (msg = 'Rate limit reached: tokens per minute (TPM)', retryAfter) =>
  Object.assign(new Error(msg), { status: 429, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} });

describe('429 por cupo: pasa al siguiente modelo', () => {
  beforeEach(() => resetModelBlocks());

  test('un 429 salta al siguiente modelo sin esperar ni reintentar', async () => {
    const used = [];
    const create = async p => { used.push(p.model); if (p.model === 'a') throw quota(); return { usage: {} }; };
    const t0 = Date.now();
    await runWithFallback(create, { model: 'a' }, 2, ['b']);
    assert.deepEqual(used, ['a', 'b']);
    assert.ok(Date.now() - t0 < 500);
  });

  test('cupo diario: recorre toda la cadena', async () => {
    const used = [];
    const create = async p => { used.push(p.model); if (p.model !== 'c') throw quota('Rate limit reached for model: tokens per day (TPD)'); return {}; };
    await runWithFallback(create, { model: 'a' }, 2, ['b', 'c']);
    assert.deepEqual(used, ['a', 'b', 'c']);
  });

  test('el modelo agotado queda bloqueado y la siguiente petición empieza por otro', async () => {
    const used = [];
    const create = async p => { used.push(p.model); if (p.model === 'a') throw quota(); return {}; };
    await runWithFallback(create, { model: 'a' }, 0, ['b']);
    await runWithFallback(create, { model: 'a' }, 0, ['b']);
    assert.deepEqual(used, ['a', 'b', 'b']);
  });

  test('el último modelo sí reintenta el 429 con espera', async () => {
    let calls = 0;
    const create = async () => { calls++; throw quota('x', 1); };
    await assert.rejects(runWithFallback(create, { model: 'a' }, 1, [], 50), /x/); // espera 1 s > maxDelayMs: falla al momento
    assert.equal(calls, 1);
  });

  test('si todos dan 429 lanza el último error', async () => {
    const create = async () => { throw quota('sin cupo'); };
    await assert.rejects(runWithFallback(create, { model: 'a' }, 0, ['b']), /sin cupo/);
  });

  test('un error que no es de cupo no salta de modelo', async () => {
    const used = [];
    const create = async p => { used.push(p.model); throw Object.assign(new Error('boom'), { status: 500 }); };
    await assert.rejects(runWithFallback(create, { model: 'a' }, 0, ['b']), /boom/);
    assert.deepEqual(used, ['a']);
  });

  test('isDailyQuota distingue diario de por minuto', () => {
    assert.ok(isDailyQuota(quota('tokens per day (TPD): Limit 200000')));
    assert.ok(isDailyQuota(quota('x', 3600)));
    assert.equal(isDailyQuota(quota('tokens per minute (TPM)', 5)), false);
  });

  test('orderChain pasa los bloqueados al final y el bloqueo caduca', () => {
    blockModel('a', quota('x', 60), 1000);
    assert.deepEqual(orderChain(['a', 'b', 'c'], 2000), ['b', 'c', 'a']);
    assert.deepEqual(orderChain(['a', 'b', 'c'], 1000 + 61000), ['a', 'b', 'c']);
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
    const txt = formatTokenUse({ stream: { m1: { total: 1000, calls: 3 } }, day: { m1: { total: 50000, calls: 9 } } }, 200000);
    assert.match(txt, /m1: 1000 este stream \(3 llamadas\), 50000 hoy \(25% de 200000, quedan ~150000\)/);
    assert.match(formatTokenUse({ stream: {}, day: {} }), /sin llamadas/);
  });
});

describe('perfiles de personalidad', () => {
  const ex = [1, 2, 3, 4, 5];
  test('normalizeProfile cae a full con valores raros', () => {
    assert.equal(normalizeProfile('lean'), 'lean');
    assert.equal(normalizeProfile('x'), 'full');
  });
  test('lean conserva 3 ejemplos, micro ninguno, full todos', () => {
    assert.deepEqual(pickExamples(ex, 'lean'), [1, 2, 3]);
    assert.deepEqual(pickExamples(ex, 'micro'), []);
    assert.deepEqual(pickExamples(ex, 'full'), ex);
  });
  test('lean mantiene español de España, emotes y no inventar; sin la historia larga del FUA', () => {
    const p = buildLeanBase({ botName: 'dios_fua', streamer: 'S', creator: 'c', emotesLine: 'EMOTES-X' });
    assert.ok(p.includes(SPAIN_RULE));
    assert.match(p, /EMOTES-X/);
    assert.match(p, /NUNCA inventes datos/);
    assert.doesNotMatch(p, /Julio César Segura/);
    assert.ok(buildMicroBase({ botName: 'b', streamer: 'S' }).length < p.length / 2);
  });
  test('!dios_fua no repite lore ni español si la personalidad ya los trae', () => {
    const p = buildQuestionSystemContent({ personality: `P. ${LORE_RULE} ${SPAIN_RULE}` });
    assert.equal(p.split(LORE_RULE).length - 1, 1);
    assert.equal(p.split(SPAIN_RULE).length - 1, 1);
  });
});
