# Skill: parlusorum-deploy

Deploy en Render y flujo de trabajo local con ngrok para EventSub.

## Estado actual

El bot corre en **Render** (free tier), servicio `parlusorum-bot`, URL pública
`https://parlusorum-bot.onrender.com`. Migrado desde Railway; ya no queda nada
de Railway en el repo (`railway.toml` y `Procfile` eliminados).

El servicio antiguo `parlusorum-bot-c9i2.onrender.com` quedó obsoleto en la
migración. **Nunca deben estar los dos encendidos a la vez**: dos instancias con
el mismo `BOT_TOKEN` duplican cada mensaje en el chat, y la que arranque última
reescribe las suscripciones EventSub contra su propia URL dejando a la otra sin
eventos. Además dos servicios free siempre activos no caben en las 750 h/mes.

## Setup en Render

### Opción A — Blueprint (recomendada)

El repo incluye `render.yaml`. Render Dashboard → New → Blueprint → seleccionar
`perezlopezalej/parlusorum-bot` → Render lee el blueprint y pide los valores de
las variables marcadas `sync: false`.

### Opción B — Manual

New → Web Service → conectar el repo → configurar:

| Campo | Valor |
|---|---|
| Runtime | Node |
| Branch | `main` |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Instance Type | Free |
| Region | Frankfurt |

### Variables de entorno

Dashboard → servicio → Environment. Obligatorias (si falta una, `index.js` hace
`process.exit(1)` con `Variables de entorno faltantes`):

```
BOT_USERNAME        nombre de usuario del bot en Twitch (sin oauth:)
BOT_TOKEN           oauth:xxxxxxxxxxxxxxxxxxxx
CLIENT_ID           ID de la aplicación de Twitch
CLIENT_SECRET       Secret de la aplicación de Twitch
CHANNEL             parlusorum  (sin #)
GROQ_API_KEY        gsk_xxxx
BROADCASTER_TOKEN   oauth:xxxxxxxxxxxxxxxxxxxx (token del streamer)
EVENTSUB_SECRET     string aleatorio de al menos 10 chars
```

Opcionales en uso:

```
BROADCASTER_REFRESH_TOKEN  refresh del token del streamer (se persiste en Supabase)
SUPABASE_URL               https://xxxx.supabase.co
SUPABASE_KEY               eyJ...
NPOINT_BIN_ID              fallback si no hay Supabase (legacy)
RAWG_API_KEY               info de juegos en !juego
GROQ_MODEL                 llama-3.3-70b-versatile (por defecto)
GROQ_MODEL_FAST            llama-3.1-8b-instant (por defecto)
GROQ_MODEL_COMPOUND        groq/compound (por defecto)
NODE_ENV                   production
AI_MAX_RPM                 20  (límite global de llamadas a Groq por minuto)
WATCHDOG_TIMEOUT_MS        1800000  (30 min; reconecta si stream live sin mensajes)
AI_TIMER_INTERVAL_MS       1500000  (25 min; timer de comentario IA del juego)
COHOST_PROBABILITY         0.25  (probabilidad de mensaje espontáneo del bot)
PUBLIC_URL                 solo con dominio propio o ngrok (ver abajo)
```

**No hace falta configurar `PORT` ni `PUBLIC_URL`**: Render inyecta `PORT` y
`RENDER_EXTERNAL_URL`, y `getPublicBaseUrl()` en `src/eventsub.js` usa
`PUBLIC_URL || RENDER_EXTERNAL_URL`. Definir `PUBLIC_URL` solo si se pone un
dominio propio delante del servicio (o en local con ngrok).

## EventSub y cambios de URL

`registerSubscriptions()` corre en cada arranque (evento `connected` de tmi.js):
lista las suscripciones existentes de los tipos que gestiona, **las borra** y las
vuelve a crear apuntando a la URL pública actual. Cambiar de host o de dominio no
requiere ninguna acción manual en Twitch — basta con reiniciar el bot con la URL
nueva ya configurada.

Verificar a qué URL apuntan las suscripciones reales en Twitch:

```bash
npm run check:eventsub                         # compara con PUBLIC_URL/RENDER_EXTERNAL_URL del .env
node scripts/check-eventsub.js https://parlusorum-bot.onrender.com
node scripts/check-eventsub.js --prune         # borra las que apunten a otra URL
```

Necesita `CLIENT_ID` y `CLIENT_SECRET`. Sin un `BROADCASTER_TOKEN` válido solo
lista las de app token (follow, stream.online, stream.offline); las de hype
train, predicciones, polls y channel points requieren el token del streamer.

## Cutover a un servicio nuevo de Render

El orden importa: si el servicio nuevo conecta a IRC antes de que el viejo esté
apagado, hay bot duplicado en el chat y robo de suscripciones EventSub. Guardar
variables en el dashboard **reinicia el servicio automáticamente**, así que ese
guardado es el momento en que el nuevo intenta conectar.

1. Apagar el viejo primero: Settings → Suspend Web Service.
2. Copiar las variables del viejo al nuevo. **No copiar `PUBLIC_URL`** (apuntaría
   al dominio viejo y EventSub registraría callbacks muertos) **ni `PORT`**
   (Render inyecta el suyo). `RENDER_EXTERNAL_URL` tampoco se toca: es automática.
3. Al guardar, el nuevo reinicia. En los logs debe aparecer:
   `✅ Bot conectado a #parlusorum` → `🔗 EventSub callback: https://<nuevo>/eventsub`
   → `✅ EventSub: stream.online registrado`.
   Si sale `Login authentication failed`, el `BOT_TOKEN` está caducado: sin conexión
   IRC no se ejecuta `client.on('connected')`, así que tampoco hay EventSub, ni
   timers, ni handler del webhook (`POST /eventsub` devuelve 503). Solo vive `/health`.
