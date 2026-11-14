#!/usr/bin/env node
/**
 * Limpia filas concretas de stream_memory con datos inventados (directos del 12 y 13-11: ids 216-220).
 *
 *   node scripts/limpiar-memoria.js                 → --dry-run: solo muestra lo que haría (por defecto)
 *   node scripts/limpiar-memoria.js --apply         → pide confirmación y escribe
 *   node scripts/limpiar-memoria.js --ids 216,217   → otras filas (por defecto 216-220)
 *
 * Por fila (datos de stream_sessions, vía session_id):
 *   - directo de menos de 20 minutos → se BORRA la fila;
 *   - el resto → se REESCRIBE con el texto fijo de hechos (juego, duración, caídas, jefes), sin momentos ni frases del chat.
 * Una fila sin sesión o sin duración no se toca (se avisa). Nunca toca otra fila que las indicadas. No muestra credenciales.
 */
require('dotenv').config();

const readline = require('readline');
const quality = require('../src/ai/quality');
const { MIN_SUMMARY_MINUTES } = require('../src/utils/stream-session');

const DEFAULT_IDS = [216, 217, 218, 219, 220];

// Puro: decide qué hacer con cada fila. rows: filas de stream_memory; sessions: filas de stream_sessions.
// → [{ id, action: 'delete' | 'rewrite' | 'skip', reason?, before?, after? }]
function planCleanup(rows, sessions) {
  const byId = new Map((sessions || []).map((s) => [s.id, s]));
  return (rows || []).map((row) => {
    const session = byId.get(row.session_id);
    if (!session) return { id: row.id, action: 'skip', reason: 'sin sesión asociada en stream_sessions' };
    const minutes = Number(session.duration_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0)
      return { id: row.id, action: 'skip', reason: 'la sesión no tiene duración guardada' };
    if (minutes < MIN_SUMMARY_MINUTES)
      return {
        id: row.id,
        action: 'delete',
        reason: `directo de ${minutes} min (< ${MIN_SUMMARY_MINUTES})`,
        before: row,
      };
    const game = session.game || row.game || '';
    const summary = quality.positiveSummaryFallback({
      game,
      durationMinutes: minutes,
      deathCount: session.death_count || 0,
      bosses: session.boss_count || 0,
    });
    return {
      id: row.id,
      action: 'rewrite',
      reason: `directo de ${minutes} min`,
      before: row,
      after: { game: game || null, summary, highlights: [], recurring_phrases: [] },
    };
  });
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(/^(s|si|sí|y|yes)$/i.test(a.trim()));
    }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const idsArg = args.indexOf('--ids');
  const ids =
    idsArg >= 0
      ? String(args[idsArg + 1] || '')
          .split(',')
          .map((n) => parseInt(n, 10))
          .filter(Number.isInteger)
      : DEFAULT_IDS;
  if (!ids.length) {
    console.error('--ids necesita una lista de números separados por comas.');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Faltan las variables de Supabase en el entorno.');
    process.exit(1);
  }
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data: rows, error } = await db.from('stream_memory').select('*').in('id', ids).order('id');
  if (error) throw new Error(`Lectura de stream_memory: ${error.message}`);
  const missing = ids.filter((id) => !(rows || []).some((r) => r.id === id));
  const sessionIds = [...new Set((rows || []).map((r) => r.session_id).filter((n) => n != null))];
  let sessions = [];
  if (sessionIds.length) {
    const res = await db.from('stream_sessions').select('*').in('id', sessionIds);
    if (res.error) throw new Error(`Lectura de stream_sessions: ${res.error.message}`);
    sessions = res.data || [];
  }

  const plan = planCleanup(rows, sessions);
  console.log(apply ? 'MODO --apply (escribirá tras confirmar)\n' : 'MODO --dry-run (no escribe nada)\n');
  for (const p of plan) {
    const r = (rows || []).find((x) => x.id === p.id);
    console.log(
      `#${p.id} ${r?.stream_date} · ${r?.game || 'sin juego'} → ${p.action.toUpperCase()}${p.reason ? ` (${p.reason})` : ''}`,
    );
    if (r) console.log(`   antes:   ${String(r.summary).slice(0, 160)}`);
    if (p.after) console.log(`   después: ${p.after.summary}   [momentos y frases vacíos]`);
  }
  if (missing.length) console.log(`\nIds que no existen (se ignoran): ${missing.join(', ')}`);

  const todo = plan.filter((p) => p.action !== 'skip');
  console.log(
    `\nResumen: ${plan.filter((p) => p.action === 'delete').length} a borrar, ${plan.filter((p) => p.action === 'rewrite').length} a reescribir, ${plan.filter((p) => p.action === 'skip').length} sin tocar.`,
  );
  if (!apply) {
    console.log('Para ejecutarlo: node scripts/limpiar-memoria.js --apply');
    return;
  }
  if (!todo.length) return console.log('Nada que escribir.');
  if (!(await confirm(`¿Aplicar estos ${todo.length} cambios en Supabase? (s/N) `)))
    return console.log('Cancelado, no se ha escrito nada.');

  for (const p of todo) {
    // .eq('id') en cada operación: solo esa fila
    const q = db.from('stream_memory');
    const res = p.action === 'delete' ? await q.delete().eq('id', p.id) : await q.update(p.after).eq('id', p.id);
    console.log(`#${p.id} ${p.action}: ${res.error ? `ERROR ${res.error.message}` : 'ok'}`);
  }
}

module.exports = { planCleanup, DEFAULT_IDS };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
