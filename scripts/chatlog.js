#!/usr/bin/env node
/**
 * Exporta el chat o el registro de calidad de Supabase a logs/
 *
 *   npm run chatlog                  # última sesión de stream
 *   npm run chatlog -- 2026-10-27    # un día (hora local)
 *
 * El chat completo (chat_log) solo existe 24 h:
 *   - Si la fecha (o la sesión) cae dentro de las últimas 24 h → chat completo → logs/chat-AAAA-MM-DD.txt
 *   - Si no → registro de calidad de 30 días (nicks seudonimizados) → logs/calidad-AAAA-MM-DD.txt
 *
 * Formato del chat: "HH:MM:SS usuario: mensaje"; los del bot llevan [origen] tras el usuario.
 * Los ficheros de logs/ no caducan solos: bórralos cuando dejes de necesitarlos (contienen datos personales).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { formatChat, dayRange, localDateStr, chooseExport } = require('../src/utils/chatlog');
const { formatQualityLog } = require('../src/privacy/quality-log');

const PAGE = 1000;

async function fetchRows(db, table, applyFilter, orderCols) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = applyFilter(db.from(table).select('*'));
    for (const c of orderCols) q = q.order(c);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

function write(name, text) {
  const dir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

async function main() {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Faltan SUPABASE_URL o SUPABASE_KEY');
    process.exit(1);
  }
  const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const arg = process.argv[2];

  let kind,
    label,
    session = null;
  if (arg) {
    if (!dayRange(arg)) {
      console.error(`Fecha no válida: "${arg}" (usa AAAA-MM-DD)`);
      process.exit(1);
    }
    kind = chooseExport({ dateStr: arg });
    label = arg;
  } else {
    const { data, error } = await db
      .from('stream_sessions')
      .select('id, started_at')
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data.length) {
      console.error('No hay sesiones de stream registradas');
      process.exit(1);
    }
    session = data[0];
    kind = chooseExport({ startedAt: session.started_at });
    label = localDateStr(new Date(session.started_at));
    console.log(`Última sesión: ID ${session.id} (${label})`);
  }

  if (kind === 'chat') {
    let rows;
    if (session) {
      rows = await fetchRows(db, 'chat_log', (q) => q.eq('session_id', session.id), ['created_at', 'id']);
    } else {
      const range = dayRange(arg);
      rows = await fetchRows(db, 'chat_log', (q) => q.gte('created_at', range.from).lt('created_at', range.to), [
        'created_at',
        'id',
      ]);
    }
    if (!rows.length) {
      console.error('Sin mensajes para exportar');
      process.exit(1);
    }
    console.log(`${rows.length} mensajes → ${write(`chat-${label}.txt`, formatChat(rows))}`);
    console.log('Recuerda: el chat completo caduca a las 24 h en Supabase; esta copia local no.');
    return;
  }

  // Más de 24 h: solo queda el registro de calidad
  console.log('El chat completo ya no existe (solo se guarda 24 h): exporto el registro de calidad.');
  const rows = session
    ? await fetchRows(db, 'quality_log', (q) => q.eq('session_id', session.id), ['id'])
    : await fetchRows(db, 'quality_log', (q) => q.eq('stream_date', arg), ['id']);
  if (!rows.length) {
    console.error('Sin registro de calidad para esa fecha (se conserva 30 días)');
    process.exit(1);
  }
  console.log(`${rows.length} filas → ${write(`calidad-${label}.txt`, formatQualityLog(rows))}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
