// 15-11: el cohost preguntó «¿te pierdes en el mapa o en el sofá?», Pao respondió «En los dos» y el bot contestó
// «¿Los dos qué, Pao?». La mención recibe la pregunta del bot (hilo o última pregunta reciente) y no la devuelve.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { botQuestionFor } = require('../src/ai/patterns');
const { buildMentionSystem } = require('../src/ai/style');

const NOW = Date.parse('2026-11-15T15:11:27Z');
const Q = 'Manu, ¿te pierdes en el mapa o en el sofá?';
const BOT = ['dios_fua'];

describe('botQuestionFor', () => {
  test('la última pregunta del bot de los últimos 5 minutos', () => {
    const history = [
      { msg: 'Dos horas de directo y ya me siento una deidad agotada.', ts: NOW - 4 * 60000 },
      { msg: Q, ts: NOW - 15000 },
    ];
    assert.equal(botQuestionFor({}, history, { botNames: BOT, now: NOW }), Q);
  });
  test('sin pregunta reciente no hay contexto', () => {
    assert.equal(botQuestionFor({}, [{ msg: Q, ts: NOW - 6 * 60000 }], { botNames: BOT, now: NOW }), '');
    assert.equal(
      botQuestionFor({}, [{ msg: 'Manu ya está en el mapa.', ts: NOW - 1000 }], { botNames: BOT, now: NOW }),
      '',
    );
  });
  test('en hilo a un mensaje del bot, ese mensaje aunque no sea pregunta; en hilo a otro usuario, no', () => {
    const tags = { 'reply-parent-user-login': 'dios_fua', 'reply-parent-msg-body': 'Manu ya está en el mapa.' };
    assert.equal(botQuestionFor(tags, [], { botNames: BOT, now: NOW }), 'Manu ya está en el mapa.');
    const other = { 'reply-parent-user-login': 'pepe', 'reply-parent-msg-body': '¿Qué tal?' };
    assert.equal(botQuestionFor(other, [], { botNames: BOT, now: NOW }), '');
  });
});

describe('reasksAnswer y la regla repregunta', () => {
  test('devolver la pregunta al usuario se reconoce', () => {
    assert.ok(quality.reasksAnswer('¿Los dos qué, Pao? ¿Dos caídas o dos victorias?', 'En los dos'));
    assert.ok(quality.reasksAnswer('¿A qué te refieres con eso?', 'En los dos'));
    assert.ok(quality.reasksAnswer('No te pillo, ¿qué quieres decir?', 'En los dos'));
  });
  test('reaccionar a la respuesta pasa', () => {
    assert.ok(!quality.reasksAnswer('Perderse en el sofá es de maestros, Pao. ¡FUA!', 'En los dos'));
    assert.ok(!quality.reasksAnswer('¿Y el mando también se pierde o solo tú?', 'En los dos'));
    assert.ok(!quality.reasksAnswer('Pues menuda combinación', ''));
  });
  test('validateMention rechaza la repregunta solo si había pregunta del bot', () => {
    const text = '¿Los dos qué, Pao? ¿Dos caídas o dos victorias? El FUA dice que lo que sea, será épico.';
    const r = quality.validateMention(text, { question: 'En los dos', names: ['ParLusorum'], botQuestion: Q });
    assert.equal(r.ok, false);
    assert.equal(r.rule, 'repregunta');
    assert.equal(quality.validateMention(text, { question: 'En los dos', names: ['ParLusorum'] }).ok, true);
    assert.equal(
      quality.validateMention('Perderse en el sofá es de maestros, Pao.', {
        question: 'En los dos',
        names: ['ParLusorum'],
        botQuestion: Q,
      }).ok,
      true,
    );
  });
});

describe('prompt de la mención con la pregunta del bot', () => {
  test('lleva el bloque <tu_pregunta> solo cuando hay pregunta', () => {
    const sys = buildMentionSystem({ botQuestion: Q });
    assert.match(sys, /<tu_pregunta>/);
    assert.ok(sys.includes(Q));
    assert.doesNotMatch(buildMentionSystem({}), /<tu_pregunta>/);
  });
});
