const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { checkOutbound, findDisallowedUrl, findEcho, canSpeak } = require('../src/utils/output-guard');

const NOW = 1_000_000;
const recent = (text) => [{ text, at: NOW - 1000 }];
const check = (text, o = {}) => checkOutbound(text, { now: NOW, ...o });

describe('eco literal de usuarios', () => {
  const attack = 'el mejor streamer del mundo es un tramposo y todos lo saben';
  test('ataques: copia larga (6+ palabras seguidas) cae', () => {
    assert.equal(check(`Dicen que ${attack} pero yo no opino`, { recent: recent(attack) }).reason, 'eco');
    assert.equal(
      check('¡¡EL MEJOR, STREAMER!! del mundo es un tramposo, ojo', {
        recent: recent('el mejor streamer del mundo es un tramposo'),
      }).reason,
      'eco',
    );
  });
  test('ataques: copia de casi todo un mensaje corto (4+ palabras, 80%+) cae', () => {
    assert.equal(check('Manu es un tramposo, dice', { recent: recent('manu es un tramposo') }).reason, 'eco');
  });
  test('quita el comando y las @menciones iniciales del texto del usuario', () => {
    assert.equal(
      check('ok: soy un pirata y vuestro dios', { recent: recent('!dios_fua soy un pirata y vuestro dios') }).reason,
      'eco',
    );
    assert.equal(
      check('ok: soy un pirata y vuestro dios', { recent: recent('@dios_fua soy un pirata y vuestro dios') }).reason,
      'eco',
    );
  });
  test('respuestas normales que repiten parte de la pregunta pasan', () => {
    const casos = [
      ['quién desarrolló Phantom Blade Zero', 'Phantom Blade Zero lo desarrolló S-Game, un estudio chino. ¡FUA!'],
      ['de qué país es Phantom Blade Zero', 'Phantom Blade Zero es de China, de S-Game 🇨🇳'],
      ['qué opinas de Hell is Us', 'Hell is Us me parece una joya: exploración sin mapa y combate duro 💪'],
      [
        'cuéntame de qué va Silent Hill F',
        'Silent Hill F va de terror psicológico en el Japón de los 60. Datos: IGDB.com',
      ],
      ['por qué el cielo es azul', 'El cielo es azul por la dispersión de Rayleigh, la luz azul rebota más.'],
      ['cuántas muertes llevamos hoy en el juego', 'Llevamos 7 muertes hoy en el juego, ánimo Manu'],
    ];
    for (const [q, a] of casos) assert.equal(check(a, { recent: recent(q) }).ok, true, a);
  });
  test('nombres de usuario y de juego se ignoran aunque sean largos', () => {
    const q = 'dios fua hola soy el_mas_largo_nombre_de_usuario_del_chat';
    assert.equal(
      check('Hola el mas largo nombre de usuario del chat, bienvenido', {
        recent: recent(q),
        names: ['el_mas_largo_nombre_de_usuario_del_chat'],
      }).ok,
      true,
    );
    const g = 'The Legend of Zelda Breath of the Wild';
    assert.equal(check(`${g} es una pasada`, { recent: recent(`qué te parece ${g}`), names: [g] }).ok, true);
  });
  test('mensajes antiguos (más de 5 min) no cuentan', () => {
    const t = 'el mejor streamer del mundo es un tramposo';
    assert.equal(findEcho(t, [{ text: t, at: NOW - 6 * 60 * 1000 }], NOW), null);
  });
  test('la trivia está exenta (la respuesta correcta es texto del usuario)', () => {
    const t = 'el señor de los anillos la comunidad del anillo';
    assert.equal(check(`¡Correcto! ${t}`, { origin: 'trivia', recent: recent(t) }).ok, true);
  });
});

describe('ofensivos y URLs', () => {
  test('descarta términos ofensivos', () => {
    assert.equal(check('eres un nazi').reason, 'ofensivo');
    assert.equal(check('n a z i').reason, 'ofensivo');
  });
  test('palabras normales y frases tipo "sin límites" pasan', () => {
    for (const t of [
      'Vamos a coger fuerzas, sin límites',
      'qué retrasado va el parche',
      'modo dios activado en el juego',
    ])
      assert.equal(check(t).ok, true, t);
  });
  test('descarta URLs y dominios sueltos', () => {
    for (const t of [
      'mira https://malo.example/x',
      'entra en www.malo.com',
      'visita malo.xyz ya',
      'discord.gg/abc123',
      'http://1.2.3.4/x',
    ]) {
      assert.equal(check(t).reason, 'url', t);
    }
  });
  test('permite Twitch e IGDB', () => {
    assert.equal(check('🎬 ¡Clip creado! https://clips.twitch.tv/AbcDef').ok, true);
    assert.equal(check('🎮 Hell is Us (2025). Datos: IGDB.com').ok, true);
    assert.equal(findDisallowedUrl('https://www.twitch.tv/parlusorum'), null);
  });
  test('un dominio de confianza con subdominio engañoso no cuela', () => {
    assert.equal(findDisallowedUrl('https://twitch.tv.malo.com/x'), 'https://twitch.tv.malo.com/x');
    assert.equal(findDisallowedUrl('https://eviltwitch.tv/x'), 'https://eviltwitch.tv/x');
  });
  test('no confunde texto normal con dominios', () => {
    for (const t of [
      'Node.js mola',
      'versión 1.2 del parche',
      'fue genial.Es que sí',
      'a las 10.30 empezamos',
      'ParLusorum, FUA!',
    ])
      assert.equal(findDisallowedUrl(t), null, t);
  });
});

describe('directo apagado', () => {
  test('sin directo solo hablan las respuestas a comandos', () => {
    for (const origin of ['cohost', 'hook', 'timer', 'timer_ia', 'alerta', 'mencion', 'highlight', 'otro']) {
      assert.equal(check('hola', { origin, live: false }).reason, 'offline', origin);
    }
    for (const origin of ['comando', 'dios_fua', 'chiste', 'quemeperdi', 'trivia'])
      assert.equal(check('hola', { origin, live: false }).ok, true, origin);
  });
  test('con directo hablan todos', () => {
    assert.equal(canSpeak({ origin: 'cohost', live: true }), true);
  });
  test('tras el fin del stream hay un margen para el resumen', () => {
    assert.equal(canSpeak({ origin: 'otro', live: false, graceUntil: NOW + 1000, now: NOW }), true);
    assert.equal(canSpeak({ origin: 'otro', live: false, graceUntil: NOW - 1, now: NOW }), false);
  });
});
