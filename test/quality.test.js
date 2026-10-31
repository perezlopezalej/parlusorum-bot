process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { truncate } = require('../src/utils/groq-utils');
const { channel_emotes: emotes } = require('../config/channel.json');

// Mensajes reales del directo del 28-10-2026 (logs/chat-2026-10-28.txt)
const REAL = {
  pucha: '¡Pucha, lo siento, @vlxj97! El FUA se quedó sin chispa ese chiste. 😅 parlus1Kelokekelowa',
  queOnda: '¡Qué onda gangar79, el FUA está listo para salvarte si las cosas se ponen difíciles! parlus1PORELPODERDELFUAAAAA',
  onda: 'Vamooooooooooooooooo con el FUA a tope, parlé la onda del chat y que la energía se desborde. parlus1PORELPODERDELFUAAAAA Kappa',
  robot1: 'No puedo participar en eso.',
  robot2: 'Lo siento, no puedo ayudar con eso.',
  robot3: 'No, no es algo que haga. Si quieres algo más épico en el stream, ¡el FUA está a la orden!',
  robot4: '¡Oye, @vlxj97! El FUA no entiende esos insultos, solo energía. 🙌',
  caida1: 'Ala, el FUA ya se está cargando para la próxima caída parlus1PORELPODERDELFUAAAAA',
  caida2: 'El silencio es tan denso que hasta el FUA parece descansar, pero cuando la próxima caída suene ya está listo para rugir.',
  muerte4: 'El chat sigue en modo poco poco y llega la muerte #4, saca el FUA antes de que te quede la última vida.',
  gangar: '¡A ver, gangar79, que el FUA está más fuerte que tu PC!',
  cortado1: '¡Claro, @vlxj97! Aquí van: ¿Qué hace un fantasma con FUA? ¡Se levanta! 😆 parlus1Esteeselrollo ¿Y por qué el ...',
};

describe('tono: español de España', () => {
  test('detecta latinoamericanismos del log', () => {
    assert.ok(q.hasLatam(REAL.pucha));
    assert.ok(q.hasLatam(REAL.queOnda));
    assert.ok(q.hasLatam(REAL.onda));
  });
  test('no marca español peninsular', () => {
    for (const ok of ['Vaya tío, qué susto, mola mucho ese jefe.', 'Vosotros estáis locos, vale.', 'El juego tiene mucha onda expansiva.']) {
      assert.equal(q.hasLatam(ok), false, ok);
    }
  });
});

describe('rechazos de robot', () => {
  for (const k of ['robot1', 'robot2', 'robot3', 'robot4']) {
    test(k, () => assert.ok(q.isRobotRefusal(REAL[k])));
  }
  test('una réplica con personalidad no es rechazo', () => {
    assert.equal(q.isRobotRefusal('Qué cariño me tienes, tío. Se nota que piensas mucho en mí.'), false);
  });
});

describe('muertes no anotadas', () => {
  test('contador a 0: cualquier muerte/caída se rechaza', () => {
    assert.ok(q.mentionsUnrecordedDeaths(REAL.caida1, 0));
    assert.ok(q.mentionsUnrecordedDeaths('Otra muerte más y van...', 0));
  });
  test('sin alusiones a muertes pasa', () => {
    assert.equal(q.mentionsUnrecordedDeaths('Menudo combo acaba de soltar el protagonista.', 0), false);
  });
  test('la cifra citada debe coincidir con el contador', () => {
    assert.ok(q.mentionsUnrecordedDeaths(REAL.muerte4, 5)); // iba por la 5 y habló de la "muerte #4"
    assert.equal(q.mentionsUnrecordedDeaths('Van 5 muertes, y las que quedan.', 5), false);
    assert.ok(q.mentionsUnrecordedDeaths('Van 6 muertes ya.', 5));
  });
});

describe('nombres repetidos', () => {
  const now = 1_000_000;
  const named = new Map([['gangar79', now - 5 * 60 * 1000], ['vlxj97', now - 40 * 60 * 1000]]);
  test('rechaza al usuario nombrado hace menos de la ventana (con o sin @)', () => {
    assert.deepEqual(q.recentlyNamedIn(REAL.gangar, named, now, 15 * 60 * 1000), ['gangar79']);
    assert.deepEqual(q.recentlyNamedIn('Hola @Gangar79, qué tal', named, now, 15 * 60 * 1000), ['gangar79']);
  });
  test('pasada la ventana ya se puede nombrar', () => {
    assert.deepEqual(q.recentlyNamedIn('Eso, vlxj97, tú sí.', named, now, 15 * 60 * 1000), []);
  });
  test('namesIn encuentra los usuarios citados', () => {
    assert.deepEqual(q.namesIn(REAL.gangar, ['gangar79', 'vlxj97', 'Gangar79']), ['gangar79']);
  });
});

