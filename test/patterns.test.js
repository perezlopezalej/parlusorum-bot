const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { editDistance, isDirectMention, classifyMessage, cooldownMs, cooldownGate } = require('../src/ai/patterns');

const BOT = ['dios_fua'];

describe('mención directa: debe disparar', () => {
  const shouldFire = [
    'dios fua', 'diosfua', 'dios_fua', '@dios_fua', '@Dios_Fua', 'DIOS FUA', 'DiosFua', 'DIOS_FUA',
    '@dios_fua!!!', 'dios fua???', 'dios fua!!!!!', '¡¡dios fua!!', '@dios_fua hola',
    'hola dios fua que tal', 'oye @dios_fua, qué opinas', 'gracias dios fua',
    'dios fuaa', 'dios fuaaaaa', 'diosfuaa', 'dioss fua', 'dios fa', 'dios fu', 'dios ua', 'dios fau',
    'dios fuá', 'dío fua', '@dios_fuaa', '@dios_fa',
  ];
  for (const msg of shouldFire) {
    test(JSON.stringify(msg), () => assert.equal(classifyMessage(msg, {}, { botNames: BOT }), 'direct'));
  }
});

describe('mención directa: no debe disparar', () => {
  const shouldNot = [
    'FUAAAA', 'qué fua tiene este boss', 'dios mío qué boss', 'gracias a dios', 'dios',
    'el fua es real', 'hola buenas', 'dios mio fua', 'diosito fua fua',
  ];
  for (const msg of shouldNot) {
    test(JSON.stringify(msg), () => assert.notEqual(classifyMessage(msg, {}, { botNames: BOT }), 'direct'));
  }
});

describe('preguntas naturales: debe disparar', () => {
  const shouldFire = [
    'qué juego es?', 'que juego es este', 'Qué juego es este?', 'a qué juegas?', 'a qué estáis jugando',
    'qué están jugando?', 'cómo se llama el juego', 'de qué va el juego?', 'de qué va esto?',
    'cuánto llevas de stream?', 'cuanto tiempo llevas', 'cuánto lleva el stream?',
    '¿eres un bot?', 'eres real?', 'eres humano?', 'cómo te llamas?', 'quién eres?',
    '¿es muy difícil?', 'es difícil el juego?', 'qué tan difícil es?', 'está fácil?',
  ];
  for (const msg of shouldFire) {
    test(JSON.stringify(msg), () => assert.equal(classifyMessage(msg, {}, { botNames: BOT }), 'natural'));
  }
});

describe('preguntas naturales: no debe disparar', () => {
  const shouldNot = [
    'qué juego más bueno', 'qué juegos tenéis', 'me encanta este juego', 'cuánto lleva ese boss?',
    'cuánto llevas ahorrado para la ps5', 'eres real tío', 'eres un crack', 'eres un bot jajaja',
    'eres bot', 'es difícil pero me gusta', 'es difícil', 'es muy fácil jajaja',
    'hola cómo te llamas? yo soy pepe y vengo de lejos y de mucho más lejos todavía, saludos',
    'quién eres tú para decir eso',
  ];
  for (const msg of shouldNot) {
    test(JSON.stringify(msg), () => assert.equal(classifyMessage(msg, {}, { botNames: BOT }), null));
  }

  test('respuesta a otro usuario no va dirigida al bot', () => {
    assert.equal(classifyMessage('qué juego es?', { 'reply-parent-user-login': 'pepe' }, { botNames: BOT }), null);
  });
  test('@ a otra persona no va dirigido al bot', () => {
    assert.equal(classifyMessage('@pepe qué juego es?', {}, { botNames: BOT }), null);
  });
  test('respuesta al propio bot sí cuenta', () => {
    assert.equal(classifyMessage('qué juego es?', { 'reply-parent-user-login': 'dios_fua' }, { botNames: BOT }), 'natural');
  });
  test('una mención directa gana aunque sea respuesta a otro', () => {
    assert.equal(classifyMessage('dios fua opina', { 'reply-parent-user-login': 'pepe' }, { botNames: BOT }), 'direct');
  });
});

describe('nombre del bot configurable', () => {
  test('acepta el nombre del bot además de dios fua', () => {
    assert.equal(isDirectMention('hola sr_bot', ['sr_bot']), true);
    assert.equal(isDirectMention('hola sr bot', ['sr_bot']), true);
    assert.equal(isDirectMention('hola otro', ['sr_bot']), false);
  });
  test('un botName indefinido no rompe', () => {
    assert.equal(isDirectMention('hola', [undefined]), false);
  });
});

