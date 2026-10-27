process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Stubs de dependencias externas (Supabase, Groq, logger, state) antes de cargar los handlers
const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const db = { memories: [], saved: [], lore: [], upserts: [], sample: '', sessionId: 's1', getCalls: 0, fail: false };
const groq = { reply: null, error: null, calls: 0 };

stub('src/utils/supabase.js', {
  saveStreamMemory: async m => { db.saved.push(m); },
  getRecentStreamMemory: async () => { db.getCalls++; if (db.fail) throw new Error('db down'); return db.memories; },
  endStreamSession: async () => {},
  saveUserFact: () => {},
  getLoreRows: async statuses => db.lore.filter(r => !statuses || statuses.includes(r.status)),
  upsertLoreRows: async rows => { db.upserts.push(rows); return true; },
  updateLoreStatus: async (id, status, from) => {
    const r = db.lore.find(x => x.id === id && from.includes(x.status));
    if (!r) return null;
    r.status = status;
    return r;
  },
  getCurrentSessionId: () => db.sessionId
});
stub('src/utils/groq-utils.js', {
  GROQ_MODEL_FAST: 'fast',
  groqWithRetry: async () => {
    groq.calls++;
    if (groq.error) throw groq.error;
    return { choices: [{ message: { content: groq.reply } }] };
  }
});
stub('src/utils/logger.js', { info() {}, warn() {}, error() {}, debug() {} });
stub('src/utils/state.js', { getLoreSample: () => db.sample });

const memory = require('../src/memory/handler');
const lore = require('../src/lore/handler');

const stats = { game: 'Elden Ring', durationMinutes: 90, deathCount: 7, peakViewers: 12, topCommands: [], activeUsers: ['ana'] };

beforeEach(() => {
  Object.assign(db, { memories: [], saved: [], lore: [], upserts: [], sample: '', fail: false, getCalls: 0 });
  Object.assign(groq, { reply: null, error: null, calls: 0 });
  memory.invalidateMemoryCache();
  lore.invalidateLoreCache();
});

describe('memoria entre streams: generación', () => {
  test('parsea el JSON de la IA aunque venga con backticks', async () => {
    groq.reply = '```json\n{"summary":"épico","highlights":["a"],"recurringPhrases":["fua"]}\n```';
    const m = await memory.onStreamEnd(stats, 'ana: fua');
    assert.equal(m.summary, 'épico');
    assert.deepEqual(m.highlights, ['a']);
    assert.equal(db.saved.length, 1);
  });

  test('si Groq falla usa el resumen sin IA y sigue guardando', async () => {
    groq.error = new Error('503');
    const m = await memory.onStreamEnd(stats, '');
    assert.match(m.summary, /90 minutos con 7 muertes/);
    assert.deepEqual(m.highlights, []);
    assert.equal(db.saved.length, 1);
  });

  test('si la IA devuelve basura (no JSON) también degrada sin IA', async () => {
    groq.reply = 'lo siento, no puedo';
    const m = await memory.onStreamEnd(stats, '');
    assert.match(m.summary, /90 minutos/);
  });
});

describe('memoria entre streams: contexto y caché', () => {
  const row = {
    stream_date: '2026-10-01', game: 'Elden Ring', summary: 'Stream <caótico>\n{ok}',
    highlights: ['h1', 'h2', 'h3'], recurring_phrases: ['fua total']
  };

  test('sin memorias devuelve cadena vacía', async () => {
    assert.equal(await memory.getMemoryContext(), '');
  });

  test('sanea el resumen (saltos de línea y <>{}) y limita momentos a 2', async () => {
    db.memories = [row];
    const ctx = await memory.getMemoryContext();
    assert.match(ctx, /Stream caótico ok/);
    assert.doesNotMatch(ctx, /[<>{}]/);
    assert.match(ctx, /Momentos: h1, h2\./);
    assert.doesNotMatch(ctx, /h3/);
    assert.match(ctx, /Frases del chat: "fua total"/);
  });

  test('la caché evita repetir la consulta hasta invalidarla', async () => {
    db.memories = [row];
    await memory.getMemoryContext();
    await memory.getMemoryContext();
    assert.equal(db.getCalls, 1);
    memory.invalidateMemoryCache();
    await memory.getMemoryContext();
    assert.equal(db.getCalls, 2);
  });

  test('la caché caduca tras el TTL de 10 min', async () => {
    db.memories = [row];
    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0;
      await memory.getMemoryContext();
      Date.now = () => t0 + 9 * 60 * 1000;
      await memory.getMemoryContext();
      assert.equal(db.getCalls, 1);
      Date.now = () => t0 + 10 * 60 * 1000 + 1;
      await memory.getMemoryContext();
      assert.equal(db.getCalls, 2);
    } finally {
      Date.now = realNow;
    }
  });

  test('si Supabase falla devuelve vacío sin lanzar', async () => {
    db.fail = true;
    assert.equal(await memory.getMemoryContext(), '');
  });
});

