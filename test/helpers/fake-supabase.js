// Cliente Supabase falso en memoria para tests: solo los operadores que usa el bot.
// No valida la semántica real de PostgREST (por eso existe `npm run forget -- <login> --dry-run`).
function createFakeSupabase(initial = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map(r => ({ ...r }));
  let autoId = 1000;

  const tbl = name => (tables[name] = tables[name] || []);

  function from(name) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let onConflict = null;
    let countMode = false;
    let wantRows = false;
    let limitN = null;
    let single = null;
    let columns = null;

    const q = {
      select(cols) { if (op !== 'select') wantRows = true; if (typeof cols === 'string' && cols.trim() !== '*') columns = cols.split(',').map(c => c.trim()); return q; },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return q; },
      upsert(rows, opts = {}) { op = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; onConflict = String(opts.onConflict || '').split(',').filter(Boolean); return q; },
      update(patch) { op = 'update'; payload = patch; return q; },
      delete(opts = {}) { op = 'delete'; countMode = !!opts.count; return q; },
      eq(c, v) { filters.push(r => r[c] === v); return q; },
      neq(c, v) { filters.push(r => r[c] !== v); return q; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
      lt(c, v) { filters.push(r => r[c] != null && r[c] < v); return q; },
      lte(c, v) { filters.push(r => r[c] != null && r[c] <= v); return q; },
      gt(c, v) { filters.push(r => r[c] != null && r[c] > v); return q; },
      gte(c, v) { filters.push(r => r[c] != null && r[c] >= v); return q; },
      is(c, v) { filters.push(r => (r[c] ?? null) === v); return q; },
      not(c, o, v) { if (o === 'is') filters.push(r => (r[c] ?? null) !== v); return q; },
      contains(c, arr) { filters.push(r => Array.isArray(r[c]) && arr.every(x => r[c].includes(x))); return q; },
      ilike(c, pat) {
        // Semántica LIKE de Postgres: % = cualquier cosa, _ = un carácter, \\x = x literal
        let re = '';
        const src = String(pat);
        for (let k = 0; k < src.length; k++) {
          const ch = src[k];
          if (ch === '\\' && k + 1 < src.length) re += src[++k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          else if (ch === '%') re += '.*';
          else if (ch === '_') re += '.';
          else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        const rx = new RegExp('^' + re + '$', 'i');
        filters.push(r => rx.test(String(r[c] ?? '')));
        return q;
      },
      order() { return q; },
      range() { return q; },
      limit(n) { limitN = n; return q; },
      maybeSingle() { single = 'maybe'; return q; },
      single() { single = 'one'; return q; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };

    function run() {
      const rows = tbl(name);
      const match = r => filters.every(f => f(r));
      if (op === 'insert') {
        for (const p of payload) rows.push({ id: ++autoId, ...p });
        return { data: wantRows ? payload : null, error: null };
      }
      if (op === 'upsert') {
        for (const p of payload) {
          const hit = onConflict.length ? rows.find(r => onConflict.every(c => r[c] === p[c])) : null;
          if (hit) Object.assign(hit, p); else rows.push({ ...p });
        }
        return { data: null, error: null };
      }
      if (op === 'update') {
        const hits = rows.filter(match);
        hits.forEach(r => Object.assign(r, payload));
        return finish(hits);
      }
      if (op === 'delete') {
        const hits = rows.filter(match);
        tables[name] = rows.filter(r => !hits.includes(r));
        return { data: wantRows ? hits : null, error: null, count: countMode ? hits.length : null };
      }
      let hits = rows.filter(match);
      if (limitN != null) hits = hits.slice(0, limitN);
      return finish(hits);
    }

    function finish(hits) {
      if (columns) hits = hits.map(r => Object.fromEntries(columns.map(c => [c, r[c]])));
      if (single === 'maybe') return { data: hits[0] || null, error: null };
      if (single === 'one') return hits[0] ? { data: hits[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: hits.map(r => ({ ...r })), error: null, count: hits.length };
    }

    return q;
  }

  return { from, tables, rows: name => tbl(name) };
}

module.exports = { createFakeSupabase };
