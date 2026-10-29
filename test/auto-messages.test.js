process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { parseVerdict, buildCheckPrompt } = require('../src/ai/factcheck');
const n = require('../src/utils/narrative');
const timers = require('../config/commands.json').timers;

// Mensajes reales del directo del 29-10-2026 (logs/chat-2026-10-29.txt)
const REAL = {
  cohostArmas: 'Los jefes están sacando armas de fuego y las espadones se están volviendo casi como escudos en esta fase.',
  cohostFase4: 'Es perfecto que el chat esté recordando el combo esquivar‑parry; el jefe de la fase 4 solo tiene esa ventana cuando su ataque rojo aparece, así que es la clave para evitar ese daño crítico.',
  cohostBarra: 'Manu, la clave es sincronizar el cambio de arma justo cuando la barra amarilla toca el punto crítico; así evitas el daño y mantienes el flujo.',
  cohostTorre: 'La torre sigue dándole reto, pero con un poco de atención al detalle todo se puede sortear.',
  cohostMuerte: 'Muerte #1 del streamer a 11 minutos, parece que el combo de enemigos está más agresivo de lo esperado.',
  timerCombo: 'Curioso que el combo espada‑disparo tenga recarga tan corta, perfecto para lanzar FUAs sin pausa.',
  timerRawg: 'Phantom Blade Zero se cree el rey del hack‑and‑slash, pero a veces parece más un tutorial de cómo tropezar con los enemigos ‒ ¡FUA y a seguir cortando!',
  timerNota: 'Phantom Blade Zero parece que se quedó atrapado en modo “beta eternamente”, pero con cada golpe te sientes como dios fua en su trono de espadas. 3.33/5 en RAWG, ¡así que a darle FUA a esos jefes!',
  timerCorto: 'Phantom Blade Zero se cree el rey del hack‑n‑slash y termina siendo un “cortito de nivel medio” 3.33/5… ¡pero al menos nos da buen rollo para lanzar el FUA!',
  timerOk: '¡Otra hora de directo y el FUA sigue sin cansarse, chat!',
  hookOk: 'Cuantas muertes creeis que habra hoy? 💀',
  hookJefe: 'Phantom Blade Zero te lanza combos brutales, pero el FUA es la única arma contra esos jefes imposibles.',
};
const askDifficulty = 'dios fua en este juego se puede aumentar la dificultad mas adelante?';
const askPhysical = '@dios_fua cuándo sale la versión física de Phantom Blade Zero?';

describe('mecánicas y desprecio del juego en mensajes automáticos', () => {
  test('cohost con armas, fases o combos se rechaza', () => {
    for (const k of ['cohostArmas', 'cohostFase4', 'cohostBarra', 'cohostTorre']) {
      assert.equal(q.validateCohost(REAL[k], { deathCount: 11 }).ok, false, k);
    }
  });
  test('cohost sin juego pasa', () => {
    assert.equal(q.validateCohost('Dos muertes seguidas y el FUA ya está haciendo estiramientos.', { deathCount: 2 }).ok, true);
  });
  test('muerte real con "combo de enemigos" se rechaza por mecánicas', () => {
    assert.match(q.validateCohost(REAL.cohostMuerte, { deathCount: 1 }).reason, /mecánicas/);
  });
  test('hook sobre jefes con armas se rechaza; el de las muertes pasa', () => {
    assert.equal(q.validateHook(REAL.hookJefe, { deathCount: 15 }).ok, false);
    assert.equal(q.validateHook(REAL.hookOk, { deathCount: 3 }).ok, true);
  });
  test('timer IA: combos, nota de RAWG y desprecio se rechazan', () => {
    for (const k of ['timerCombo', 'timerRawg', 'timerNota', 'timerCorto']) {
      assert.equal(q.validateTimerIA(REAL[k], { deathCount: 12 }).ok, false, k);
    }
    assert.equal(q.validateTimerIA(REAL.timerOk, { deathCount: 0 }).ok, true);
  });
  test('timer IA: cita de la nota y desprecio dan motivos distintos', () => {
    assert.match(q.validateTimerIA('Un juego con 3.33/5, ojo al dato, FUA.', {}).reason, /RAWG/);
    assert.match(q.validateTimerIA('Qué juego tan aburrido, pero el FUA manda.', {}).reason, /desprecia/);
  });
  test('timer IA no repite ideas del stream', () => {
    assert.equal(q.validateTimerIA('Otra hora de directo y el FUA sigue sin cansarse, chat.', { recent: [REAL.timerOk] }).ok, false);
  });
  test('timer IA con contador a 0 no habla de muertes', () => {
    assert.equal(q.validateTimerIA('El streamer cae otra vez y el FUA lo levanta.', { deathCount: 0 }).ok, false);
  });
});

