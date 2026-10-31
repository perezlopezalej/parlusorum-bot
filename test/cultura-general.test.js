process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { buildQuestionSystemContent, GENERAL_RULE } = require('../src/ai/prompts');
const messages = require('../config/messages.json');

// Caso real: "!dios_fua es cierto que las abejas en verano viven menos que en invierno?" respondía "no tengo datos fiables de eso en RAWG"
const BEES_Q = 'es cierto que las abejas en verano viven menos que en invierno?';
const BEES_A = 'Sí, las obreras de verano viven unas 6 semanas y las de invierno hasta meses: más resistencia al frío y menos curro. FUA.';

describe('cultura general no pasa por el control de videojuegos', () => {
  test('la pregunta de las abejas no es de juegos', () => {
    assert.equal(q.isGameQuestion(BEES_Q), false);
    assert.equal(q.talksAboutGames(`${BEES_Q} ${BEES_A}`), false);
  });
  test('"resistencia" o "zona" sueltas no activan el control, pero sí mecánicas dentro de un juego', () => {
    assert.equal(q.mentionsMechanics(BEES_A), true);
    assert.equal(q.talksAboutGames(BEES_A, 'Elden Ring'), false);
    assert.equal(q.talksAboutGames('¿qué armas van bien en Elden Ring?', 'Elden Ring'), true);
  });
  test('una pregunta de juego sí se detecta (sigue pasando por buscar_juego y su control)', () => {
    assert.equal(q.talksAboutGames('cuándo salió el videojuego Hades?'), true);
    assert.equal(q.talksAboutGames('qué tal el boss final?'), true);
    assert.equal(q.isGameQuestion('qué dificultad tiene el juego?'), true);
  });
});

describe('nada técnico en el chat', () => {
  test('detecta RAWG, datos y herramientas', () => {
    for (const t of [
      'no tengo datos fiables de eso en RAWG, así que no me lo invento',
      'según la herramienta no hay nada',
      'lo busqué en la base de datos y no sale',
      'no tengo datos de eso',
      'eso no está en mis datos',
      'uso la API para eso',
      'llamé a buscar_juego'
    ]) assert.equal(q.leaksTech(t), true, t);
  });
  test('la palabra "datos" suelta en una respuesta normal pasa', () => {
    const ok = 'Según los datos que se conocen, las abejas de invierno viven meses. FUA.';
    assert.equal(q.leaksTech(ok), false);
    assert.equal(q.leaksTech('Con esos datos en la mano, el chat manda.'), false);
    assert.equal(q.validateMention(ok).ok, true);
  });
  test('la respuesta de las abejas y el humor normal no se marcan', () => {
    assert.equal(q.leaksTech(BEES_A), false);
    assert.equal(q.leaksTech('De esto no pondría la mano en el fuego, pero me suena que sí.'), false);
  });
  test('validateMention rechaza respuestas técnicas', () => {
    assert.equal(q.validateMention('No tengo datos fiables de eso en RAWG.').ok, false);
    assert.equal(q.validateMention(BEES_A).ok, true);
  });
  test('los textos de messages.json no mencionan RAWG ni datos', () => {
    const texts = [...messages.dios_fua_no_data, ...messages.mention_game_redirect];
    assert.ok(Array.isArray(messages.dios_fua_no_data) && texts.length > 0);
    for (const t of texts) assert.equal(q.leaksTech(t) || /\bdatos\b/i.test(t), false, t);
  });
});

describe('prompt de !dios_fua para cultura general', () => {
  const p = buildQuestionSystemContent({ personality: 'P.' });
  test('indica no usar buscar_juego fuera de videojuegos y responder corto con humor si duda', () => {
    assert.ok(p.includes(GENERAL_RULE));
    assert.match(GENERAL_RULE, /NO es de videojuegos/);
    assert.match(GENERAL_RULE, /NO llames a buscar_juego/);
    assert.match(GENERAL_RULE, /dilo con humor/);
    assert.match(GENERAL_RULE, /NUNCA menciones RAWG/);
  });
  test('para juegos sigue obligando a buscar_juego', () => {
    assert.match(p, /llama SIEMPRE a la herramienta buscar_juego/);
  });
});
