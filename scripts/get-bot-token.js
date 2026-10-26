// Genera access + refresh token para la cuenta del BOT (scopes chat:read chat:edit)
// y los guarda SOLO en Supabase (channel_config.bot_token / bot_refresh_token).
//
// Requisitos: CLIENT_ID, CLIENT_SECRET, SUPABASE_URL, SUPABASE_KEY en .env o en el entorno,
// y http://localhost:3000/callback añadida como OAuth Redirect URL de la app en dev.twitch.tv.
//
// Uso: npm run bot-token  → abre la URL que se muestra en una ventana de incógnito
// logueada con la cuenta del bot.
require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const { saveTokens, loadTokens } = require('../src/utils/supabase');

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = 'chat:read chat:edit';

const { CLIENT_ID, CLIENT_SECRET, SUPABASE_URL, SUPABASE_KEY } = process.env;
const missing = ['CLIENT_ID', 'CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_KEY'].filter(v => !process.env[v]);
if (missing.length) {
  console.error(`❌ Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const authUrl = 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
  state,
  force_verify: 'true'
});

function finish(code, msg) {
  console.log(msg);
  server.close();
  setTimeout(() => process.exit(code), 200);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };

  if (url.searchParams.get('state') !== state) {
    reply(400, 'State inválido.');
    return finish(1, '❌ State inválido; se aborta.');
  }
  const code = url.searchParams.get('code');
  if (!code) {
    reply(400, 'Autorización rechazada.');
    return finish(1, `❌ Twitch no devolvió código (${url.searchParams.get('error_description') || 'sin detalle'}).`);
  }

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token || !data.refresh_token) {
      reply(500, 'Error al canjear el código.');
      return finish(1, `❌ Canje fallido (${tokenRes.status}: ${data.message || 'sin detalle'}).`);
    }

    // Comprobar a qué cuenta pertenece (login no es secreto) antes de guardar
    const vRes = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${data.access_token}` } });
    const v = vRes.ok ? await vRes.json() : {};
    const expected = (process.env.BOT_USERNAME || '').toLowerCase();
    if (expected && v.login && v.login.toLowerCase() !== expected) {
      reply(400, 'Cuenta incorrecta.');
      return finish(1, `❌ El token es de "${v.login}" pero BOT_USERNAME es "${expected}". No se guarda nada.`);
    }

    await saveTokens({ bot_token: data.access_token, bot_refresh_token: data.refresh_token });
    const saved = await loadTokens();
    if (!saved?.bot_refresh_token) {
      reply(500, 'No se pudo guardar en Supabase.');
      return finish(1, '❌ No se pudo verificar el guardado en Supabase (¿existen las columnas bot_token y bot_refresh_token?).');
    }
    reply(200, 'Listo. Puedes cerrar esta ventana.');
    finish(0, `✅ Tokens del bot (${v.login || 'cuenta desconocida'}) guardados en Supabase.`);
  } catch (e) {
    reply(500, 'Error inesperado.');
    finish(1, `❌ Error: ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log('Abre esta URL en una ventana de incógnito con la cuenta del bot:\n');
  console.log(authUrl + '\n');
});