describe('preguntas a menciones', () => {
  test('preguntas concretas del juego se detectan', () => {
    assert.equal(q.isGameQuestion(askDifficulty), true);
    assert.equal(q.isGameQuestion(askPhysical), true);
  });
  test('charla normal no es pregunta del juego', () => {
    assert.equal(q.isGameQuestion('dios fua qué tal estás?'), false);
    assert.equal(q.isGameQuestion('Jajajaja'), false);
  });
  test('preguntas por las muertes', () => {
    assert.equal(q.isDeathQuestion('dios fua cuántas muertes llevamos?'), true);
    assert.equal(q.isDeathQuestion('llevamos muchas muertes?'), true);
    assert.equal(q.isDeathQuestion('dios fua qué tal'), false);
  });
});

describe('comprobación SÍ/NO', () => {
  test('parseVerdict', () => {
    assert.equal(parseVerdict('NO'), 'no');
    assert.equal(parseVerdict(' No.'), 'no');
    assert.equal(parseVerdict('SÍ'), 'yes');
    assert.equal(parseVerdict('si, afirma'), 'yes');
    assert.equal(parseVerdict(''), null);
    assert.equal(parseVerdict('Quizá'), null);
    assert.equal(parseVerdict(undefined), null);
  });
  test('prompt de RAWG y de stream', () => {
    assert.match(buildCheckPrompt('x', 'Género: acción', 'rawg'), /resultado de RAWG/);
    assert.match(buildCheckPrompt('x', '', 'stream'), /\(ninguno\)/);
  });
});

describe('cohost por eventos', () => {
  const now = 1_000_000_000;
  const death = (k, ago) => ({ type: 'death', description: `Muerte #${k} del streamer en este stream`, ts: now - ago });

  test('primera muerte comenta; la segunda no', () => {
    assert.equal(n.classifyCohostMoment(death(1, 0), { events: [death(1, 0)], deathCount: 1, now }).kind, 'first_death');
    assert.equal(n.classifyCohostMoment(death(2, 0), { events: [death(1, 60000), death(2, 0)], deathCount: 2, now }), null);
  });
  test('racha de 3 seguidas', () => {
    const ev = [death(1, 400000), death(2, 200000), death(3, 0)];
    assert.equal(n.classifyCohostMoment(ev[2], { events: ev, deathCount: 3, now }).kind, 'streak');
  });
  test('un boss corta la racha', () => {
    const ev = [death(1, 400000), death(2, 300000), { type: 'boss', description: 'Boss derrotado', ts: now - 200000 }, death(3, 0)];
    assert.equal(n.classifyCohostMoment(ev[3], { events: ev, deathCount: 3, now }), null);
  });
  test('racha fuera de ventana no cuenta', () => {
    const ev = [death(1, 30 * 60000), death(2, 20 * 60000), death(3, 0)];
    assert.equal(n.classifyCohostMoment(ev[2], { events: ev, deathCount: 3, now }), null);
  });
  test('récord: supera el máximo anterior', () => {
    const e = death(16, 0);
    assert.equal(n.classifyCohostMoment(e, { events: [e], deathCount: 16, recordToBeat: 15, now }).kind, 'record');
    assert.equal(n.classifyCohostMoment(death(15, 0), { events: [death(15, 0)], deathCount: 15, recordToBeat: 15, now }), null);
  });
  test('boss, sub, raid y explosión del chat comentan; rage no', () => {
    for (const type of ['boss', 'sub', 'raid', 'victory']) {
      assert.equal(n.classifyCohostMoment({ type, description: 'x', ts: now }, { now }).kind, type);
    }
    assert.equal(n.classifyCohostMoment({ type: 'rage', description: 'x', ts: now }, { now }), null);
  });
  test('freno: 5 min entre comentarios y 6 por hora', () => {
    assert.equal(n.eventCohostAllowed({ now, lastAt: now - 4 * 60000, stamps: [] }), false);
    assert.equal(n.eventCohostAllowed({ now, lastAt: now - 6 * 60000, stamps: [] }), true);
    const six = Array.from({ length: 6 }, (_, i) => now - (10 + i * 8) * 60000);
    assert.equal(n.eventCohostAllowed({ now, lastAt: now - 6 * 60000, stamps: six }), false);
  });
  test('al azar: solo con chat tranquilo y máx. 1 por hora', () => {
    assert.equal(n.randomCohostAllowed({ now, mode: 'normal' }), false);
    assert.equal(n.randomCohostAllowed({ now, mode: 'chill' }), true);
    assert.equal(n.randomCohostAllowed({ now, mode: 'chill', lastRandomAt: now - 30 * 60000 }), false);
    assert.equal(n.randomCohostAllowed({ now, mode: 'chill', lastRandomAt: now - 61 * 60000 }), true);
    assert.equal(n.randomCohostAllowed({ now, mode: 'chill', lastAnyAt: now - 2 * 60000 }), false);
  });
});

describe('timers fijos', () => {
  test('follow como mucho cada 60 min y sin la pregunta (la cubre el hook)', () => {
    const follow = timers.find(t => /follow/i.test(t.message));
    assert.ok(follow.interval >= 60);
    assert.equal(timers.some(t => /alguna pregunta/i.test(t.message)), false);
  });
});