describe('emotes: como mucho 1 de cada 3 mensajes', () => {
  const withE = 'Buen combo parlus1Esteeselrollo';
  const without = 'Buen combo';
  test('se permite si los 2 últimos mensajes no llevaron', () => {
    assert.equal(q.emoteAllowed([withE, without, without], emotes), true);
    assert.equal(q.emoteAllowed([], emotes), true);
  });
  test('no se permite si alguno de los 2 últimos llevó', () => {
    assert.equal(q.emoteAllowed([without, withE], emotes), false);
    assert.equal(q.emoteAllowed([withE, without], emotes), false);
  });
  test('sin permiso se quitan todos; con permiso queda solo el primero', () => {
    assert.equal(q.applyEmotePolicy('Vamos parlus1Alataqueel que sí parlus1PORELPODERDELFUAAAAA', false, emotes), 'Vamos que sí');
    assert.equal(q.applyEmotePolicy('Vamos parlus1Alataqueel que sí parlus1PORELPODERDELFUAAAAA', true, emotes), 'Vamos parlus1Alataqueel que sí');
  });
  test('conserva el espacio en "usa !comando" y quita el de antes de un signo', () => {
    assert.equal(q.applyEmotePolicy('Para eso usa !dios_fua, que ahí me pongo serio.', true, emotes), 'Para eso usa !dios_fua, que ahí me pongo serio.');
    assert.equal(q.applyEmotePolicy('Para eso usa !dios_fua, que sí parlus1Alataqueel', false, emotes), 'Para eso usa !dios_fua, que sí');
    assert.equal(q.applyEmotePolicy('Vamos parlus1Alataqueel , que sí', false, emotes), 'Vamos, que sí');
  });
});

describe('fórmulas repetidas', () => {
  test('misma fórmula que un mensaje reciente se rechaza', () => {
    const recent = [REAL.caida1];
    const r = q.validateCohost(REAL.caida2, { recent, deathCount: 4 });
    assert.equal(r.ok, false);
  });
  test('frase nueva y concreta pasa', () => {
    const r = q.validateCohost('Qué risas se están echando por aquí, el directo va de maravilla.', { recent: [REAL.caida1], deathCount: 0 });
    assert.equal(r.ok, true);
  });
  test('muy parecida a una reciente se rechaza', () => {
    const a = 'El inventario del protagonista está lleno de pociones sin usar.';
    assert.ok(q.tooSimilar('Las pociones sin usar llenan el inventario del protagonista.', [a]));
  });
});

describe('validateCohost integra todas las reglas', () => {
  const ctx = { deathCount: 0, recent: [], named: new Map(), now: 1000 };
  test('motivos de rechazo', () => {
    assert.match(q.validateCohost(REAL.queOnda, ctx).reason, /latinoamericanas/);
    assert.match(q.validateCohost(REAL.robot1 + ' Vaya tela con el jefe.', ctx).reason, /robot/);
    assert.match(q.validateCohost(REAL.caida1, ctx).reason, /muertes/);
  });
});

describe('cortes en final de frase', () => {
  test('truncate corta en el último final de frase, sin "..."', () => {
    const out = truncate('Primera frase completa. Segunda frase que se alarga mucho más de lo permitido por el límite', 50);
    assert.equal(out, 'Primera frase completa.');
  });
  test('sin final de frase corta en palabra y cierra con punto', () => {
    const out = truncate('uno dos tres cuatro cinco seis siete ocho nueve diez once doce', 30);
    assert.ok(out.length <= 30);
    assert.ok(out.endsWith('.'));
    assert.ok(!out.endsWith('...'));
  });
  test('mensaje real que salió cortado por "..."', () => {
    const out = truncate(REAL.cortado1.replace(/ \.\.\.$/, ' ¿Y por qué el dragón no vuelve nunca a casa después de cada pelea contra el jefe?'), 110);
    assert.ok(/[.!?]$/.test(out), out);
  });
  test('dropTrailingFragment quita el fragmento final tras max_tokens', () => {
    assert.equal(q.dropTrailingFragment('Menudo jefe. Y ahora el siguiente que'), 'Menudo jefe.');
    assert.equal(q.dropTrailingFragment('Ya está hecho.'), 'Ya está hecho.');
  });
});

describe('validateHook', () => {
  test('rechaza metáforas de comentarista deportivo', () => {
    assert.equal(q.validateHook('Clive se lanza con la furia de un delantero de Champions', {}).ok, false);
    assert.equal(q.validateHook('Cada combo es un gol de último minuto en Valisthea', {}).ok, false);
  });
  test('acepta un hook con voz de Dios Fua', () => {
    assert.equal(q.validateHook('Chat dormido, el FUA os vigila: ¿qué jefe os ha dado más guerra?', { deathCount: 0 }).ok, true);
  });
  test('no inventa muertes', () => {
    assert.equal(q.validateHook('Cuidado con la Muerte #5, el FUA avisa', { deathCount: 4 }).ok, false);
    assert.equal(q.validateHook('El streamer cae otra vez, qué dolor', { deathCount: 0 }).ok, false);
  });
  test('no repite hooks recientes', () => {
    const t = 'Chat dormido, el FUA os vigila desde las sombras del servidor';
    assert.equal(q.validateHook(t, { recent: [t] }).ok, false);
  });
});

describe('cohost: ambiente del chat', () => {
  const q = require('../src/ai/quality');
  test('judgesChatMood detecta juicios del ambiente', () => {
    for (const t of ['El chat está quieto hoy, qué sueño.', 'Chat dormilón, despertad ya.', 'Qué silencio en el chat, FUA.']) assert.equal(q.judgesChatMood(t), true, t);
    assert.equal(q.judgesChatMood('Pedir pizza con piña es delito y lo sabéis.'), false);
  });
  test('validateCohost lo rechaza', () => {
    assert.equal(q.validateCohost('El chat está tranquilo y dormilón, FUA.').ok, false);
    assert.equal(q.validateCohost('Pizza con piña es un crimen contra la humanidad.').ok, true);
  });
});
