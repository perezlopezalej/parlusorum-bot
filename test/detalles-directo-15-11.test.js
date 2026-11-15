// Detalles del directo del 15-11: «partirse», género del título, lo que hace el chat, lugares, coletilla del FUA y alertas.
const test = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');

const GAME = 'Horizon Forbidden West';

test('partirWithoutSe: «no para de partir» falla; «partirse» y «a partir de» pasan', () => {
  assert.equal(quality.partirWithoutSe('El chat no para de partir con esa caída.'), true);
  assert.equal(quality.partirWithoutSe('Los Lusorums no paran de partir y Manu sigue.'), true);
  assert.equal(quality.partirWithoutSe('El chat no para de partirse con la caída.'), false);
  assert.equal(quality.partirWithoutSe('El chat se parte con Manu.'), false);
  assert.equal(quality.partirWithoutSe('A partir de ahora, sin red.'), false);
  assert.equal(quality.partirWithoutSe('Están partiendo de cero.'), false);
});

test('styleProblem recoge la regla partir', () => {
  const p = quality.styleProblem('El chat no para de partir con Manu.');
  assert.equal(p?.rule, 'partir');
});

test('genderedGameTitle: «esa Horizon Forbidden West» falla; «el juego» y el título solo pasan', () => {
  assert.equal(
    quality.genderedGameTitle('Manu sigue en esa Horizon Forbidden West.', GAME),
    'esa horizon forbidden west',
  );
  assert.equal(quality.genderedGameTitle('Otra vez la Horizon Forbidden West.', GAME) !== '', true);
  assert.equal(quality.genderedGameTitle('Manu sigue en Horizon Forbidden West.', GAME), '');
  assert.equal(quality.genderedGameTitle('Manu sigue en el Horizon Forbidden West.', GAME), '');
  assert.equal(quality.genderedGameTitle('Esa caída fue épica.', GAME), '');
  assert.equal(quality.genderedGameTitle('Hola', ''), '');
});

test('validateCohost y vetAuto rechazan el título en femenino y la abreviatura', () => {
  const gendered = quality.validateCohost('Manu sigue perdido en esa Horizon Forbidden West.', { game: GAME });
  assert.equal(gendered.ok, false);
  assert.equal(gendered.rule, 'juego_nombre');
  assert.throws(() => quality.vetAuto('¡Bienvenido a Horizon, {usuario}!', { game: GAME }), /descartado/);
  assert.throws(() => quality.vetAuto('¡Bienvenido a esa Horizon Forbidden West!', { game: GAME }), /descartado/);
  assert.equal(
    quality.vetAuto('¡Bienvenido a Horizon Forbidden West, {usuario}!', { game: GAME }),
    '¡Bienvenido a Horizon Forbidden West, {usuario}!',
  );
  // sin juego no se comprueba el título
  assert.equal(quality.vetAuto('¡Bienvenido al canal, {usuario}!'), '¡Bienvenido al canal, {usuario}!');
});

test('claimsChatActivity: detecta lo que hace el chat', () => {
  assert.equal(quality.claimsChatActivity('El chat no para de gritar FUA.'), true);
  assert.equal(quality.claimsChatActivity('Los Lusorums se parten con la caída.'), true);
  assert.equal(quality.claimsChatActivity('El chat está pidiendo otra vida.'), true);
  assert.equal(quality.claimsChatActivity('Manu se cae y el FUA lo mira.'), false);
  assert.equal(quality.claimsChatActivity('¿Qué opina el chat de esta zona?'), false);
});

test('validateCohost: lo que hace el chat solo vale con un hecho de chat', () => {
  const sinChat = [{ id: 'h1', tipo: 'estado', texto: 'Manu juega Horizon Forbidden West', claves: ['manu'] }];
  const conChat = [...sinChat, { id: 'h2', tipo: 'chat', texto: 'El chat está animando a Manu', claves: ['chat'] }];
  const text = 'El chat no para de gritar FUA mientras Manu avanza.';
  const bad = quality.validateCohost(text, { facts: sinChat, hecho: 'h1', game: GAME });
  assert.equal(bad.ok, false);
  assert.equal(bad.rule, 'chat');
  assert.notEqual(quality.validateCohost(text, { facts: conChat, hecho: 'h1', game: GAME }).rule, 'chat');
});

test('unlistedPlace: un lugar que no sale de los datos se detecta; si sale, no', () => {
  assert.equal(quality.unlistedPlace('Manu cruza el desierto con calma.', ['Manu juega Horizon']), 'desierto');
  assert.equal(quality.unlistedPlace('Manu cruza el desierto con calma.', ['Hay un Desierto de fuego en el mapa']), '');
  assert.equal(quality.unlistedPlace('Las montañas no perdonan.', ['Manu juega']), 'montañas');
  assert.equal(quality.unlistedPlace('Manu sigue con su partida.', []), '');
});

test('validateCohost: la regla de lugares solo descarta con placeRule activa (modo sombra por defecto)', () => {
  const facts = [{ id: 'h1', tipo: 'estado', texto: 'Manu juega Horizon Forbidden West', claves: ['manu'] }];
  const text = 'Manu cruza el desierto sin mirar atrás.';
  const base = { facts, hecho: 'h1', game: GAME };
  assert.notEqual(quality.validateCohost(text, base).rule, 'lugar');
  const on = quality.validateCohost(text, { ...base, placeRule: true });
  assert.equal(on.ok, false);
  assert.equal(on.rule, 'lugar');
  assert.notEqual(
    quality.validateCohost(text, { ...base, placeRule: true, placeAllowed: ['Zona: desierto'] }).rule,
    'lugar',
  );
});

test('trimFuaTail recorta la coletilla «y el FUA, de…» y respeta lo demás', () => {
  assert.equal(
    quality.trimFuaTail(
      'Un clon es una copia genética idéntica de otro organismo, como un gemelo hecho en laboratorio; y el FUA, de que no hay nada original.',
    ),
    'Un clon es una copia genética idéntica de otro organismo, como un gemelo hecho en laboratorio.',
  );
  assert.equal(
    quality.trimFuaTail('Manu sigue explorando el mapa con calma, y el FUA, con él, mirando.'),
    'Manu sigue explorando el mapa con calma.',
  );
  assert.equal(quality.trimFuaTail('Pao y el FUA, siempre juntos.'), 'Pao y el FUA, siempre juntos.');
  assert.equal(quality.trimFuaTail('Corto, y el FUA, de eso.'), 'Corto, y el FUA, de eso.');
  assert.equal(quality.trimFuaTail(''), '');
});
