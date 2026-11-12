// Directo del 11-11: «¡A seguir con la partida! 🚀» tres veces seguidas a stewar32, el mismo emote al cierre y «si tuvieras cuerpo» devuelto.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { classifyMessage } = require('../src/ai/patterns');
const { buildMentionSystem } = require('../src/ai/style');
const { renderMemory } = require('../src/memory/handler');

const A1 =
  '@stewar32 ¡49 metros, eh! Si no corriste, al menos el FUA te da la motivación. ¡A por la próxima, que el FUA no se queda quieto! 🚀 FUA.';
const A2 =
  '@stewar32 ¡Ay, 49 minutos! Si no corriste, al menos el FUA te anima a seguir. ¡A seguir la partida, que el FUA no se queda sin ritmo! 🚀';
const A3 = '@stewar32 ¡Vale, vale! No te preocupes, el FUA siempre está a tu lado. ¡A seguir con la partida! 🚀';

describe('coletillas', () => {
  test('la coletilla es la última frase exclamativa de un mensaje con varias frases', () => {
    assert.equal(quality.closingMark(A3), 'c:a seguir con la partida');
    assert.ok(quality.closingMark(A2).startsWith('c:a seguir la partida'));
    assert.equal(
      quality.closingMark('¡Una caída y seguimos a tope, Manu no se rinde!'),
      '',
      'una sola frase no tiene coletilla',
    );
    assert.equal(quality.closingMark('Manu cae otra vez. ¡FUA!'), '', 'demasiado corta');
  });

  test('se detecta aunque cambie la redacción', () => {
    assert.ok(quality.repeatsClosing(A3, [A2]));
    assert.ok(!quality.repeatsClosing(A1, [A3]));
    assert.ok(!quality.repeatsClosing('Hoy no hay jefe que valga. ¡Ánimo, Manu, que se puede!', [A3]));
  });

  test('una vez por stream: repeatedInStream y el cohost lo rechazan', () => {
    const used = new Set(quality.streamMarks(A3));
    assert.ok(used.has('c:a seguir con la partida'));
    assert.match(quality.repeatedInStream('Otra caída más. ¡A seguir con la partida, Manu!', used), /coletilla/);
    assert.equal(quality.repeatedInStream('Otra caída más. ¡Ánimo, Manu, que ya casi sale!', used), '');
    const verdict = quality.validateCohost('Otra caída más y el chat anima. ¡A seguir con la partida, Manu!', {
      usedStructures: used,
      deathCount: 3,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.rule, 'repetido');
  });
});

describe('emote y emoji de cierre', () => {
  const emotes = ['parlus1Alataqueel', 'parlus1PORELPODERDELFUAAAAA'];

  test('el mismo emote o emoji de cierre no se repite en los últimos mensajes', () => {
    const recent = ['Una caída y seguimos. parlus1Alataqueel', 'Manu aguanta, ¡FUA!'];
    assert.equal(quality.dropRepeatedTail('Otra más. parlus1Alataqueel', recent, emotes), 'Otra más.');
    assert.equal(
      quality.dropRepeatedTail('Otra más. parlus1PORELPODERDELFUAAAAA', recent, emotes),
      'Otra más. parlus1PORELPODERDELFUAAAAA',
    );
    assert.equal(quality.dropRepeatedTail('¡Vamos! 🚀', ['¡A seguir! 🚀'], emotes), '¡Vamos!');
    assert.equal(quality.dropRepeatedTail('¡Vamos! 🚀', ['¡A seguir! 🚀'], emotes, 0), '¡Vamos! 🚀');
  });

  test('applyEmotePolicy lo aplica con recent y sigue igual sin él', () => {
    const recent = ['Hola. parlus1Alataqueel', 'Adiós.'];
    assert.equal(quality.applyEmotePolicy('Otra más. parlus1Alataqueel', true, emotes, recent), 'Otra más.');
    assert.equal(quality.applyEmotePolicy('Otra más. parlus1Alataqueel', true, emotes), 'Otra más. parlus1Alataqueel');
    assert.equal(quality.applyEmotePolicy('Otra más. parlus1Alataqueel', false, emotes, recent), 'Otra más.');
  });

  test('freshEmotes ofrece solo los que no han cerrado los últimos mensajes', () => {
    assert.deepEqual(quality.freshEmotes(emotes, ['Hola. parlus1Alataqueel']), ['parlus1PORELPODERDELFUAAAAA']);
    assert.deepEqual(quality.freshEmotes(emotes, ['a parlus1Alataqueel', 'b parlus1PORELPODERDELFUAAAAA']), emotes);
    assert.deepEqual(quality.freshEmotes(emotes, []), emotes);
  });
});

describe('menciones', () => {
  test('misma estructura que la respuesta anterior al usuario: se rechaza', () => {
    const verdict = quality.validateMention(A3, { names: ['stewar32'], recentToUser: [A2] });
    assert.equal(verdict.ok, false);
    assert.ok(['repetido', 'cierre'].includes(verdict.rule), verdict.rule);
  });

  test('coletilla ya usada en el stream: se rechaza aunque no sea con el mismo usuario', () => {
    const verdict = quality.validateMention('@ana Tranquila, que el FUA te cubre. ¡A seguir con la partida!', {
      names: ['ana'],
      usedStructures: new Set(['c:a seguir con la partida']),
    });
    assert.equal(verdict.rule, 'cierre');
    assert.equal(
      quality.validateMention('@ana Tranquila, que el FUA te cubre. ¡Ánimo con ese jefe!', {
        names: ['ana'],
        usedStructures: new Set(['c:a seguir con la partida']),
      }).ok,
      true,
    );
  });

  test('devolver al usuario su «si tuvieras…» es un espejo', () => {
    const q = 'Dios fua si tuvieras cuerpo te meto un puño';
    assert.ok(quality.mirrorsUser('Si tuvieras cuerpo, yo también te meto un puño…', q));
    assert.ok(!quality.mirrorsUser('Cuerpo no tengo, pero FUA me sobra.', q));
    assert.ok(!quality.mirrorsUser('Si tuvieras cuerpo, ¡qué miedo!', 'dios fua qué tal'));
    assert.equal(
      quality.validateMention('Si tuvieras cuerpo, yo también te meto un puño…', { question: q }).rule,
      'espejo',
    );
  });

  test('una amenaza física al bot es una provocación', () => {
    const bot = { botNames: ['dios_fua'] };
    for (const m of [
      'Dios fua si tuvieras cuerpo te meto un puño',
      'dios fua te parto la cara',
      'dios_fua te doy una paliza',
    ])
      assert.equal(classifyMessage(m, {}, bot), 'provocation', m);
  });

  test('el prompt lleva el último mensaje del bot y la regla de seguir la broma', () => {
    const sys = buildMentionSystem({ lastBot: 'Llevamos 49 minutos de stream' });
    assert.match(sys, /<tu_ultimo_mensaje>Llevamos 49 minutos de stream<\/tu_ultimo_mensaje>/);
    assert.match(sys, /juega con una palabra de <tu_ultimo_mensaje>/);
    assert.doesNotMatch(buildMentionSystem({}), /<\/tu_ultimo_mensaje>/);
  });
});

describe('memoria del último stream', () => {
  const rows = [
    {
      stream_date: '2026-11-10',
      game: 'Hell Is Us',
      summary: 'Tarde de exploración en la abadía.',
      highlights: [],
      recurring_phrases: [],
    },
    {
      stream_date: '2026-11-09',
      game: 'Shadow of the Colossus',
      summary: 'Primer coloso caído.',
      highlights: [],
      recurring_phrases: [],
    },
  ];

  test('con juego actual solo entran streams del mismo juego', () => {
    assert.equal(renderMemory(rows, { plain: true, game: 'Shadow of the Colossus' }).includes('abadía'), false);
    assert.match(renderMemory(rows, { plain: true, game: 'shadow of the colossus' }), /Primer coloso/);
    assert.equal(renderMemory(rows, { plain: true, game: 'Elden Ring' }), '');
  });

  test('sin juego actual no filtra', () => {
    assert.match(renderMemory(rows, { plain: true, maxStreams: 2 }), /abadía/);
  });
});
