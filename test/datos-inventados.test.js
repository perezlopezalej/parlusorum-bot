// Directo del 13-11: datos inventados. «Bahamut» como jefe final en !dios_fua (y otra vez en una mención), «el stream de
// ayer» adivinado, y !quemeperdi y el resumen de fin de stream con «Pao en la grada», «Final Fantasy trece», «el chat de
// España» o «madrugada larga». Ahora se escriben con hechos y la salida solo puede contar esos hechos.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';
process.env.BOT_USERNAME = process.env.BOT_USERNAME || 'dios_fua';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
const FF16 = {
  name: 'FINAL FANTASY XVI',
  released: '2023-06-22',
  developers: 'Square Enix Creative Business Unit III',
  country: 'Japón',
  publishers: 'Square Enix',
  genres: 'Role-playing (RPG), Adventure',
  description: 'An epic dark fantasy world where the fate of the land is decided by the Eikons.',
};
let currentGame = 'FINAL FANTASY XVI';
api.getCurrentGame = async () => ({ game: currentGame });
api.getGameInfo = async () => null;
api.getChannelInfo = async () => ({ game_name: currentGame });
api.lookupGameInfo = async (name) => (/final fantasy/i.test(name) ? { info: FF16 } : { info: null });

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const q = require('../src/ai/quality');
const ai = require('../src/ai/handler');
const chatMemory = require('../src/ai/chat-memory');
const memory = require('../src/memory/handler');
const messages = require('../config/messages.json');
const { buildRecapFacts, renderFacts } = require('../src/ai/moment-facts');
const { madridDateKey, daysAgo, relativeDayLabel } = require('../src/utils/stream-session');

let sent, calls, replies;
const client = {
  say: (ch, msg) => {
    sent.push(msg);
  },
};
const text = (c) => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });
let userSeq = 5000;
const tagsFor = (id) => ({ 'display-name': 'vlxj97', 'user-id': String(id), username: 'vlxj97', badges: {} });

beforeEach(() => {
  sent = [];
  calls = [];
  replies = [];
  currentGame = 'FINAL FANTASY XVI';
  state.resetAiBlocks();
  state.resetAiUsage();
  // El revisor (factcheck) y el resumen de la ficha no son «Eres Dios Fua»: contestan NO (nada que descartar)
  router.setTransport('groq', async (p) => {
    if (!/Eres Dios Fua/.test(p.messages[0].content)) return text('NO');
    calls.push(p);
    return text(replies.length ? replies.shift() : 'El FUA está con vosotros.');
  });
});

// --- Hechos y datos reales del 13-11 ---
const START = Date.parse('2026-11-13T10:30:00Z'); // 11:30 en Madrid
const FF_FACTS = buildRecapFacts({
  game: 'FINAL FANTASY XVI',
  minutes: 212,
  deathCount: 1,
  player: 'Manu',
  ended: true,
});
const FF_CTX = {
  facts: FF_FACTS,
  game: 'FINAL FANTASY XVI',
  player: 'manu',
  minutes: 212,
  deathCount: 1,
  startedAt: START,
  endedAt: START + 212 * 60000,
};
const REAL_SUMMARY_FF =
  'Tres horas y media de Final Fantasy trece con una sola caída, en un directo donde el FUA no tuvo que salir porque todo fue copiar y pegar, y el chat de España demostró ser más bueno que nadie.';
const REAL_QUEMEPERDI =
  'Llegamos a la hora y veinte de juego, Manu sigue explorando el mundo sin haber vencido a ningún coloso y el chat no para de lanzar chistes y bromas. Mientras tanto Pao está ahí en la grada, animando con su característico “¡FUA!” cada vez que el ambiente se pone más caótico.';

