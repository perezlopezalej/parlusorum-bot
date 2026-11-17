// 16-11: el aviso de redes salió «escribid!redes» y «Con!redes»: fill() y fixMentions() quitaban el espacio antes de «!redes».
const test = require('node:test');
const assert = require('node:assert/strict');

const { fill, template, TEMPLATES } = require('../src/utils/plantillas');
const { fixMentions, speakable } = require('../src/ai/quality/rewrite');

test('fill() conserva el espacio antes de un !comando y sigue pegando los signos de puntuación', () => {
  assert.equal(
    fill('Tenemos Discord: escribid !redes y os paso los enlaces.'),
    'Tenemos Discord: escribid !redes y os paso los enlaces.',
  );
  assert.equal(fill('Con !redes os los paso'), 'Con !redes os los paso');
  assert.equal(fill('Hola {nombre} !'), 'Hola!');
  assert.equal(fill('Hola {nombre} ,qué tal ?'), 'Hola,qué tal?');
});

test('las variantes reales del aviso de redes salen intactas por template() y por speakable()', () => {
  const variantes = TEMPLATES.redes_recordatorio;
  assert.ok(variantes.length >= 2);
  variantes.forEach((original, i) => {
    // rng fija la variante: pickIndex salta la última usada (last=undefined → índice directo)
    const out = template(
      'redes_recordatorio',
      {},
      { rng: () => i / variantes.length, source: { redes_recordatorio: variantes } },
    );
    assert.match(out, /\s!redes\b/, `pierde el espacio: ${out}`);
    assert.match(speakable(out), /\s!redes\b/, `speakable pierde el espacio: ${out}`);
    assert.equal(fill(original), original);
  });
});

test('ninguna plantilla de plantillas.json pierde el espacio antes de un !comando al pasar por fill()', () => {
  for (const [clave, lista] of Object.entries(TEMPLATES)) {
    if (!Array.isArray(lista)) continue;
    for (const texto of lista.filter((t) => typeof t === 'string' && /\s![\p{L}]/u.test(t))) {
      assert.match(fill(texto), /\s![\p{L}]/u, `${clave}: ${texto}`);
    }
  }
});

test('fixMentions conserva el espacio antes de !comando y sigue limpiando el de la puntuación', () => {
  assert.equal(fixMentions('Con !redes os los paso', ['a']), 'Con !redes os los paso');
  assert.equal(fixMentions('Escribid !redes y !discord', []), 'Escribid !redes y !discord');
  assert.equal(fixMentions('¡Gracias @pepe !', ['pepe']), '¡Gracias @pepe!');
  assert.equal(fixMentions('Hola @pepe , qué tal', ['pepe']), 'Hola @pepe, qué tal');
});
