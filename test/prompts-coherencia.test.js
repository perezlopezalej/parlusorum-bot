const { test } = require('node:test');
const assert = require('node:assert');
const { SPAIN_RULE } = require('../src/ai/prompts');
const channel = require('../config/channel.json');
const { pickExamples } = require('../src/ai/persona');

test('SPAIN_RULE no recomienda muletillas de trato', () => {
  assert.doesNotMatch(SPAIN_RULE, /\btío\b/i);
});

test('los ejemplos lean no enseñan la estructura del contador de muertes', () => {
  const lean = pickExamples(channel.personality_examples, 'lean');
  assert.equal(lean.length, 3);
  for (const e of channel.personality_examples) assert.doesNotMatch(e.good, /llevas \d+ muertes/i);
});
