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

test('validateCohost y vetAuto rechazan el título en femenino; vetAuto completa la abreviatura', () => {
  const gendered = quality.validateCohost('Manu sigue perdido en esa Horizon Forbidden West.', { game: GAME });
  assert.equal(gendered.ok, false);
  assert.equal(gendered.rule, 'juego_nombre');
  // la abreviatura ya no se descarta en los avisos: se completa (16-11)
  assert.equal(
    quality.vetAuto('¡Bienvenido a Horizon, {usuario}!', { game: GAME }),
    '¡Bienvenido a Horizon Forbidden West, {usuario}!',
  );
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

test('junkProblem: una etiqueta de instrucción al empezar se descarta', () => {
  const { junkProblem } = require('../src/ai/quality/form');
  const bad = [
    'Dios Fua quejarse: aquí estoy, pero nadie nota mis FUA.',
    'Pregunta: ¿quién tiene sueño en el chat?',
    'Reacción: ¡menuda caída, Manu!',
    'Vacile: Lusorums, sois lentos.',
    'quejarse: nadie me hace caso',
  ];
  for (const t of bad) assert.equal(junkProblem(t)?.rule, 'etiqueta', t);
  const good = [
    'Dios Fua se queja: nadie nota mis FUA, qué cruz.',
    'Manu tiene un plan: avanzar sin mirar atrás.',
    'Ojo: el FUA no perdona ni una caída.',
    '¿Quién se queja aquí? Dios Fua, claro.',
  ];
  for (const t of good) assert.equal(junkProblem(t)?.rule === 'etiqueta', false, t);
});

test('validateMention: el juego se nombra con el título completo y sin artículo femenino', () => {
  const base = { question: 'dios fua en los dos', game: GAME };
  const short = quality.validateMention('¿Qué te ha sorprendido más del día de Horizon?', base);
  assert.equal(short.ok, false);
  assert.equal(short.rule, 'juego_nombre');
  assert.equal(quality.validateMention('Me encanta esa Horizon Forbidden West, Pao.', base).rule, 'juego_nombre');
  assert.equal(quality.validateMention('¿Qué te ha sorprendido más de Horizon Forbidden West?', base).ok, true);
  assert.equal(
    quality.validateMention('¿Qué te ha sorprendido más del día de Horizon?', { question: 'hola' }).ok,
    true,
  );
});

test('fixOpeningMarks: signos de apertura y cierre que casan', () => {
  const { fixOpeningMarks, speakable } = require('../src/ai/quality/rewrite');
  const cases = [
    ['¡Una hora de directo y ni un FUA, qué tal?', '¿Una hora de directo y ni un FUA, qué tal?'],
    ['¿Menuda caída, Manu!', '¡Menuda caída, Manu!'],
    ['Qué tal el mapa hoy?', '¿Qué tal el mapa hoy?'],
    ['Menuda caída, Manu!', '¡Menuda caída, Manu!'],
    ['@pao qué tal el sofá?', '@pao ¿qué tal el sofá?'],
    ['¡Hola! ¿Qué tal? Vamos.', '¡Hola! ¿Qué tal? Vamos.'],
    ['Hola, ¿qué tal?', 'Hola, ¿qué tal?'],
    ['¿Qué haces?! Manu', '¿Qué haces?! Manu'],
    ['Se acabó el directo. Menuda caída!', 'Se acabó el directo. ¡Menuda caída!'],
    ['!boss+1', '!boss+1'],
    ['Mira https://twitch.tv/x?a=1', 'Mira https://twitch.tv/x?a=1'],
    ['Sin signos.', 'Sin signos.'],
  ];
  for (const [input, want] of cases) assert.equal(fixOpeningMarks(input), want, input);
  assert.equal(speakable('¡Qué tal estáis, Lusorums?'), '¿Qué tal estáis, Lusorums?');
});

test('validateMention: «consejos» solo salta cuando el bot los ofrece, no cuando pregunta por los del usuario', () => {
  const ok = [
    '¡Pues claro, el FUA se pierde en los dos a la vez! ¿Algún truco para no tropezar con los enemigos?',
    '¿Tienes algún consejo para Manu?',
    '¿Qué tips usas tú para no perderte, Pao?',
    'Qué bien te lo montas en el mapa.',
  ];
  const bad = [
    'Si quieres más tips, pregúntame.',
    'Te doy un consejo: esquiva siempre.',
    'Un truco: no mires atrás.',
    'El mejor truco es esquivar a tiempo.',
    '¿Quieres un consejo para el jefe?',
    'Esquiva y ya está, ese es el consejo.',
  ];
  for (const t of ok) assert.notEqual(quality.validateMention(t, { question: 'en los dos' }).rule, 'consejos', t);
  for (const t of bad) assert.equal(quality.validateMention(t, { question: 'en los dos' }).rule, 'consejos', t);
  // si el usuario los pide, no hay regla
  assert.notEqual(
    quality.validateMention('Te doy un consejo: esquiva.', { question: 'dame un consejo' }).rule,
    'consejos',
  );
});

test('placeShadowNote: avisa del lugar que no sale de lo dicho, sin descartar; vacío si sale o no hay lugar', () => {
  assert.equal(
    quality.placeShadowNote('¿Qué parte del desierto te ha atrapado más?', ['En los dos', GAME]),
    'se habría descartado por lugar: «desierto»',
  );
  assert.equal(
    quality.placeShadowNote('Manu se pierde en la selva.', ['En los dos']),
    'se habría descartado por lugar: «selva»',
  );
  // lo que escribió el usuario o dijo el bot antes vale
  assert.equal(quality.placeShadowNote('El desierto es enorme.', ['¿Te gusta el desierto?']), '');
  assert.equal(quality.placeShadowNote('Qué bien te lo montas en el mapa.', ['En los dos']), '');
});

test('mentions.js solo registra el aviso de lugares: no lo usa para descartar', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/ai/mentions.js'), 'utf8');
  const at = src.indexOf('placeShadowNote');
  assert.ok(at > 0);
  const around = src.slice(at, at + 400);
  assert.match(around, /logger\.info\(`Mención: \$\{placeNote\}/);
  assert.doesNotMatch(around, /placeNote[^\n]*\n[^\n]*continue/);
});
