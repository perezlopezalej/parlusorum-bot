// El canal usa un lector de voz (TTS) que lee todo lo que escribe el bot: «49m» sonaba «49 metros» (directo del 11-11).
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { speakable, spokenDuration, spokenSeconds } = quality;

describe('spokenDuration y spokenSeconds', () => {
  test('tiempos con palabras y concordancia', () => {
    assert.equal(spokenDuration(0), 'menos de un minuto');
    assert.equal(spokenDuration(1), '1 minuto');
    assert.equal(spokenDuration(49), '49 minutos');
    assert.equal(spokenDuration(60), '1 hora');
    assert.equal(spokenDuration(89), '1 hora y 29 minutos');
    assert.equal(spokenDuration(169), '2 horas y 49 minutos');
    assert.equal(spokenSeconds(1), '1 segundo');
    assert.equal(spokenSeconds(30), '30 segundos');
    assert.equal(spokenSeconds(65), '1 minuto y 5 segundos');
    assert.equal(spokenSeconds(3725), '1 hora, 2 minutos y 5 segundos');
  });
});

describe('speakable: última capa antes de enviar', () => {
  test('tiempos', () => {
    assert.equal(speakable('Llevamos 49m de stream'), 'Llevamos 49 minutos de stream');
    assert.equal(speakable('Llevamos 1h 29m de stream'), 'Llevamos 1 hora y 29 minutos de stream');
    assert.equal(speakable('Llevamos 2h 49m'), 'Llevamos 2 horas y 49 minutos');
    assert.equal(speakable('espera 30s.'), 'espera 30 segundos.');
    assert.equal(speakable('guardo el chat 24 h'), 'guardo el chat 24 horas');
    assert.equal(speakable('hace 5min'), 'hace 5 minutos');
  });

  test('símbolos que se leen raro', () => {
    assert.equal(speakable('Muerte #1 en este stream'), 'Muerte número 1 en este stream');
    assert.equal(speakable('Ya es el nº 3 del ranking'), 'Ya es el número 3 del ranking');
    assert.equal(speakable('+3 muertes'), '3 más muertes');
    assert.equal(
      speakable('Fin del directo — gracias · FUA | hasta luego'),
      'Fin del directo, gracias, FUA, hasta luego',
    );
    assert.equal(speakable('Del juego → al FUA'), 'Del juego, al FUA');
    assert.equal(speakable('— Hola'), 'Hola');
  });

  test('superlativos sin tilde', () => {
    assert.equal(speakable('con buenisimas noches'), 'con buenísimas noches');
    assert.equal(speakable('es malisimo'), 'es malísimo');
    assert.equal(speakable('muy buenísimas'), 'muy buenísimas');
  });

  test('no toca nicks, comandos, emotes ni horas de reloj', () => {
    const t = '@stewar32 usa !muertes con parlus1Alataqueel a las 21:30 y #hashtag en PS5';
    assert.equal(speakable(t), t);
    assert.equal(speakable('Mujica90 y harocho3847 en 3D'), 'Mujica90 y harocho3847 en 3D');
  });

  describe('TTS_QUITAR_EMOJIS', () => {
    const prev = process.env.TTS_QUITAR_EMOJIS;
    afterEach(() => {
      if (prev === undefined) delete process.env.TTS_QUITAR_EMOJIS;
      else process.env.TTS_QUITAR_EMOJIS = prev;
    });

    test('desactivada por defecto: los emojis se quedan', () => {
      delete process.env.TTS_QUITAR_EMOJIS;
      assert.equal(speakable('¡Gracias! 💜🔥'), '¡Gracias! 💜🔥');
    });

    test('activada: se quitan y el resto queda limpio', () => {
      process.env.TTS_QUITAR_EMOJIS = '1';
      assert.equal(speakable('🎉 ¡Gracias, @ana! 💜🔥 Hasta luego 👀'), '¡Gracias, @ana! Hasta luego');
      assert.equal(speakable('Hola 🏳️‍🌈 mundo'), 'Hola mundo');
    });
  });
});

describe('textos fijos de config/', () => {
  const files = ['messages', 'plantillas', 'help', 'identity-replies', 'injection-replies', 'style-examples'];
  const BAD = [
    [/(?<![\p{L}\p{N}_@])\d+\s*(?:h|m|min|s)(?![\p{L}\p{N}_])/u, 'tiempo con símbolo («49m», «30s»)'],
    [/\}\s?(?:h|m|min|s)(?![\p{L}\p{N}_])/u, 'unidad pegada a un marcador («{seconds}s»)'],
    [/#\{?\w/, '«#» delante de un número'],
    [/\bnº|№/i, '«nº»'],
    [/(?<![\p{L}\p{N}_])\+(?:\d|\{|N\b)/u, '«+N»'],
    [/[—–·→|]/, 'símbolo que el lector dice raro («—», «·», «→», «|»)'],
  ];

  function strings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
    else if (value && typeof value === 'object')
      Object.entries(value).forEach(([k, v]) => k[0] !== '_' && strings(v, out));
    return out;
  }

  for (const f of files) {
    test(`${f}.json no lleva formatos de pantalla`, () => {
      const problems = [];
      for (const s of strings(require(`../config/${f}.json`)))
        for (const [re, what] of BAD) if (re.test(s)) problems.push(`${what}: ${s.slice(0, 90)}`);
      assert.deepEqual(problems, []);
    });
  }
});

test('speakable: no deja «!.» ni «?.» pero respeta los puntos suspensivos', () => {
  assert.equal(
    quality.speakable('¡Cinco caídas, FUA!. parlus1Kelokekelowa'),
    '¡Cinco caídas, FUA! parlus1Kelokekelowa',
  );
  assert.equal(
    quality.speakable('¿Le quitamos el hierro?. parlus1Alataqueel'),
    '¿Le quitamos el hierro? parlus1Alataqueel',
  );
  assert.equal(quality.speakable('Vaya... ¿en serio?...'), 'Vaya... ¿en serio?...');
});