describe('hechos para contar el directo (buildRecapFacts)', () => {
  test('en directo: juego exacto, quién juega, rato aproximado, caídas y tema del chat por reglas', () => {
    const chat = [
      { username: 'a', message: 'vamos Manu tu puedes' },
      { username: 'b', message: 'animo crack' },
      { username: 'c', message: 'vamos vamos' },
      { username: 'd', message: 'coto amenaza de bomba en el bahia sur' },
    ];
    const facts = buildRecapFacts({
      game: 'Shadow of the Colossus',
      minutes: 80,
      deathCount: 0,
      player: 'Manu',
      chatLines: chat,
    });
    assert.deepEqual(
      facts.map((f) => f.texto),
      [
        'Juegan a Shadow of the Colossus y juega Manu',
        'Llevan una hora y pico de directo',
        'El chat está animando a Manu',
      ],
    );
    // ninguna línea literal del chat llega al prompt
    assert.doesNotMatch(renderFacts(facts), /bomba|bahia|crack|tu puedes/);
  });

  test('al acabar: en pasado, con jefes y sin tema del chat si no hay 3 usuarios', () => {
    const facts = buildRecapFacts({
      game: 'FINAL FANTASY XVI',
      minutes: 212,
      deathCount: 1,
      bosses: 1,
      player: 'Manu',
      chatLines: [{ username: 'a', message: 'vamos Manu' }],
      ended: true,
    });
    assert.deepEqual(
      facts.map((f) => f.texto),
      [
        'Se jugó a FINAL FANTASY XVI y jugó Manu',
        'El directo duró tres horas y media',
        'Manu cayó una vez',
        'Se superó un jefe',
      ],
    );
  });

  test('con los dos jugando concuerda en plural', () => {
    const facts = buildRecapFacts({
      game: 'X',
      minutes: 300,
      deathCount: 14,
      bosses: 3,
      player: 'Manu y Pao',
      ended: true,
    });
    assert.equal(facts[0].texto, 'Se jugó a X y jugaron Manu y Pao');
    assert.equal(facts[2].texto, 'Manu y Pao cayeron 14 veces');
    assert.equal(facts[3].texto, 'Se superaron tres jefes');
  });
});

