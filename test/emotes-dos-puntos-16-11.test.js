// 16-11: «¡vuela la guasa!:: parlus1Kelokekelowa». El modelo escribe el emote como «:emote:» y quedaban «::» sueltos.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
const test = require('node:test');
const assert = require('node:assert/strict');

const emotesLib = require('../src/ai/quality/emotes');
const { speakable } = require('../src/ai/quality/rewrite');
const { emoteLineFor } = require('../src/ai/prompt-context');

const EMOTES = ['parlus1Kelokekelowa', 'parlus1PORELPODERDELFUAAAAA', 'parlus1Alataqueel'];

test('«:emote:» al final no deja «::» y el emote queda al final', () => {
  assert.equal(
    emotesLib.applyEmotePolicy('El chat no para de reír, ¡vuela la guasa! :parlus1Kelokekelowa:', true, EMOTES),
    'El chat no para de reír, ¡vuela la guasa! parlus1Kelokekelowa',
  );
  assert.equal(
    emotesLib.applyEmotePolicy('¡Qué aventura! :parlus1PORELPODERDELFUAAAAA:', true, EMOTES),
    '¡Qué aventura! parlus1PORELPODERDELFUAAAAA',
  );
});

test('«:emote:» en medio se mueve al final sin dejar dos puntos', () => {
  assert.equal(
    emotesLib.applyEmotePolicy('¡Vaya :parlus1Alataqueel: partida, Manu!', true, EMOTES),
    '¡Vaya partida, Manu! parlus1Alataqueel',
  );
});

test('emote ya bien escrito: sin cambios', () => {
  assert.equal(
    emotesLib.applyEmotePolicy('¡Qué aventura! parlus1PORELPODERDELFUAAAAA', true, EMOTES),
    '¡Qué aventura! parlus1PORELPODERDELFUAAAAA',
  );
});

test('sin permiso de emote: se quita sin dejar restos', () => {
  assert.equal(emotesLib.applyEmotePolicy('¡Qué aventura! :parlus1Alataqueel:', false, EMOTES), '¡Qué aventura!');
  assert.equal(emotesLib.stripEmotes('Hola :parlus1Kelokekelowa: chat', EMOTES), 'Hola chat');
});

test('las horas y los dos puntos normales no se tocan', () => {
  assert.equal(
    emotesLib.applyEmotePolicy('Quedamos a las 12:30: ¡vamos! parlus1Kelokekelowa', true, EMOTES),
    'Quedamos a las 12:30: ¡vamos! parlus1Kelokekelowa',
  );
});

test('speakable limpia signos sueltos tras ! o ? delante de un emote (respaldo) y respeta URLs y horas', () => {
  assert.equal(
    speakable('El chat no para de reír, ¡vuela la guasa!:: parlus1Kelokekelowa'),
    'El chat no para de reír, ¡vuela la guasa! parlus1Kelokekelowa',
  );
  assert.equal(speakable('¡Qué aventura!:: parlus1PORELPODERDELFUAAAAA'), '¡Qué aventura! parlus1PORELPODERDELFUAAAAA');
  assert.equal(speakable('A las 12:30 empezamos'), 'A las 12:30 empezamos');
});

test('el prompt muestra el formato del emote con un ejemplo', () => {
  const line = emoteLineFor(true, EMOTES, []);
  assert.match(line, /nombre exacto, solo, al final/);
  assert.match(line, /¡Vaya partida! parlus1Kelokekelowa/);
  assert.equal(emoteLineFor(false, EMOTES, []), 'Escribe solo texto.');
});
