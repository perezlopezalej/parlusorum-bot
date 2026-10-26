#!/usr/bin/env node
/**
 * Verifica las suscripciones EventSub registradas en Twitch.
 *
 *   node scripts/check-eventsub.js                       # usa PUBLIC_URL o https://parlusorum-bot-0j8s.onrender.com
 *   node scripts/check-eventsub.js https://x.onrender.com  # compara contra esa URL
 *   node scripts/check-eventsub.js --prune                 # borra las que apunten a otra URL
 *
 * Útil tras migrar de host: muestra si quedan callbacks apuntando al dominio viejo.
 */
require('dotenv').config();

const API = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const args = process.argv.slice(2);
const PRUNE = args.includes('--prune');
const urlArg = args.find(a => a.startsWith('http'));

const DEFAULT_URL = 'https://parlusorum-bot-0j8s.onrender.com';
const expectedBase = (urlArg || process.env.PUBLIC_URL || DEFAULT_URL)
  .trim().replace(/\/+$/, '');
const expectedCallback = `${expectedBase}/eventsub`;

async function getAppToken() {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`No se pudo obtener app token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function listAll(headers) {
  const subs = [];
  let cursor = null;
  do {
    const url = cursor ? `${API}?after=${encodeURIComponent(cursor)}` : API;
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data.message || data)}`);
    subs.push(...(data.data || []));
    cursor = data.pagination?.cursor || null;
  } while (cursor);
  return subs;
}

async function report(label, headers) {
  console.log(`\n=== ${label} ===`);
  let subs;
  try {
    subs = await listAll(headers);
  } catch (e) {
    console.log(`  ❌ No se pudo listar: ${e.message}`);
    return;
  }
  if (subs.length === 0) { console.log('  (ninguna suscripción)'); return; }

  const stale = [];
  for (const s of subs) {
    const cb = s.transport?.callback || '(sin callback)';
    const match = expectedCallback ? cb === expectedCallback : null;
    const flagUrl = match === null ? '•' : match ? '✅' : '⚠️ ';
    console.log(`  ${flagUrl} ${s.type} v${s.version}  [status: ${s.status}]  →  ${cb}`);
    if (match === false) stale.push(s);
  }

  if (stale.length === 0) return;
  console.log(`\n  ${stale.length} suscripción(es) apuntan a otra URL.`);
  if (!PRUNE) { console.log('  Ejecuta con --prune para borrarlas.'); return; }
  for (const s of stale) {
    const res = await fetch(`${API}?id=${s.id}`, { method: 'DELETE', headers });
    console.log(res.ok ? `  🗑️  Borrada ${s.type} (${s.id})` : `  ❌ Error borrando ${s.type}: HTTP ${res.status}`);
  }
}

(async () => {
  if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
    console.error('❌ Faltan CLIENT_ID / CLIENT_SECRET.');
    process.exit(1);
  }
  console.log(`Callback esperado: ${expectedCallback}`);

  const appToken = await getAppToken();
  await report('App token', {
    'Client-ID': process.env.CLIENT_ID,
    'Authorization': `Bearer ${appToken}`
  });

  console.log('');
})().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