describe('reglas de los textos que cuentan el directo (quality/recap.js)', () => {
  test('otherStreamer: quien no juega no aparece, salvo en la pareja «Manu y Pao»', () => {
    assert.equal(q.otherStreamer('Pao está ahí en la grada animando', 'manu'), 'Pao');
    assert.equal(q.otherStreamer('Manu cayó una vez', 'manu'), '');
    assert.equal(q.otherStreamer('El canal de Manu y Pao no descansa', 'manu'), '');
    assert.equal(q.otherStreamer('Manu miraba desde el sofá', 'pao'), 'Manu');
    assert.equal(q.otherStreamer('Pao y Manu se turnaron', 'ambos'), '');
  });

  test('foreignChat: el chat es el del canal', () => {
    assert.equal(q.foreignChat('el chat de España demostró ser más bueno que nadie'), 'chat de España');
    assert.equal(q.foreignChat('todo fue copiar y pegar'), 'copiar y pegar');
    assert.equal(q.foreignChat('el chat de Manu y Pao no paró de animar'), '');
    assert.equal(q.foreignChat('el chat de los Lusorums aguantó'), '');
    assert.equal(q.foreignChat('el chat de hoy estuvo fino'), '');
  });

  test('wrongHours: las horas citadas cuadran con la duración', () => {
    assert.equal(q.wrongHours('Tres horas y media de directo', 212), '');
    assert.equal(q.wrongHours('Casi cuatro horas de directo', 212), '');
    assert.ok(q.wrongHours('Cuatro horas y casi tres de juego', 100));
    assert.ok(q.wrongHours('Seis horas de directo', 212));
    assert.equal(q.wrongHours('Una maratón de Hell Is Us', 120), 'maraton');
    assert.equal(q.wrongHours('Una maratón de Hell Is Us', 300), '');
    assert.equal(q.wrongHours('Dos horas de directo', undefined), '', 'sin duración no se comprueba');
  });

  test('parte del día: solo las que cubrió el directo (hora de Madrid)', () => {
    const morning = q.streamDayParts(START, START + 212 * 60000); // 11:30 → 15:02
    assert.deepEqual([...morning].sort(), ['mañana', 'tarde']);
    assert.equal(q.wrongStreamDayPart('Madrugada larga de directo', morning), 'madrugada');
    assert.equal(q.wrongStreamDayPart('Noche de caídas y risas', morning), 'noche');
    assert.equal(q.wrongStreamDayPart('Tarde tranquila de juego', morning), '');
    assert.equal(q.wrongStreamDayPart('Manu llegó tarde al jefe y más tarde lo superó', morning), '');
    const night = q.streamDayParts(Date.parse('2026-11-12T20:00:00Z'), Date.parse('2026-11-13T00:30:00Z')); // 21:00 → 01:30
    assert.deepEqual([...night].sort(), ['madrugada', 'noche']);
    assert.equal(q.wrongStreamDayPart('Madrugada larga de directo', night), '');
    assert.equal(
      q.wrongStreamDayPart('Tarde tranquila de juego', night),
      'tardes tranquila'.replace('tardes', 'tarde'),
    );
    assert.equal(
      q.wrongStreamDayPart('Madrugada larga', q.streamDayParts(null)),
      '',
      'sin hora de inicio no se comprueba',
    );
  });

  test('inventedDetail: un nombre tras dos puntos también cuenta («aquí tienes: Bahamut»)', () => {
    const ctx = { allowed: ['Juegan a FINAL FANTASY XVI y juega Manu'] };
    assert.equal(q.inventedDetail('Y si te falta un dragón, aquí tienes: Bahamut, con todo.', ctx), 'Bahamut');
    assert.equal(q.inventedDetail('El jefe final es Bahamut, el dragón legendario.', ctx), 'Bahamut');
    // una palabra corriente con mayúscula tras los dos puntos no es un nombre
    assert.equal(q.inventedDetail('Resumen: Tres caídas y mucho FUA.', ctx), '');
    assert.equal(q.inventedDetail('Atención: Manu ha vuelto.', ctx), '');
  });

  test('abbreviatedGame: una palabra corriente del título no delata nada («final» en FINAL FANTASY XVI)', () => {
    assert.equal(q.abbreviatedGame('Al final del directo Manu ganó', 'FINAL FANTASY XVI'), '');
    assert.equal(q.abbreviatedGame('Tres horas de Final Fantasy trece', 'FINAL FANTASY XVI'), 'fantasy');
    assert.equal(q.abbreviatedGame('Tres horas de Final Fantasy XVI', 'FINAL FANTASY XVI'), '');
  });

  test('recapProblem: las frases reales del 13-11 se rechazan por su regla y las correctas pasan', () => {
    const rule = (t, ctx = FF_CTX) => q.recapProblem(t, ctx)?.rule || null;
    assert.equal(rule(REAL_SUMMARY_FF), 'juego_nombre');
    assert.equal(
      rule('Tres horas y media de FINAL FANTASY XVI en las que todo fue copiar y pegar y el chat de España mandó.'),
      'chat_ajeno',
    );
    assert.equal(rule('Madrugada larga de cuatro horas de Final Fantasy XVI, donde Manu cayó una vez.'), 'hora');
    assert.equal(rule('Maratón de Final Fantasy XVI con Manu al mando y una caída.'), 'duracion');
    assert.equal(rule('Final Fantasy XVI: Manu cayó una vez mientras Pao animaba desde la grada.'), 'jugador');
    assert.equal(rule('Final Fantasy XVI con Manu: una caída y Bahamut esperando al fondo.'), 'inventado');
    assert.equal(rule('Directo de Final Fantasy XVI: 212 minutos y una caída de Manu.'), 'minutos');
    assert.equal(rule('Final Fantasy XVI con Manu y 3 viewers aguantando.'), 'viewers');
    assert.equal(
      rule('Tres horas y media de Final Fantasy XVI que parecían un Elden Ring, con una caída.'),
      'otro_juego',
    );
    for (const ok of [
      'Tres horas y media de FINAL FANTASY XVI con una sola caída de Manu, y el FUA presente en cada intento.',
      'Tres horas y media de Final Fantasy XVI en las que Manu cayó una vez y los Lusorums no soltaron el directo.',
      'Al final del directo de Final Fantasy XVI, Manu solo cayó una vez en tres horas y media.',
      q.positiveSummaryFallback({ game: 'FINAL FANTASY XVI', durationMinutes: 212, deathCount: 1, player: 'manu' }),
    ])
      assert.equal(rule(ok), null, ok);
  });
});