describe('lore aprendido', () => {
  const base = (o = {}) => ({
    id: 1, term: 'fua total', term_key: 'fua total', kind: 'meme', status: 'pending',
    needs_approval: false, streams_count: 1, total_count: 1, users: ['a'], users_count: 1,
    missed_streams: 0, last_stream_id: 'old', ...o
  });
  const chat = ['b: fua total!', 'c: FUA total jaja', 'd: otra cosa'].join('\n');
  const saved = () => db.upserts.flat();

  test('promoción: pending pasa a active con >=2 streams y >=3 usuarios', async () => {
    db.lore = [base()]; db.sample = chat; groq.reply = '[]';
    await lore.onStreamEndLore({});
    const r = saved().find(x => x.term_key === 'fua total');
    assert.equal(r.status, 'active');
    assert.equal(r.streams_count, 2);
    assert.equal(r.users_count, 3);
  });

  test('no promociona con pocos usuarios', async () => {
    db.lore = [base({ users: [], users_count: 0 })]; db.sample = 'b: fua total'; groq.reply = '[]';
    await lore.onStreamEndLore({});
    assert.equal(saved()[0].status, 'pending');
  });

  test('pendiente de aprobación (needs_approval) no se promociona sola', async () => {
    db.lore = [base({ needs_approval: true })]; db.sample = chat; groq.reply = '[]';
    await lore.onStreamEndLore({});
    assert.equal(saved()[0].status, 'pending');
  });

  test('mismo stream no suma streams_count dos veces', async () => {
    db.lore = [base({ last_stream_id: 's1' })]; db.sample = chat; groq.reply = '[]';
    await lore.onStreamEndLore({});
    assert.equal(saved()[0].streams_count, 1);
  });

  test('decaimiento: suma missed_streams cuando no aparece', async () => {
    db.lore = [base({ status: 'active', missed_streams: 2 })]; db.sample = 'b: hola'; groq.reply = '[]';
    await lore.onStreamEndLore({});
    assert.equal(saved()[0].missed_streams, 3);
    assert.equal(saved()[0].status, 'active');
  });

  test('archivado al llegar a 8 streams sin aparecer', async () => {
    db.lore = [base({ status: 'active', missed_streams: 7 })]; db.sample = 'b: hola'; groq.reply = '[]';
    await lore.onStreamEndLore({});
    assert.equal(saved()[0].status, 'archived');
  });

  test('sin chat no suma ni penaliza', async () => {
    db.lore = [base({ status: 'active' })];
    await lore.onStreamEndLore({});
    assert.equal(db.upserts.length, 0);
    assert.equal(groq.calls, 0);
  });

  test('candidatos: descarta inventados y temas a evitar; apodos requieren aprobación', async () => {
    db.sample = ['b: el gran pollo', 'c: el gran pollo', 'd: dios porno', 'e: soy ana'].join('\n');
    groq.reply = JSON.stringify([
      { term: 'el gran pollo', kind: 'apodo' },
      { term: 'no existe en chat', kind: 'meme' },
      { term: 'dios porno', kind: 'meme' }
    ]);
    await lore.onStreamEndLore({});
    const rows = saved();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].term_key, 'el gran pollo');
    assert.equal(rows[0].needs_approval, true);
    assert.equal(rows[0].status, 'pending');
  });

  test('si falla la IA aún actualiza el lore existente (degradación sin IA)', async () => {
    db.lore = [base({ status: 'active' })]; db.sample = 'b: hola'; groq.error = new Error('down');
    await lore.onStreamEndLore({});
    assert.equal(saved()[0].missed_streams, 1);
  });

  test('getLoreContext: solo activos, omite pesos 0 y temas a evitar, y cachea', async () => {
    db.lore = [
      base({ id: 1, term: 'bueno', status: 'active' }),
      base({ id: 2, term: 'muerto', status: 'active', missed_streams: 8 }),
      base({ id: 3, term: 'porno', status: 'active' }),
      base({ id: 4, term: 'pendiente', status: 'pending' })
    ];
    const ctx = await lore.getLoreContext();
    assert.match(ctx, /"bueno" \(meme\)/);
    assert.doesNotMatch(ctx, /muerto|porno|pendiente/);
    db.lore = [];
    assert.equal(await lore.getLoreContext(), ctx);
  });

  test('getLoreContext ordena por peso (el decaído va después)', async () => {
    db.lore = [
      base({ id: 1, term: 'viejo', status: 'active', missed_streams: 6 }),
      base({ id: 2, term: 'nuevo', status: 'active' })
    ];
    const ctx = await lore.getLoreContext();
    assert.ok(ctx.indexOf('nuevo') < ctx.indexOf('viejo'));
  });

  test('getLoreOverview marca con * los pendientes que requieren aprobación', async () => {
    db.lore = [base({ id: 5, term: 'x pollo', needs_approval: true }), base({ id: 6, term: 'y', status: 'active' })];
    const o = await lore.getLoreOverview();
    assert.deepEqual(o.pending, ['#5 x pollo*']);
    assert.deepEqual(o.active, ['#6 y']);
  });

  test('approveLore / deleteLore cambian el estado', async () => {
    db.lore = [base({ id: 9, status: 'pending' })];
    assert.equal((await lore.approveLore(9)).status, 'active');
    assert.equal(await lore.approveLore(99), null);
    assert.equal((await lore.deleteLore(9)).status, 'rejected');
  });

  test('getManualLore incluye los temas a evitar', () => {
    assert.match(lore.getManualLore(), /Temas a evitar/);
  });
});
