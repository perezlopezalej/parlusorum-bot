const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/ai/reactions');
const { flagMessages } = require('../src/ai/self-review');
const { buildRow } = require('../src/utils/chatlog');

const T0 = Date.UTC(2026, 9, 30, 20, 0, 0);
const row = (s, username, message, extra = {}) => ({ created_at: new Date(T0 + s * 1000).toISOString(), username, message, is_bot: false, origin: null, reply_parent_login: null, ...extra });
const bot = (s, origin, message) => row(s, 'dios_fua', message, { is_bot: true, origin });

describe('detección', () => {
  test('risas y negativas del chat real', () => {
    assert.ok(R.isLaugh('Jajajaja jajajaja'));
    assert.ok(R.isLaugh('MaxLOL MaxLOL'));
    assert.ok(!R.isLaugh('Que tal vas pao'));
    assert.ok(R.isNegative('Que dice este ahora...?'));
    assert.ok(R.isNegative('Digo el fua que salta con algo qiw no viene al caso'));
    assert.ok(R.isNegative('Ya está liaoo el bot?'));
    assert.ok(!R.isNegative('Qué decepción dios fua'));
  });
  test('addresseeOf', () => {
    assert.equal(R.addresseeOf('@Gangar79 ¡Hola!'), 'gangar79');
    assert.equal(R.addresseeOf('Sin destinatario'), null);
  });
});

describe('scoreReaction', () => {
  test('cohost con dos personas que se ríen deprisa: positivo', () => {
    const rows = [bot(0, 'cohost', 'Frase'), row(5, 'a', 'jajaja'), row(12, 'b', 'kekw')];
    const s = R.scoreReaction(rows[0], rows.slice(1));
    assert.equal(s.positive, true);
    assert.equal(s.ignored, false);
  });
  test('cohost "sueco": negativo aunque haya risa', () => {
    const rows = [bot(0, 'cohost', 'Sueco de la diversión'), row(20, 'markos', 'Que dice este ahora...?'), row(25, 'b', 'jajaja')];
    const s = R.scoreReaction(rows[0], rows.slice(1));
    assert.equal(s.negative, true);
    assert.equal(s.positive, false);
  });
  test('mención: solo se ríe el destinatario → no es positivo', () => {
    const rows = [bot(0, 'mencion', '@gangar79 una buena cola'), row(4, 'gangar79', 'Jajajaja'), row(9, 'gangar79', 'jajaja')];
    const s = R.scoreReaction(rows[0], rows.slice(1));
    assert.equal(s.positive, false);
    assert.equal(s.ignored, false); // el destinatario contestó
  });
  test('responder al bot o nombrarlo cuenta aunque no haya risa', () => {
    const rows = [bot(0, 'cohost', 'x'), row(30, 'a', 'vale', { reply_parent_login: 'dios_fua' }), row(40, 'b', 'dios fua eres un crack')];
    assert.equal(R.scoreReaction(rows[0], rows.slice(1)).positive, true);
  });
  test('sin nadie en 60 s: ignorado; fuera de ventana no cuenta', () => {
    const rows = [bot(0, 'hook', 'Pregunta'), row(90, 'a', 'jajaja')];
    const s = R.scoreReaction(rows[0], rows.slice(1));
    assert.equal(s.ignored, true);
    assert.equal(s.positive, false);
  });
  test('la risa de base se resta de la puntuación', () => {
    const rows = [bot(0, 'cohost', 'x'), row(40, 'a', 'jajaja'), row(45, 'b', 'jajaja')];
    const sin = R.scoreReaction(rows[0], rows.slice(1), { baseline: 0 });
    const con = R.scoreReaction(rows[0], rows.slice(1), { baseline: 2 });
    assert.ok(con.score < sin.score);
  });
});

describe('scoreSession', () => {
  test('puntúa solo mensajes IA, no timers ni comandos', () => {
    const rows = [bot(0, 'timer', 'Dale follow'), bot(5, 'comando', 'Muerte #1'), bot(10, 'cohost', 'x'), row(15, 'a', 'jajaja')];
    const { scored } = R.scoreSession(rows);
    assert.equal(scored.length, 1);
    assert.equal(scored[0].row.origin, 'cohost');
  });
  test('baseline y resumen', () => {
    const rows = [row(0, 'a', 'jajaja'), row(30, 'b', 'jajaja'), row(120, 'a', 'hola'), bot(125, 'mencion', '@a hola')];
    const out = R.scoreSession(rows);
    assert.ok(out.baseline > 0);
    const sum = R.summarize(out);
    assert.equal(sum.total, 1);
    assert.equal(sum.byOrigin.mencion.sent, 1);
    assert.ok(R.formatSummary(sum).includes('Reacciones'));
  });
  test('sin filas no rompe', () => {
    assert.deepEqual(R.scoreSession([]).scored, []);
    assert.equal(R.chatBaseline([]), 0);
  });
});

describe('flagMessages', () => {
  test('marca repetición, inventos del juego, negativos e ignorados', () => {
    const rows = [
      bot(0, 'timer_ia', 'El combo de la espada larga baja la resistencia del jefe'),
      bot(200, 'cohost', 'Con ese flow de harocho el FUA se siente muchísimo'),
      row(215, 'a', 'Que dice este'),
      bot(400, 'cohost', 'Con ese flow de harocho el FUA se siente muchísimo'),
      bot(600, 'hook', 'Pregunta sin respuesta'),
    ];
    const flagged = flagMessages(R.scoreSession(rows).scored);
    const reasons = flagged.flatMap(f => f.reasons).join(' ');
    assert.match(reasons, /dato inventado/);
    assert.match(reasons, /negativa/);
    assert.match(reasons, /repetición/);
    assert.match(reasons, /ignorado/);
  });
});

describe('chat_log: reply_parent_login', () => {
  test('buildRow guarda el destinatario en minúsculas solo en mensajes de usuario', () => {
    assert.equal(buildRow({ username: 'a', message: 'x', replyTo: 'Dios_Fua' }).reply_parent_login, 'dios_fua');
    assert.equal(buildRow({ username: 'a', message: 'x' }).reply_parent_login, null);
    assert.equal(buildRow({ username: 'b', message: 'x', isBot: true, replyTo: 'z' }).reply_parent_login, null);
  });
});