describe('editDistance', () => {
  test('inserción, borrado, sustitución y transposición cuentan 1', () => {
    assert.equal(editDistance('diosfua', 'diosfua'), 0);
    assert.equal(editDistance('diosfuaa', 'diosfua'), 1);
    assert.equal(editDistance('diosfa', 'diosfua'), 1);
    assert.equal(editDistance('diosfue', 'diosfua'), 1);
    assert.equal(editDistance('diosfau', 'diosfua'), 1);
    assert.equal(editDistance('dios', 'diosfua'), 3);
  });
});

describe('cooldowns', () => {
  test('valores por defecto: directa 8s/10s, natural 45s/30s', () => {
    assert.deepEqual(cooldownMs('direct'), { globalMs: 8000, userMs: 10000 });
    assert.deepEqual(cooldownMs('natural'), { globalMs: 45000, userMs: 30000 });
  });
  test('el multiplicador del modo solo escala las naturales', () => {
    assert.deepEqual(cooldownMs('natural', 0.5), { globalMs: 22500, userMs: 15000 });
    assert.deepEqual(cooldownMs('direct', 3), { globalMs: 8000, userMs: 10000 });
  });
  test('global: bloquea dentro de la ventana y deja pasar al salir', () => {
    assert.equal(cooldownGate('direct', { now: 7999, lastGlobalAt: 0 }), false);
    assert.equal(cooldownGate('direct', { now: 8000, lastGlobalAt: 0 }), true);
    assert.equal(cooldownGate('natural', { now: 44000, lastGlobalAt: 0 }), false);
    assert.equal(cooldownGate('natural', { now: 45000, lastGlobalAt: 0 }), true);
  });
  test('por usuario: bloquea hasta userUntil', () => {
    assert.equal(cooldownGate('direct', { now: 20000, lastGlobalAt: 0, userUntil: 25000 }), false);
    assert.equal(cooldownGate('direct', { now: 25000, lastGlobalAt: 0, userUntil: 25000 }), true);
  });
  test('un multiplicador alto alarga el global natural', () => {
    assert.equal(cooldownGate('natural', { now: 60000, lastGlobalAt: 0, multiplier: 3 }), false);
    assert.equal(cooldownGate('natural', { now: 135000, lastGlobalAt: 0, multiplier: 3 }), true);
  });
});

// Casos reales del directo del 28-10-2026 (logs/chat-2026-10-28.txt)
describe('hablar DE el bot en tercera persona no dispara', () => {
  const third = [
    'El dios fua va a lo suyo y dando guerra al gangar jajaja',
    'Ojito con el dios fua',
    'Que manía con el Dios fua jajajjajaja',
    'me encanta, funciona correcto el dios fua',
    '@gangar79 JAJAJAJAJAJAJ podras destruir a mi pc pero no el amor de dios fua por ti',
    'todavia no ha caido nuestro soldado dios fua sigue de pie',
  ];
  for (const msg of third) {
    test(JSON.stringify(msg), () => assert.equal(classifyMessage(msg, {}, { botNames: BOT }), null));
  }
});

describe('dirigirse al bot sigue disparando', () => {
  const direct = [
    'Dios fua, empieza a ahorrar que en nada llega la navidad',
    'dios fua deja en paz un rato a gangar79 que lo tienes aburrido',
    'dios fua por que esa obsesion con @gangar79',
    'Dios fua que te pasa con gangar?',
    'Dios fua cuanto tiempo lleva  @markosssx en el stream?',
    'Dios fua te estoy preguntando coño',
    'dios fua cuentanos unos chistes mientras el streamer n oesta',
    '@dios_fua qué opinas del jefe',
  ];
  for (const msg of direct) {
    test(JSON.stringify(msg), () => assert.equal(classifyMessage(msg, {}, { botNames: BOT }), 'direct'));
  }
});

describe('provocaciones', () => {
  const prov = [
    'Dios fua vete a cagar subnormal',
    'Tús muertos dios fua',
    'Chupame los huevos dios fua',
    'Te faltan huevos dios fua',
    'vaya mierda de chiste dios fua',
    'dios fua como que pucha eres panchito',
    'Jajjajajaj puto dios fua',
    'Cierra esta Dios fua, tús muertos',
  ];
  for (const msg of prov) {
    test(JSON.stringify(msg), () => assert.equal(classifyMessage(msg, {}, { botNames: BOT }), 'provocation'));
  }
  test('sin mención no es provocación', () => {
    assert.equal(classifyMessage('Tú tas subnormal', {}, { botNames: BOT }), null);
  });
  test('solo la primera de la ventana recibe réplica', () => {
    const { provocationGate } = require('../src/ai/patterns');
    assert.equal(provocationGate(1000, 0), true);
    assert.equal(provocationGate(2000, 1000 + 600000), false);
    assert.equal(provocationGate(1000 + 600001, 1000 + 600000), true);
  });
});