describe('resumen de fin de stream: solo hechos', () => {
  test('summaryProblem con los hechos rechaza los resúmenes reales guardados el 12 y 13-11', () => {
    assert.match(memory.summaryProblem(REAL_SUMMARY_FF, FF_CTX), /abrevia el nombre del juego/);
    const colossus = (minutes) => ({
      facts: buildRecapFacts({ game: 'Shadow of the Colossus', minutes, deathCount: 0, player: 'Manu', ended: true }),
      game: 'Shadow of the Colossus',
      player: 'manu',
      minutes,
      deathCount: 0,
    });
    const pao =
      'Ocho minutos de Shadow of the Colossus en la que Pao no tuvo una sola caída y el Fua salió a dar moral por los dos viewers que estaban ahí.';
    // con el contador a cero nadie anotó caídas: «ni una sola caída» no se puede afirmar; y además quien jugaba era Manu
    assert.match(memory.summaryProblem(pao, colossus(8)), /muertes que no están en el contador/);
    assert.equal(q.recapProblem(pao, colossus(8)).rule, 'jugador');
    const hell = {
      facts: buildRecapFacts({ game: 'Hell Is Us', minutes: 243, deathCount: 20, player: 'Manu', ended: true }),
      game: 'Hell Is Us',
      player: 'manu',
      minutes: 243,
      deathCount: 20,
      startedAt: Date.parse('2026-11-12T17:00:00Z'), // 18:00 → 22:03 en Madrid
      endedAt: Date.parse('2026-11-12T21:03:00Z'),
    };
    assert.match(
      memory.summaryProblem(
        'Madrugada larga de 4 horas y casi 3 de Hell Is Us, donde Manu cayó toda la vida pero no se rindió, FUA incluido.',
        hell,
      ),
      /parte del día/,
    );
    assert.equal(
      memory.summaryProblem(
        'Unas cuatro horas de Hell Is Us en las que Manu cayó 20 veces y se levantó otras tantas.',
        hell,
      ),
      null,
    );
    // sin los hechos (uso antiguo) siguen valiendo solo las reglas de siempre
    assert.equal(memory.summaryProblem('Tarde de Hell Is Us con muchas caídas y buen ambiente en el chat.'), null);
  });

  test('el prompt lleva <hechos> y ni una línea del chat', () => {
    const { buildSummaryPrompt } = require('../src/ai/style');
    const p = buildSummaryPrompt({ facts: FF_FACTS });
    assert.match(p, /<hechos>h1\. Se jugó a FINAL FANTASY XVI y jugó Manu\nh2\. El directo duró tres horas y media/);
    assert.doesNotMatch(p, /<chat>|<datos>|Pico de viewers|Comandos más usados|chat de España/);
    assert.match(p, /<tarea>.+<\/tarea>$/);
  });

  test('dos intentos que se salen de los hechos: se guarda el resumen fijo con hechos, sin IA', async () => {
    replies = [
      JSON.stringify({ summary: REAL_SUMMARY_FF }),
      JSON.stringify({ summary: 'Tres horas y media de Final Fantasy XVI con Pao animando desde la grada.' }),
    ];
    const out = await memory.generateStreamMemory(
      {
        game: 'FINAL FANTASY XVI',
        durationMinutes: 212,
        deathCount: 1,
        player: 'manu',
        startedAt: START,
        activeUsers: [],
      },
      'vlxj97: coto amenaza de bomba en el bahia sur\nmarkosssx: jajaja',
    );
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].messages[0].content, /bomba|bahia|markosssx/);
    assert.match(
      calls[1].messages[0].content,
      /<correccion>Si nombras el juego, escribe su título completo\.<\/correccion>/,
    );
    assert.equal(out.summary, 'Directo de FINAL FANTASY XVI con Manu al mando: tres horas y media, 1 caída.');
    assert.equal(out.streamDate, '2026-11-13');
    assert.deepEqual(out.highlights, []);
  });

  test('un resumen que cuenta los hechos pasa a la primera', async () => {
    replies = [
      JSON.stringify({
        summary:
          'Tres horas y media de FINAL FANTASY XVI con una sola caída de Manu y los Lusorums sin soltar el directo.',
        highlights: ['el coto amenazó de bomba'],
      }),
    ];
    const out = await memory.generateStreamMemory(
      {
        game: 'FINAL FANTASY XVI',
        durationMinutes: 212,
        deathCount: 1,
        player: 'manu',
        startedAt: START,
        activeUsers: [],
      },
      '',
    );
    assert.equal(calls.length, 1);
    assert.match(out.summary, /^Tres horas y media de FINAL FANTASY XVI/);
    assert.deepEqual(out.highlights, [], 'lo que no viene de los hechos no se guarda');
  });

  test('linesFromChatSample: «nick: mensaje» por línea', () => {
    assert.deepEqual(memory.linesFromChatSample('ana: hola: qué tal\nlínea sin nick\nbob: fua'), [
      { username: 'ana', message: 'hola: qué tal' },
      { username: 'bob', message: 'fua' },
    ]);
    assert.deepEqual(memory.linesFromChatSample(''), []);
  });
});

