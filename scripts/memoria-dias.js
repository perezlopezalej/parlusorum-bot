#!/usr/bin/env node
/**
 * Solo lectura: muestra las filas de stream_memory de los últimos N días (por defecto, desde 2026-11-12).
 *
 *   node scripts/memoria-dias.js [AAAA-MM-DD]      → resumen corto en consola, detalle en logs/memoria-dias.txt
 *
 * No escribe nada en Supabase ni muestra credenciales.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const since = process.argv[2] || '2026-11-12';
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Faltan las variables de Supabase en el entorno.');
    process.exit(1);
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data, error } = await db
    .from('stream_memory')
    .select('*')
    .gte('stream_date', since)
    .order('stream_date', { ascending: true });
  if (error) {
    console.error(`Error de lectura: ${error.message}`);
    process.exit(1);
  }
  const lines = (data || []).map((r) =>
    [
      `--- ${r.stream_date} · ${r.game || 'sin juego'} (id ${r.id ?? '?'})`,
      `Resumen: ${r.summary}`,
      `Momentos: ${JSON.stringify(r.highlights || [])}`,
      `Frases: ${JSON.stringify(r.recurring_phrases || [])}`,
    ].join('\n'),
  );
  const out = path.join(__dirname, '..', 'logs', 'memoria-dias.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n\n') + '\n');
  console.log(`${lines.length} fila(s) desde ${since} → logs/memoria-dias.txt`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
