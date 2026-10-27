process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runWithFallback, isModelGone, buildModelChain } = require('../src/utils/groq-utils');

const gone = () => Object.assign(new Error('404 model_not_found'), { status: 404 });

describe('cadena de modelos de reserva', () => {
  test('isModelGone detecta 404 y model_decommissioned, no otros errores', () => {
    assert.ok(isModelGone(gone()));
    assert.ok(isModelGone(new Error('The model has been decommissioned')));
    assert.equal(isModelGone(Object.assign(new Error('boom'), { status: 500 })), false);
  });

  test('buildModelChain deduplica y respeta el orden', () => {
    assert.deepEqual(buildModelChain('a', ['b', 'a', 'c']), ['a', 'b', 'c']);
  });

  test('si el primer modelo está retirado usa el siguiente', async () => {
    const used = [];
    const create = async p => { used.push(p.model); if (p.model === 'a') throw gone(); return { ok: p.model }; };
    const res = await runWithFallback(create, { model: 'a', messages: [] }, 0, ['b']);
    assert.deepEqual(used, ['a', 'b']);
    assert.equal(res.ok, 'b');
  });

  test('un error que no es de modelo retirado no salta de modelo', async () => {
    const used = [];
    const create = async p => { used.push(p.model); throw Object.assign(new Error('boom'), { status: 500 }); };
    await assert.rejects(runWithFallback(create, { model: 'a' }, 0, ['b']), /boom/);
    assert.deepEqual(used, ['a']);
  });

  test('si todos están retirados lanza el último error', async () => {
    const create = async () => { throw gone(); };
    await assert.rejects(runWithFallback(create, { model: 'a' }, 0, ['b']), /model_not_found/);
  });

  test('reasoning_effort solo se envía a modelos gpt-oss', async () => {
    const seen = {};
    const create = async p => { seen[p.model] = { ...p }; if (p.model === 'openai/gpt-oss-x') throw gone(); return {}; };
    await runWithFallback(create, { model: 'openai/gpt-oss-x', max_tokens: 100 }, 0, ['plain']);
    assert.equal(seen['openai/gpt-oss-x'].reasoning_effort, 'low');
    assert.equal(seen['openai/gpt-oss-x'].max_tokens, 164);
    assert.equal('reasoning_effort' in seen.plain, false);
    assert.equal(seen.plain.max_tokens, 100);
  });
});