describe('día de la memoria y «el stream de ayer»', () => {
  test('madridDateKey: un directo que empieza a las 23:30 de Madrid es de ese día aunque en UTC sea el anterior o el siguiente', () => {
    assert.equal(madridDateKey(Date.parse('2026-11-12T22:30:00Z')), '2026-11-12'); // 23:30 del 12 en Madrid
    assert.equal(madridDateKey(Date.parse('2026-11-12T23:30:00Z')), '2026-11-13'); // 00:30 del 13 en Madrid
    assert.equal(madridDateKey(Date.parse('2026-07-01T22:30:00Z')), '2026-07-02'); // verano: UTC+2
  });

  test('daysAgo y relativeDayLabel', () => {
    const now = Date.parse('2026-11-13T12:27:00Z');
    assert.equal(daysAgo('2026-11-12', now), 1);
    assert.equal(daysAgo('nada', now), null);
    assert.equal(relativeDayLabel('2026-11-13', now), 'hoy, en un directo anterior, 13 de noviembre');
    assert.equal(relativeDayLabel('2026-11-12', now), 'ayer, 12 de noviembre');
    assert.equal(relativeDayLabel('2026-11-11', now), 'anteayer, 11 de noviembre');
    assert.equal(relativeDayLabel('2026-11-09', now), 'hace 4 días, 9 de noviembre');
    assert.equal(relativeDayLabel('2026-10-20', now), '20 de octubre');
    assert.equal(relativeDayLabel('2025-12-30', now), '30 de diciembre de 2025');
    assert.equal(relativeDayLabel('', now), '');
  });
});

