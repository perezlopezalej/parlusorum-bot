#!/usr/bin/env node
/**
 * Borra (o cuenta) todos los datos guardados de un usuario de Twitch.
 *
 *   npm run forget -- <login> [--dry-run] [--id <user_id>]
 *
 * --dry-run  solo cuenta lo que borraría en cada tabla (sirve para comprobarlo contra la base real)
 *
 * Es lo mismo que hace !fua_olvidame, pero desde la terminal. No toca la RAM del bot en marcha
 * (el bot la limpia con el comando del chat) ni backups/ ni logs/ locales: bórralos a mano.
 */
require('dotenv').config();

const { forgetUser } = require('../src/privacy/forget');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const idAt = args.indexOf('--id');
  const userId = idAt >= 0 ? args[idAt + 1] : null;
  const login = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--id');
  if (!login && !userId) {
    console.error('Uso: npm run forget -- <login> [--dry-run] [--id <user_id>]');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Faltan SUPABASE_URL o SUPABASE_KEY');
    process.exit(1);
  }

  const res = await forgetUser({ userId, login, dryRun, memory: { clear: () => 0 } });
  console.log(dryRun ? 'Simulación (no se ha borrado nada):' : 'Resultado:');
  for (const [table, n] of Object.entries(res.counts)) console.log(`  ${table}: ${n}`);
  console.log(`user_id resueltos: ${res.ids.join(', ') || 'ninguno (solo por nick)'}`);
  if (!res.ok) {
    console.error(`Errores:\n  ${res.errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(dryRun ? 'OK' : 'Datos borrados.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
