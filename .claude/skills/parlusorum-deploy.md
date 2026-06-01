# Skill: parlusorum-deploy

Deploy en Railway y flujo de trabajo local con ngrok para EventSub.

## Setup inicial en Railway

### 1. Conectar el repositorio

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Seleccionar `parlusorum-bot`
3. Railway detecta Node.js automáticamente y usa `npm start` (del `package.json`)

### 2. Configurar Variables de entorno

Variables tab del servicio → añadir una a una:

```
BOT_USERNAME        nombre de usuario del bot en Twitch (sin oauth:)
BOT_TOKEN           oauth:xxxxxxxxxxxxxxxxxxxx
CLIENT_ID           ID de la aplicación de Twitch
CLIENT_SECRET       Secret de la aplicación de Twitch
CHANNEL             parlusorum  (sin #)
GROQ_API_KEY        gsk_xxxx
BROADCASTER_TOKEN   oauth:xxxxxxxxxxxxxxxxxxxx (token del streamer)
EVENTSUB_SECRET     string aleatorio de al menos 10 chars
PUBLIC_URL          https://TU-APP.railway.app  (ver paso 4)
```

Variables opcionales:
```
SUPABASE_URL        https://xxxx.supabase.co
SUPABASE_KEY        eyJ...
NPOINT_BIN_ID       id del bin de npoint.io (fallback si no hay Supabase)
GROQ_MODEL          llama-3.3-70b-versatile  (por defecto)
NODE_ENV            production
TAVILY_API_KEY      búsqueda web en !dios_fua (factual context)
RAWG_API_KEY        info de juegos en !juego (géneros, rating, año)
AI_MAX_RPM          20  (límite global de llamadas a Groq por minuto)
WATCHDOG_TIMEOUT_MS 1800000  (30 min; reconecta si stream live sin mensajes)
AI_TIMER_INTERVAL_MS 1500000 (25 min; timer de comentario IA del juego)
COHOST_PROBABILITY  0.25  (probabilidad de mensaje espontáneo del bot)
```

### 3. Obtener la URL pública

Settings del servicio → Networking → Generate Domain → copiar la URL (e.g. `https://parlusorum-bot-production.up.railway.app`).

Añadir esa URL como `PUBLIC_URL` en Variables **sin** trailing slash.

### 4. Health check (railway.toml)

Si quieres que Railway verifique que el bot está vivo antes de considerar el deploy exitoso, crea `railway.toml` en la raíz:

```toml
[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

El endpoint `/health` ya existe en `index.js:33-37` y devuelve `{ status: "ok", uptime: X }`.

### 5. Auto-deploy desde GitHub

Por defecto, cualquier push a la rama conectada (normalmente `main`) lanza un deploy automático. Para controlar esto:

- Railway Dashboard → servicio → Settings → Source → Branch
- Para desactivar auto-deploy: Settings → Source → desactivar "Auto Deploy"

## Flujo de deploy

```
git push origin main
  → Railway detecta el push
  → Railpack builder construye el proyecto (npm install)
  → Inicia el proceso con npm start
  → Si healthcheck está configurado, espera respuesta de /health
  → Deploy marcado como exitoso
  → Proceso anterior termina (zero-downtime si healthcheck pasa)
```

Railway mantiene el proceso activo indefinidamente — no hay timeouts ni spin-down.

## Ver logs

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Ver logs en tiempo real
railway logs --tail

# O desde el dashboard: servicio → Deployments → clic en el deploy → Logs
```

Los logs del bot también se guardan en `logs/bot.log` dentro del proceso, pero en Railway esos logs se pierden al reiniciar. Usar los logs del dashboard o Railway CLI para producción.

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

## Testear EventSub localmente con ngrok

EventSub requiere una URL pública HTTPS con certificado válido. En local, usar ngrok:

```bash
# Instalar ngrok
npm install -g ngrok
# O descarga desde ngrok.com

# Exponer el puerto local
ngrok http 3000
# Copia la URL https://xxxx.ngrok-free.app

# Actualizar .env:
PUBLIC_URL=https://xxxx.ngrok-free.app

# Reiniciar el bot con npm run dev
# El bot registrará las suscripciones automáticamente al arrancar
```

Para simular eventos sin esperar que ocurran en Twitch real:
```bash
# Instalar Twitch CLI
npm install -g @twitchdev/twitch-cli

# Simular stream.online
twitch event trigger stream.online \
  -F https://xxxx.ngrok-free.app/eventsub \
  -s TU_EVENTSUB_SECRET

# Simular nuevo seguidor
twitch event trigger channel.follow \
  -F https://xxxx.ngrok-free.app/eventsub \
  -s TU_EVENTSUB_SECRET \
  -u nombre_usuario_simulado
```

## Obtener tokens de Twitch

### Bot Token (BOT_TOKEN)
1. Ir a [twitchtokengenerator.com](https://twitchtokengenerator.com) o usar el flujo OAuth
2. Escoger scopes: `chat:read`, `chat:edit`
3. Formato: `oauth:xxxxxx`

### Broadcaster Token (BROADCASTER_TOKEN)
Necesita scopes adicionales. Usando Twitch CLI:
```bash
twitch token -u -s "channel:manage:clips user:edit:broadcast moderator:read:followers channel:manage:broadcast bits:read channel:read:subscriptions"
```

O manualmente via OAuth Authorization Code flow con esos scopes.

## Diagnóstico de problemas comunes

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| Bot no responde en chat | BOT_TOKEN expirado o incorrecto | Regenerar token, actualizar en Railway |
| EventSub no llega | PUBLIC_URL incorrecta o EVENTSUB_SECRET mal | Verificar Variables en Railway |
| `⚠️ BROADCASTER_TOKEN caducado` en logs | Token expirado | Regenerar con los scopes necesarios |
| `Variables de entorno faltantes` al arrancar | Falta alguna de las 7 variables requeridas | Revisar Variables tab en Railway |
| Bot duplica respuestas | Dos instancias corriendo | Railway → servicio → verificar que solo hay 1 replica |
| EventSub revocado | Demasiados timeouts de respuesta | Verificar que el servidor responde en < 3s |