describe('!dios_fua: lo que la ficha no trae no se inventa', () => {
  test('asksBeyondSheet: jefes, villano, final, personajes y detalles', () => {
    const topic = (t) => q.asksBeyondSheet(t)?.topic || null;
    assert.equal(topic('quien es el boss final de final fantasy xvi?'), 'jefes');
    assert.equal(topic('me refiero al ultimo jefe al que te enfrentas en final fantasy xvi'), 'jefes');
    assert.equal(topic('cuántos jefes tiene Hollow Knight'), 'jefes');
    assert.equal(topic('¿cómo acaba Hades?'), 'final');
    assert.equal(topic('qué personajes salen en Hades'), 'personajes');
    assert.equal(topic('qué armas hay en Elden Ring'), 'detalles');
    assert.equal(topic('quién es el villano de Star Wars'), 'villano');
    assert.equal(q.asksBeyondSheet('quién es el villano de Star Wars').strong, false);
    for (const t of [
      'de qué va Hades',
      'quién desarrolló el Phantom Blade 0?',
      'quién es tu jefe',
      'cuál es el final fantasy más vendido',
      'al final qué juego toca',
      'cuántas horas llevamos jugando',
      'cual fue el stream de ayer?',
      'cuándo sale Hades 2',
    ])
      assert.equal(topic(t), null, t);
  });

  test('«¿quién es el boss final de final fantasy xvi?» → frase fija que lo reconoce, sin llamar a la IA', async () => {
    const args = '!dios_fua quien es el boss final de final fantasy xvi?'.split(' ');
    await ai.handleQuestion(client, '#parlusorum', tagsFor(userSeq++), args);
    assert.equal(calls.length, 0, 'sin IA');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^@vlxj97 /);
    assert.match(sent[0], /los jefes/);
    assert.doesNotMatch(sent[0], /Bahamut|\{tema\}/);
    assert.ok(
      messages.dios_fua_beyond_sheet.some((m) => sent[0].includes(m.replace('{tema}', 'los jefes'))),
      'sale del banco editable',
    );
  });

  test('la frase real del 13-11 («me refiero al último jefe…») también', async () => {
    const args = '!dios_fua me refiero al ultimo jefe al que te enfrentas en final fantasy xvi'.split(' ');
    await ai.handleQuestion(client, '#parlusorum', tagsFor(userSeq++), args);
    assert.equal(calls.length, 0);
    assert.match(sent[0], /los jefes/);
  });

  test('una pregunta de cultura general con «villano» sigue yendo a la IA', async () => {
    replies = ['Darth Vader, que respira más fuerte que el chat un lunes.'];
    const args = '!dios_fua quién es el villano de Star Wars'.split(' ');
    await ai.handleQuestion(client, '#parlusorum', tagsFor(userSeq++), args);
    assert.ok(calls.length >= 1);
    assert.match(sent[0], /Darth Vader/);
  });

  test('con ficha: un nombre que no está en ella («Bahamut») se reintenta y, si repite, sale la plantilla con datos', async () => {
    replies = [
      'Final Fantasy XVI es de Square Enix y su gran rival es Bahamut, el dragón legendario.',
      'Final Fantasy XVI es de Square Enix, y Bahamut te espera con todo.',
    ];
    const args = '!dios_fua qué opinas de Final Fantasy XVI'.split(' ');
    await ai.handleQuestion(client, '#parlusorum', tagsFor(userSeq++), args);
    assert.equal(calls.length, 2, 'respuesta y un reintento');
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /Bahamut/);
    assert.match(sent[0], /FINAL FANTASY XVI/);
    assert.match(sent[0], /Square Enix/);
  });

  test('con ficha: una respuesta que cuenta solo la ficha pasa tal cual', async () => {
    replies = ['Final Fantasy XVI es un juego de rol y aventura de Square Enix, un estudio de Japón, y salió en 2023.'];
    const args = '!dios_fua qué opinas de Final Fantasy XVI'.split(' ');
    await ai.handleQuestion(client, '#parlusorum', tagsFor(userSeq++), args);
    assert.equal(calls.length, 1);
    assert.match(sent[0], /juego de rol y aventura de Square Enix/);
  });
});

describe('conversación por usuario: las menciones no heredan lo de !dios_fua', () => {
  test('getUserConversation filtra por origen', () => {
    const id = `conv-${userSeq++}`;
    chatMemory.addToUserConversation(id, 'user', 'vlxj97: quién es el jefe final', 'diosfua');
    chatMemory.addToUserConversation(id, 'assistant', 'El jefe final es Bahamut, el dragón legendario.', 'diosfua');
    chatMemory.addToUserConversation(id, 'user', 'vlxj97: dios fua qué tal', 'mention');
    chatMemory.addToUserConversation(id, 'assistant', 'Aquí, con el FUA a tope.', 'mention');
    assert.equal(chatMemory.getUserConversation(id).length, 4, 'sin origen: todo (compatibilidad)');
    const mention = chatMemory.getUserConversation(id, { origin: 'mention' });
    assert.deepEqual(
      mention.map((m) => m.content),
      ['vlxj97: dios fua qué tal', 'Aquí, con el FUA a tope.'],
    );
    assert.ok(!JSON.stringify(mention).includes('Bahamut'));
    assert.equal(chatMemory.getUserConversation(id, { origin: 'diosfua' }).length, 2);
  });

  test('una mención tras un !dios_fua con «Bahamut» no le pasa ese turno al modelo', async () => {
    const id = userSeq++;
    chatMemory.addToUserConversation(String(id), 'user', 'vlxj97: quién es el jefe final', 'diosfua');
    chatMemory.addToUserConversation(
      String(id),
      'assistant',
      'El jefe final es Bahamut, el dragón legendario.',
      'diosfua',
    );
    replies = ['Claro que me importa, que para eso soy el FUA del chat.'];
    const result = await ai.checkPatternMatch(client, '#parlusorum', tagsFor(id), '@dios_fua a ti qué te importa');
    assert.equal(result, true);
    assert.ok(calls.length >= 1);
    assert.ok(!JSON.stringify(calls[0].messages).includes('Bahamut'), 'el turno de !dios_fua no entra en la mención');
    assert.match(sent[0], /me importa/);
  });
});

