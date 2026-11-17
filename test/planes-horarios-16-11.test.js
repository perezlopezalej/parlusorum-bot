// 16-11: a «A que jugais el finde?» el bot contestó «Este finde nos lanzamos a Elden Ring con la crew» (inventado).
// Planes, horarios y próximos juegos: plantilla fija que remite al Discord (!redes), sin IA.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const test = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const ai = require('../src/ai/handler');
const messages = require('../config/messages.json');

test('isScheduleQuestion: planes, horarios y próximos juegos', () => {
  const si = [
    'A que jugais el finde?',
    '¿A qué jugáis el finde?',
    '@Dios_Fua ¿a qué jugáis mañana?',
    'Qué jugaréis la semana que viene?',
    '¿Cuándo hay directo?',
    'cuando haceis stream?',
    '¿A qué hora empezáis?',
    '¿Cuál es el horario?',
    '¿Cuál es el próximo juego?',
    '¿Qué va a jugar Manu mañana?',
    '¿Qué vais a jugar después?',
    '¿Habrá directo el sábado?',
    'qué haréis el finde?',
    '¿Qué juego vais a jugar el lunes?',
  ];
  for (const t of si) assert.equal(quality.isScheduleQuestion(t), true, t);
});

test('isScheduleQuestion: lo que no son planes sigue por su camino', () => {
  const no = [
    '¿A qué juego estáis jugando?', // juego actual
    '¿Qué juego es?',
    '¿Cuántas muertes lleva Manu?',
    '¿Qué opinas de cómo está jugando hoy Manu?',
    '¿Qué vais a hacer con este jefe?',
    'Mañana me toca madrugar',
    'Hoy toca sufrir con este boss',
    'Hola Dios Fua',
    '¿De qué va el juego?',
    'Qué bien juega Pao',
  ];
  for (const t of no) assert.equal(quality.isScheduleQuestion(t), false, t);
});

test('las plantillas de planes remiten al Discord y a !redes, sin enlaces ni anglicismos', () => {
  const list = messages.mention_schedule;
  assert.ok(list.length >= 3);
  for (const s of list) {
    assert.match(s, /Manu y Pao/);
    assert.match(s, /Discord/);
    assert.match(s, /(?:^|\s)!redes\b/);
    assert.doesNotMatch(s, /https?:|www\./i);
    assert.equal(quality.anglicism(s), null, s);
    assert.ok(s.length <= 400, 'cabe en un mensaje de Twitch');
  }
});

test('«crew» es un anglicismo (grupo)', () => {
  assert.deepEqual(quality.anglicism('Este finde nos lanzamos a Elden Ring con la crew'), {
    word: 'crew',
    es: 'grupo',
  });
  assert.equal(quality.anglicism('El crewmate no cuenta'), null);
});

test('una mención por los planes se responde con la plantilla, sin llamar a la IA', async () => {
  const said = [];
  const client = { say: async (_c, msg) => said.push(msg), readyState: () => 'OPEN' };
  const tags = { 'user-id': '42', 'display-name': 'stewar32', username: 'stewar32', badges: {} };
  const handled = await ai.checkPatternMatch(client, '#parlusorum', tags, '@Dios_Fua A que jugais el finde?');
  assert.equal(handled, true);
  assert.equal(said.length, 1);
  assert.match(said[0], /^@stewar32 /);
  assert.ok(
    messages.mention_schedule.some((s) => said[0].endsWith(s)),
    said[0],
  );
  assert.doesNotMatch(said[0], /Elden Ring|crew/i);
});
