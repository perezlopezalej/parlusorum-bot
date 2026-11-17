// 16-11: la regla juego_nombre descartó muchos candidatos buenos con «Horizon» a secas. Ahora el código completa el título.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const test = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');

const GAME = 'Horizon Forbidden West';

test('completeGameTitle completa «Horizon» cuando va solo', () => {
  const cases = [
    ['Media hora de Horizon y Manu sigue en pie.', 'Media hora de Horizon Forbidden West y Manu sigue en pie.'],
    ['¿Qué te ha sorprendido más del día de Horizon?', '¿Qué te ha sorprendido más del día de Horizon Forbidden West?'],
    ['Horizon me tiene enganchado, Manu.', 'Horizon Forbidden West me tiene enganchado, Manu.'],
    ['Con Horizon, con Horizon.', 'Con Horizon Forbidden West, con Horizon Forbidden West.'],
    ['Bienvenido a Horizon parlus1Kelokekelowa', 'Bienvenido a Horizon Forbidden West parlus1Kelokekelowa'],
  ];
  for (const [input, want] of cases) assert.equal(quality.completeGameTitle(input, GAME), want, input);
});

test('completeGameTitle completa un prefijo de varias palabras', () => {
  assert.equal(
    quality.completeGameTitle('Qué bien se ve Horizon Forbidden, Manu.', GAME),
    'Qué bien se ve Horizon Forbidden West, Manu.',
  );
});

test('completeGameTitle no toca lo que no se puede corregir con seguridad', () => {
  const same = [
    'Media hora de Horizon Forbidden West y Manu sigue.', // ya completo
    'Me gustó Horizon Zero Dawn, otro juego.', // otro título
    'Qué tal Horizon 5 de Forza.', // número detrás
    'El «Horizon» de la caja.', // entre comillas
    'El horizonte se ve lejos.', // palabra corriente
    'En el oeste (West) no hay nadie.', // palabra del final suelta
    'Qué fuerte el FF de ayer.', // sigla
    'Sin juego a la vista.',
  ];
  for (const t of same) assert.equal(quality.completeGameTitle(t, GAME), t, t);
  assert.equal(quality.completeGameTitle('Horizon a secas', 'Hades'), 'Horizon a secas'); // títulos de una palabra
  assert.equal(quality.completeGameTitle('Horizon a secas', ''), 'Horizon a secas');
  assert.equal(quality.completeGameTitle(undefined, GAME), '');
});

test('el texto completado pasa la regla juego_nombre en cohost, mención, hook y timer', () => {
  const raw = 'Media hora de Horizon y Manu sigue firme, ¿quién apuesta por otra hora sin caerse?';
  assert.equal(quality.validateCohost(raw, { game: GAME }).rule, 'juego_nombre');
  const fixed = quality.completeGameTitle(raw, GAME);
  assert.notEqual(quality.validateCohost(fixed, { game: GAME }).rule, 'juego_nombre');
  assert.equal(quality.abbreviatedGame(fixed, GAME), '');
  assert.equal(
    quality.validateMention(quality.completeGameTitle('¿Qué te ha sorprendido del día de Horizon?', GAME), {
      question: 'hola',
      game: GAME,
    }).ok,
    true,
  );
});

test('vetAuto (bienvenida y raid) completa el título en vez de descartar el aviso', () => {
  assert.equal(
    quality.vetAuto('¡Bienvenido a Horizon, @pepe!', { game: GAME }),
    '¡Bienvenido a Horizon Forbidden West, @pepe!',
  );
  assert.equal(
    quality.vetAuto('¡Raid de @ana! Aquí Horizon y mucho FUA.', { game: GAME }),
    '¡Raid de @ana! Aquí Horizon Forbidden West y mucho FUA.',
  );
  // Sin juego no cambia nada; lo que no se puede completar sigue descartándose
  assert.equal(quality.vetAuto('Bienvenido a Horizon', {}), 'Bienvenido a Horizon');
  assert.throws(() => quality.vetAuto('Qué tal el Forbidden de hoy', { game: GAME }), /descartado/);
});

test('completar es idempotente', () => {
  const once = quality.completeGameTitle('Disfrutando Horizon con Manu.', GAME);
  assert.equal(quality.completeGameTitle(once, GAME), once);
});