4. Verificar desde local: `node scripts/check-eventsub.js https://<nuevo>` — las tres
   suscripciones de app token deben salir con ✅ y estado `enabled`.
5. Con todo verde, borrar el servicio viejo (o dejarlo suspendido unos días como
   rollback: para volver, basta con reanudarlo y reiniciarlo, que re-registra
   EventSub contra su URL).

## Particularidades del free tier de Render

- **Spin-down**: un servicio free se duerme tras 15 min sin tráfico HTTP entrante.
  El self-ping de `index.js` (`GET /health` cada 10 min contra `RENDER_EXTERNAL_URL`)
  lo mantiene despierto. Si se duerme, el bot se desconecta de IRC y los webhooks
  de EventSub fallan (tras suficientes fallos Twitch revoca la suscripción).
- **750 horas/mes** de instancia gratis en total. Un servicio siempre activo gasta
  ~730 h, así que no caben dos servicios free simultáneos siempre encendidos.
- **512 MB RAM / 0.1 CPU** compartida. Suficiente para el bot.
- **Estado en memoria**: cada deploy o reinicio resetea cooldowns, historial de
  chat y contadores de sesión. Lo persistente vive en Supabase.
- **Logs efímeros**: `logs/bot.log` se pierde en cada reinicio. Usar los logs del
  dashboard (servicio → Logs) para producción.

## Flujo de deploy

```
git push origin main
  → Render detecta el push (Auto-Deploy activado)
  → npm ci
  → npm start
  → health check contra /health
  → la instancia anterior termina
  → al conectar a IRC, registerSubscriptions() reescribe las suscripciones EventSub
```

Deploy manual sin push: dashboard → servicio → Manual Deploy → Deploy latest commit.
Para desactivar el auto-deploy: Settings → Build & Deploy → Auto-Deploy → No.

## Variables de entorno en desarrollo local

Crear `.env` en la raíz (ya está en `.gitignore`):

```env
BOT_USERNAME=dios_fua
BOT_TOKEN=oauth:...
CLIENT_ID=...
CLIENT_SECRET=...
CHANNEL=parlusorum
GROQ_API_KEY=gsk_...
BROADCASTER_TOKEN=oauth:...
EVENTSUB_SECRET=mi-secret-local
PUBLIC_URL=https://TU-NGROK-URL
NODE_ENV=development
PORT=3000
```

```bash
npm run dev   # node --watch index.js — recarga automática al guardar
```

Arrancar el bot en local con el mismo `BOT_TOKEN` mientras Render está activo
provoca **respuestas duplicadas en chat** (dos instancias conectadas a IRC), y
además el arranque local reescribe las suscripciones EventSub apuntando a ngrok.
Para desarrollo con el bot en producción: usar una cuenta de bot distinta, o
suspender el servicio en Render (Settings → Suspend Web Service).

## Testear EventSub localmente con ngrok

EventSub requiere una URL pública HTTPS con certificado válido. En local, usar ngrok:

```bash
ngrok http 3000
# Copiar la URL https://xxxx.ngrok-free.app → PUBLIC_URL en .env
# Reiniciar el bot: registra las suscripciones automáticamente al arrancar
```

Simular eventos sin esperar a que ocurran en Twitch real:

```bash
npm install -g @twitchdev/twitch-cli

twitch event trigger stream.online \
  -F https://xxxx.ngrok-free.app/eventsub \
  -s TU_EVENTSUB_SECRET

twitch event trigger channel.follow \
  -F https://xxxx.ngrok-free.app/eventsub \
  -s TU_EVENTSUB_SECRET \
  -u nombre_usuario_simulado
```

Al terminar, reiniciar el servicio en Render para devolver las suscripciones a la
URL de producción (o esperar al siguiente deploy).

## Obtener tokens de Twitch

### Bot Token (BOT_TOKEN)

1. Ir a [twitchtokengenerator.com](https://twitchtokengenerator.com) o usar el flujo OAuth
2. Escoger scopes: `chat:read`, `chat:edit`
3. Formato: `oauth:xxxxxx`

### Broadcaster Token (BROADCASTER_TOKEN)

Necesita scopes adicionales. Usando Twitch CLI:

```bash
twitch token -u -s "channel:manage:clips user:edit:broadcast moderator:read:followers channel:manage:broadcast bits:read channel:read:subscriptions channel:read:hype_train channel:read:predictions channel:read:polls channel:read:redemptions"
```

Con `BROADCASTER_REFRESH_TOKEN` configurado, `api.js` refresca el token solo ante
cualquier 401 y guarda el nuevo en Supabase, así que no hay que tocarlo a mano.

## Diagnóstico de problemas comunes

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| Bot no responde en chat | BOT_TOKEN expirado o incorrecto | Regenerar token, actualizar en Render → Environment |
| EventSub no llega | Callback apuntando a URL vieja o EVENTSUB_SECRET distinto | `npm run check:eventsub`; reiniciar el servicio para re-registrar |
| `BROADCASTER_TOKEN caducado` en logs | Token expirado y sin refresh token | Regenerar con los scopes necesarios |
| `Variables de entorno faltantes` al arrancar | Falta alguna de las 8 obligatorias | Render → servicio → Environment |
| Bot duplica respuestas | Dos instancias con el mismo BOT_TOKEN (local + Render, u otro host aún encendido) | Apagar una |
| Primera respuesta tarda ~50 s | El servicio se durmió (free tier) | Verificar el self-ping en los logs (`Self-ping error`) |
| EventSub revocado | Demasiados timeouts de respuesta | El webhook responde 204 inmediato; revisar que el servicio no esté dormido |
