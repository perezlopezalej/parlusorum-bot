// 17-11: «Ojo, @stewar32 vuelve a regalarle una sub a @gangar79. Ya era hora de que repasara sus deberes como habitual.»
// Nada decía que fuera otra vez ni pedía deberes a nadie: el dato «es habitual» de quien regala se mezclaba con el receptor.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { buildSubContext } = require('../src/alerts/sub-context');
const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const { onSubGift, onResub } = require('../src/alerts/handler');

const REAL =
  'Ojo, @stewar32 vuelve a regalarle una sub a @gangar79. Ya era hora de que repasara sus deberes como habitual. Así se cuida a los propios, ¡FUA!';

describe('claimsRepeat', () => {
  test('la frase real del 17-11 y sus variantes se detectan', () => {
    assert.ok(q.claimsRepeat(REAL));
    for (const t of [
      '@a regala otra vez una sub a @b, ¡gracias!',
      '@a le regala de nuevo una sub a @b.',
      '@a vuelve a regalar y el chat lo celebra.',
      'Ya era hora, @b, de tener tu sub.',
      '@b, repasa tus deberes con esta sub de @a.',
    ])
      assert.ok(q.claimsRepeat(t), t);
  });
  test('un agradecimiento normal no se marca', () => {
    for (const t of [
      '¡@stewar32 le regala una sub a @gangar79! Gracias por el detalle, ¡FUA!',
      '@gangar79 recibe una sub cortesía de @stewar32 💜',
      'Bienvenido a la familia, @gangar79, gracias a @stewar32.',
    ])
      assert.equal(q.claimsRepeat(t), '', t);
  });
});

describe('buildSubContext en regalos', () => {
  const facts = [{ fact_type: 'is_regular', value: 'true' }];
  test('«es habitual» solo entra en subs y resubs, no en regalos', () => {
    assert.match(buildSubContext('stewar32', facts, { rng: () => 0 }), /habitual/);
    assert.equal(buildSubContext('stewar32', facts, { rng: () => 0, gift: true }), '');
  });
  test('en regalos siguen valiendo apodo, chiste y trivias', () => {
    assert.match(buildSubContext('a', [], { nickname: 'El Jefe', gift: true }), /El Jefe/);
    assert.match(buildSubContext('a', [{ fact_type: 'trivia_wins', value: '4' }], { gift: true }), /4 trivias/);
  });
});

describe('alerta de sub regalada con IA', () => {
  const said = [];
  const client = { say: (ch, msg) => said.push(msg) };
  let reply;
  beforeEach(() => {
    said.length = 0;
    state.resetAiUsage();
    router.setTransport('groq', async () => ({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }));
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => mock.timers.reset());
  const drain = () => {
    for (let i = 0; i < 30; i++) mock.timers.tick(1600);
  };

  test('si la IA afirma «vuelve a regalar» o pide deberes, sale el texto fijo', async () => {
    reply = REAL;
    await onSubGift(client, '#parlusorum', 'stewar32', 'gangar79', {}, { 'msg-param-origin-id': 'x17' });
    drain();
    assert.equal(said.length, 1);
    assert.doesNotMatch(said[0], /vuelve|deberes|era hora/i);
    assert.match(said[0], /stewar32/);
    assert.match(said[0], /gangar79/);
  });

  test('un agradecimiento limpio de la IA se envía tal cual', async () => {
    reply = '¡@stewar32 le regala una sub a @gangar79! Gracias por el detalle, ¡FUA!';
    await onSubGift(client, '#parlusorum', 'stewar32', 'gangar79', {}, { 'msg-param-origin-id': 'y17' });
    drain();
    assert.equal(said.length, 1);
    assert.match(said[0], /Gracias por el detalle/);
  });

  test('en una resub «vuelve» no se descarta (la renovación sí es repetir)', async () => {
    reply = '¡@ana vuelve a renovar y ya van 6 meses! Gracias, ¡FUA!';
    await onResub(client, '#parlusorum', 'ana', 6, {}, '');
    drain();
    assert.equal(said.length, 1);
    assert.match(said[0], /vuelve a renovar/);
  });
});
