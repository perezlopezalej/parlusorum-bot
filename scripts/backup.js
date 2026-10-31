#!/usr/bin/env node
/**
 * Exporta todas las tablas de Supabase a backups/AAAA-MM-DD/<tabla>.json
 *
 *   npm run backup
 *
 * backups/ contiene datos de usuarios y tokens: está en .gitignore, no subir.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const TABLES = [
  'users',
  'stream_sessions',
  'stream_memory',
  'stream_highlights',
  'channel_stats',
  'channel_config',
  'cooldowns',
  'user_facts',
  'channel_lore',
  'chat_log',
  'bot_self_reviews',
];
const PAGE = 1000;

async function fetchAll(db, table) {
  // Orden estable para paginar; si la columna no existe se reintenta sin orden
  for (const orderCol of ['id', 'user_id', null]) {
    const rows = [];
    let failed = false;
    for (let from = 0; ; from += PAGE) {
      let q = db.from(table).select('*');
      if (orderCol) q = q.order(orderCol);
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) {
        if (orderCol) { failed = true; break; }
        throw error;
      }
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    if (!failed) return rows;
  }
  return [];
}

async function main() {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Faltan SUPABASE_URL o SUPABASE_KEY');
    process.exit(1);
  }
  const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const dir = path.join(__dirname, '..', 'backups', new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });

  let failures = 0;
  for (const table of TABLES) {
    try {
      const rows = await fetchAll(db, table);
      fs.writeFileSync(path.join(dir, `${table}.json`), JSON.stringify(rows, null, 2));
      console.log(`${table}: ${rows.length} filas`);
    } catch (err) {
      failures++;
      console.error(`${table}: error (${err.message})`);
    }
  }
  console.log(`Backup en ${dir}`);
  if (failures) process.exit(1);
}

main().catch(err => { console.error(err.message); process.exit(1); });
