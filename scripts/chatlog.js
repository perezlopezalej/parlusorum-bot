#!/usr/bin/env node
/**
 * Exporta el chat registrado en Supabase a logs/chat-AAAA-MM-DD.txt
 *
 *   npm run chatlog                  # última sesión de stream
 *   npm run chatlog -- 2026-10-27    # un día (hora local)
 *
 * Formato: "HH:MM:SS usuario: mensaje"; los del bot llevan [origen] tras el usuario.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { formatChat, dayRange, localDateStr } = require('../src/utils/chatlog');

const PAGE = 1000;

async function fetchRows(db, applyFilter) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const q = applyFilter(db.from('chat_log').select('*')).order('created_at').order('id').range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function main() {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Faltan SUPABASE_URL o SUPABASE_KEY');
    process.exit(1);
  }
  const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const arg = process.argv[2];

  let rows, label;
  if (arg) {
    const range = dayRange(arg);
    if (!range) { console.error(`Fecha no válida: "${arg}" (usa AAAA-MM-DD)`); process.exit(1); }
    rows = await fetchRows(db, q => q.gte('created_at', range.from).lt('created_at', range.to));
    label = arg;
  } else {
    const { data, error } = await db.from('stream_sessions').select('id, started_at').order('started_at', { ascending: false }).limit(1);
    if (error) throw error;
    if (!data.length) { console.error('No hay sesiones de stream registradas'); process.exit(1); }
    rows = await fetchRows(db, q => q.eq('session_id', data[0].id));
    label = localDateStr(new Date(data[0].started_at));
    console.log(`Última sesión: ID ${data[0].id} (${label})`);
  }

  if (!rows.length) { console.error('Sin mensajes para exportar'); process.exit(1); }
  const dir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `chat-${label}.txt`);
  fs.writeFileSync(file, formatChat(rows));
  console.log(`${rows.length} mensajes → ${file}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
