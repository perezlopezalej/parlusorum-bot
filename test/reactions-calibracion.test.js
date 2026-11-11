const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/ai/reactions');
const fixture = require('./fixtures/reacciones-etiquetadas.json');

const T0 = Date.UTC(2026, 10, 3, 20, 0, 0);
const at = s => new Date(T0 + s * 1000).toISOString();

function predict(c) {
  const bot = { created_at: at(0), username: 'dios_fua', message: c.bot, is_bot: true, origin: c.origin };
  const next = c.next.map(n => ({ created_at: at(n.s), username: n.user, message: n.text, is_bot: false }));
  const s = R.scoreReaction(bot, next, { streamer: 'parlusorum' });
  return s.negative ? 'mal' : s.positive ? 'bien' : s.reacted ? 'reaccion' : 'ignorado';
}

describe('calibración con chats etiquetados a mano', () => {
  const results = fixture.cases.map(c => ({ id: c.id, label: c.label, got: predict(c) }));
  const hits = results.filter(r => r.label === r.got).length;

  test('acierto global ≥ 80 % y ningún "bien" se da por "mal" (ni al revés)', () => {
    const wrong = results.filter(r => r.label !== r.got).map(r => `${r.id}: ${r.label}→${r.got}`);
    assert.ok(hits / results.length >= 0.8, `acierto ${(100 * hits / results.length).toFixed(0)} %; fallos: ${wrong.join(', ')}`);
    assert.ok(!results.some(r => (r.label === 'bien' && r.got === 'mal') || (r.label === 'mal' && r.got === 'bien')));
  });
  test('recall de "bien" ≥ 70 % (el fallo anterior era dar 0 bien)', () => {
    const good = results.filter(r => r.label === 'bien');
    const found = good.filter(r => r.got === 'bien').length;
    assert.ok(found / good.length >= 0.7, `${found}/${good.length}`);
  });
  test('precisión de "bien" ≥ 80 %', () => {
    const said = results.filter(r => r.got === 'bien');
    const ok = said.filter(r => r.label === 'bien').length;
    assert.ok(ok / said.length >= 0.8, `${ok}/${said.length}`);
  });
});

describe('reglas nuevas de reacción', () => {
  const bot = (msg = 'x') => ({ created_at: at(0), username: 'dios_fua', message: msg, is_bot: true, origin: 'cohost' });
  const u = (s, user, message) => ({ created_at: at(s), username: user, message, is_bot: false });
  test('una sola persona que se ríe a los 14 s basta (caso real del 10-11)', () => {
    const s = R.scoreReaction(bot(), [u(14, 'parlusorum', 'Jajajajaj Dios fua es el mejor jajajja')], { streamer: 'parlusorum' });
    assert.equal(s.positive, true);
  });
  test('la risa cuenta hasta 45 s, no después', () => {
    assert.equal(R.scoreReaction(bot(), [u(40, 'a', 'jajaja')]).positive, true);
    assert.equal(R.scoreReaction(bot(), [u(50, 'a', 'jajaja')]).positive, false);
  });
  test('una risa dirigida a otra persona no es reacción al bot', () => {
    assert.equal(R.scoreReaction(bot(), [u(27, 'a', '@b Jajajaja')]).positive, false);
  });
  test('solo el destinatario de la mención: "con reacción", no "bien"; el streamer destinatario sí cuenta', () => {
    const m = { ...bot('@x hola'), origin: 'mencion' };
    const s = R.scoreReaction(m, [u(5, 'x', 'jajaja')], { streamer: 'parlusorum' });
    assert.equal(s.positive, false);
    assert.equal(s.reacted, true);
    const m2 = { ...bot('@parlusorum hola'), origin: 'mencion' };
    assert.equal(R.scoreReaction(m2, [u(5, 'parlusorum', 'jajaja')], { streamer: 'parlusorum' }).positive, true);
  });
  test('negativas nuevas', () => {
    for (const t of ['lo ha vuelto un pesao', 'le quito el seguimiento', 'qué le pasa al bot']) assert.ok(R.isNegative(t), t);
  });
  test('el resumen lista los mensajes que gustaron y cuenta "con reacción"', () => {
    const rows = [bot('Frase buena'), u(5, 'a', 'jajaja')];
    const sum = R.summarize(R.scoreSession(rows));
    assert.equal(sum.best.length, 1);
    assert.match(R.formatSummary(sum), /Gustaron: \[cohost\] "Frase buena"/);
    assert.match(R.formatSummary(sum), /con reacción/);
  });
});
