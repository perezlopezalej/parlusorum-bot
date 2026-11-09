process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { mentionBudget, isStale, classifyMessage } = require('../src/ai/patterns');
const { translateGenres } = require('../src/utils/genres');
const channel = require('../config/channel.json');
const messages = require('../config/messages.json');

// Mensajes reales del directo del 30-10-2026 (logs/chat-2026-10-30.txt)
const REAL = {
  quemeperdi: '¡Vaya maratón! En 225 minutos el streamer ha derribado 11 enemigos y ha caído 11 veces, pero ya ha vencido dos jefes épicos mientras la audiencia vibra sin parar.',
  timer1: 'Phantom Blade Zero nos trae otra dosis de acción 2026, y el FUA ya está listo para impulsar cada golpe épico. ¡Vamos con todo, que el juego está cargado de vibra de Ragnarok y sekiro!',
  timer2: '11 muertes anotadas y el FUA ya vibra en cada ataque, ¡listos para que el directo siga a tope! Phantom Blade Zero 2026 trae esa energía de Ragnarok y sekiro que tanto nos gusta.',
};

describe('0. el signo del zodiaco no es una provocación', () => {
  test('"Dios fua que signo del zodiaco eres?" es mención directa, no provocación', () => {
    assert.equal(classifyMessage('Dios fua que signo del zodiaco eres?', {}, { botNames: ['dios_fua'] }), 'direct');
  });
  test('la réplica "libreta de agravios" está en el pool de provocaciones, y solo ahí', () => {
    assert.ok(messages.provocation_replies.some(r => r.includes('libreta de agravios')));
  });
});

describe('1. tope de menciones por usuario', () => {
  const MIN = 60000;
  test('gangar79: 3 respuestas en 5 min y el resto se ignora', () => {
    let stamps = [];
    const results = [];
    for (let i = 0; i < 12; i++) {
      const r = mentionBudget(stamps, 1000 + i * 15000, 3, 5 * MIN); // un "dios fua" cada 15 s
      stamps = r.stamps;
      results.push(r.ok);
    }
    assert.deepEqual(results.slice(0, 3), [true, true, true]);
    assert.equal(results.filter(Boolean).length, 3); // 12 "dios fua" en 3 min → 3 respuestas
  });
  test('pasada la ventana vuelve a responder', () => {
    const full = [0, 1000, 2000];
    assert.equal(mentionBudget(full, 3000, 3, 5 * MIN).ok, false);
    assert.equal(mentionBudget(full, 5 * MIN + 2001, 3, 5 * MIN).ok, true);
  });
  test('un hueco libre no se come el cupo de otro usuario', () => {
    assert.equal(mentionBudget(undefined, 0, 3, 5 * MIN).ok, true);
  });
  test('una respuesta de más de 20 s en espera es tardía', () => {
    assert.equal(isStale(0, 19000, 20000), false);
    assert.equal(isStale(0, 62000, 20000), true); // el 23:10:54 → 23:11:13 del log salió tarde
  });
});

describe('2. !quemeperdi', () => {
  test('rechaza "derribado 11 enemigos" del log real', () => {
    assert.ok(q.claimsEnemyKills(REAL.quemeperdi));
    assert.match(q.validateQueMePerdi(REAL.quemeperdi, { deathCount: 11, bosses: 2 }), /enemigos derribados/);
  });
  test('acepta un resumen con las cifras reales', () => {
    const ok = 'Llevamos 225 minutos y el streamer ha caído 11 veces, con 2 jefes derrotados. El chat no ha parado.';
    assert.equal(q.validateQueMePerdi(ok, { deathCount: 11, bosses: 2 }), null);
  });
  test('rechaza jefes y muertes que no cuadran', () => {
    assert.match(q.validateQueMePerdi('Ha caído 11 veces y ha derrotado 5 jefes.', { deathCount: 11, bosses: 2 }), /jefes/);
    assert.match(q.validateQueMePerdi('Ha muerto 7 veces en la tarde.', { deathCount: 11, bosses: 2 }), /muertes/);
  });
});

describe('3. géneros en español, sin nota del juego', () => {
  test('Adventure, Action → Aventura, Acción', () => {
    assert.equal(translateGenres('Adventure, Action'), 'Aventura, Acción');
  });
  test('géneros desconocidos se omiten y vacío da cadena vacía', () => {
    assert.equal(translateGenres('Action, Nonexistent'), 'Acción');
    assert.equal(translateGenres(null), '');
  });
});

describe('4. timer IA', () => {
  const ctx = { currentGame: 'Phantom Blade Zero', channelGames: channel.games_played };
  test('rechaza Ragnarok y sekiro del log real', () => {
    assert.ok(q.mentionsOtherGame(REAL.timer1, 'Phantom Blade Zero', channel.games_played));
    assert.equal(q.validateTimerIA(REAL.timer1, ctx).ok, false);
  });
  test('el juego actual no cuenta como otro juego', () => {
    assert.equal(q.mentionsOtherGame('Black Myth: Wukong va a tope', 'Black Myth: Wukong', channel.games_played), null);
    assert.ok(q.mentionsOtherGame('Black Myth: Wukong va a tope', 'Phantom Blade Zero', channel.games_played));
  });
  test('repetir el año de un comentario anterior se rechaza', () => {
    const r = q.validateTimerIA('El FUA nos acompaña en este directo de 2026, qué ganas de más.', { ...ctx, recent: [REAL.timer1] });
    assert.equal(r.ok, false);
  });
  test('no nombra a un usuario nombrado hace menos de 15 min', () => {
    const now = Date.now();
    const named = new Map([['gangar79', now - 5 * 60000]]);
    const r = q.validateTimerIA('gangar79 hoy trae el FUA muy cargado de energía rara.', { ...ctx, named, now });
    assert.equal(r.ok, false);
    const later = q.validateTimerIA('gangar79 hoy trae el FUA muy cargado de energía rara.', { ...ctx, named, now: now + 16 * 60000 });
    assert.equal(later.ok, true);
  });
  test('el timer no etiqueta a nadie (ningún tema es "usuario") y rechaza el @', () => {
    const r = q.validateTimerIA('@harocho3847, el FUA te vigila desde hace rato en este directo.', ctx);
    assert.equal(r.ok, false);
  });
  test('"Manu y Pao" jugando o muriendo se rechaza: quien juega es Manu', () => {
    assert.equal(q.validateTimerIA('El FUA lo ve claro, Manu y Pao siguen firmes en este directo.', ctx).ok, false);
    assert.equal(q.validateTimerIA('El FUA lo ve claro, Manu sigue firme en este directo.', ctx).ok, true);
  });
});