describe('!quemeperdi con hechos', () => {
  const setup = () => {
    currentGame = 'Shadow of the Colossus';
    state.setStreamIsLive(true);
    state.setStreamStartedAt(Date.now() - 80 * 60000);
    state.setDeathCount(0);
    state.setPlayer('manu');
    chatMemory.addToHistory('markosssx', 'jajaja menuda caída', 'u1');
    chatMemory.addToHistory('gangar79', 'coto amenaza de bomba en el bahia sur', 'u2');
  };

  test('validateQueMePerdi con hechos rechaza la respuesta real («Pao está ahí en la grada»)', () => {
    const facts = buildRecapFacts({ game: 'Shadow of the Colossus', minutes: 80, deathCount: 0, player: 'Manu' });
    const ctx = { deathCount: 0, bosses: 0, facts, game: 'Shadow of the Colossus', player: 'manu', minutes: 80 };
    assert.match(q.validateQueMePerdi(REAL_QUEMEPERDI, ctx), /nombra a Pao/);
    assert.equal(
      q.validateQueMePerdi(
        'Llevamos una hora y pico de Shadow of the Colossus con Manu al mando. El chat no para de reírse y el FUA sigue en guardia.',
        ctx,
      ),
      null,
    );
    // sin hechos (uso antiguo) no se aplican las reglas nuevas
    assert.equal(q.validateQueMePerdi('Pao anima desde la grada y Manu sigue explorando con calma.', {}), null);
  });

  test('el modelo recibe los hechos y no el chat; una respuesta que se sale de ellos se reintenta', async () => {
    setup();
    replies = [
      REAL_QUEMEPERDI,
      'Llevamos una hora y pico de Shadow of the Colossus con Manu al mando. El chat no para de reírse y el FUA sigue en guardia.',
    ];
    try {
      await ai.handleQueMePerdi(client, '#parlusorum', tagsFor(userSeq++));
    } finally {
      state.setStreamIsLive(false);
      state.setStreamStartedAt(null);
    }
    assert.equal(calls.length, 2);
    const user = calls[0].messages.at(-1).content;
    assert.match(
      user,
      /<hechos>\nh1\. Juegan a Shadow of the Colossus y juega Manu\nh2\. Llevan una hora y pico de directo/,
    );
    assert.doesNotMatch(JSON.stringify(calls[0].messages), /bomba|bahia|markosssx|gangar79|<chat>/);
    assert.match(
      calls[1].messages[0].content,
      /<correccion>Habla solo de quien juega según los hechos\.<\/correccion>/,
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^@vlxj97 Llevamos una hora y pico de Shadow of the Colossus/);
    assert.doesNotMatch(sent[0], /Pao|grada/);
  });

  test('si los dos intentos se salen de los hechos, sale la frase fija con los datos reales', async () => {
    setup();
    replies = [REAL_QUEMEPERDI, REAL_QUEMEPERDI];
    try {
      await ai.handleQueMePerdi(client, '#parlusorum', tagsFor(userSeq++));
    } finally {
      state.setStreamIsLive(false);
      state.setStreamStartedAt(null);
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Shadow of the Colossus/);
    assert.doesNotMatch(sent[0], /Pao|grada/);
  });
});
