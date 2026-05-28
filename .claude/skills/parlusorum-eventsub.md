# Skill: parlusorum-eventsub

Webhook EventSub del proyecto y guía oficial de Twitch.

## Arquitectura actual

```
index.js → HTTP server en PORT
  POST /eventsub → rawBody acumulado → eventSubHandler(req, res, rawBody)

src/eventsub.js:
  createEventSubHandler(client, channel) → función handler
  registerSubscriptions(broadcasterId)   → registra webhooks en Twitch
  initStreamState()                      → comprueba si está en directo al arrancar
  isLiveViaEventSub()                    → estado actual del stream
  getStreamUptime()                      → uptime formateado
  getViewersWithAppToken(id)             → viewers via app token (no broadcaster)
```

## Verificación HMAC (src/eventsub.js:98-110)

La verificación usa `crypto.timingSafeEqual` para evitar timing attacks:
```js
function verifySignature(req, body) {
  if (!EVENTSUB_SECRET) return true;  // advertencia en startup si no está configurado
  const hmac = 'sha256=' + crypto.createHmac('sha256', EVENTSUB_SECRET)
    .update(messageId + timestamp + body)  // concatenación exacta requerida por Twitch
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch { return false; }
}
```

**Requisito oficial de Twitch:**
- El secret debe ser ASCII, mínimo 10 chars, máximo 100 chars
- NO reutilizar el `CLIENT_SECRET` de la app como EventSub secret
- El body debe ser el raw sin parsear cuando se calcula el HMAC — por eso `index.js` acumula el rawBody antes de llamar al handler

## Tres tipos de mensajes EventSub

| Tipo | Header `Twitch-Eventsub-Message-Type` | Respuesta requerida |
|------|---------------------------------------|---------------------|
| `webhook_callback_verification` | responder con `body.challenge` en texto plano, status 200 |
| `notification` | responder 204 lo antes posible |
| `revocation` | suscripción revocada — registrar y re-suscribir |

**Tiempo límite:** responder en pocos segundos o Twitch revocará la suscripción. Si el procesamiento es lento, responder 204 primero y procesar en async.

## Suscripciones registradas (src/eventsub.js:138-141)

```js
const subscriptions = [
  { type: 'channel.follow', version: '2',
    condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
  { type: 'stream.online',  version: '1',
    condition: { broadcaster_user_id: broadcasterId } },
  { type: 'stream.offline', version: '1',
    condition: { broadcaster_user_id: broadcasterId } }
];
```

`registerSubscriptions()` borra suscripciones antiguas del mismo tipo antes de crear nuevas. Esto evita el límite de 3 suscripciones duplicadas por tipo que impone Twitch.

## Añadir una nueva suscripción EventSub

1. Añadir al array `subscriptions` en `registerSubscriptions()`:
```js
{ type: 'channel.subscribe', version: '1',
  condition: { broadcaster_user_id: broadcasterId } }
```

2. Añadir handler en el bloque `if (messageType === MESSAGE_TYPE_NOTIFICATION)`:
```js
if (type === 'channel.subscribe' && event?.user_name) {
  alerts.onSub(client, channel, event.user_name);
}
```

3. Verificar que el App Access Token tiene el scope necesario — algunos eventos requieren scopes específicos del broadcaster token.

## Tipos de eventos disponibles más útiles

| Evento | Versión | Scope requerido | Uso típico |
|--------|---------|-----------------|------------|
| `stream.online` | 1 | ninguno | detectar inicio de stream |
| `stream.offline` | 1 | ninguno | detectar fin de stream |
| `channel.follow` | 2 | `moderator:read:followers` | nuevos seguidores |
| `channel.subscribe` | 1 | `channel:read:subscriptions` | nuevos subs |
| `channel.subscription.gift` | 1 | `channel:read:subscriptions` | gifted subs |
| `channel.cheer` | 1 | `bits:read` | bits |
| `channel.raid` | 1 | ninguno | raids recibidos |
| `channel.ban` | 1 | `channel:moderate` | bans |
| `channel.update` | 2 | ninguno | cambio de juego/título |

**Nota:** `channel.follow` v2 requiere que `moderator_user_id` sea el broadcaster o un mod con el scope `moderator:read:followers`.

## App Access Token vs User Access Token

- `registerSubscriptions()` usa **App Access Token** (`client_credentials`) — requerido para crear suscripciones EventSub
- `getStreamInfo()` en `twitch/api.js` usa **User Access Token** (BROADCASTER_TOKEN) para operaciones que requieren permisos del streamer (clips, markers)
- El App Access Token se cachea 23 horas en memoria (`appTokenCache`, `appTokenExpiry`)

## Variables de entorno requeridas

```
EVENTSUB_SECRET    → secret para verificación HMAC (mín 10 chars, máx 100)
PUBLIC_URL         → URL pública del servidor, e.g. https://xxx.railway.app
                     El webhook se registra como ${PUBLIC_URL}/eventsub
CLIENT_ID          → App client ID (para registrar suscripciones)
CLIENT_SECRET      → App client secret (para obtener app access token)
```

Sin `PUBLIC_URL` configurada, `registerSubscriptions()` advierte y no registra nada.

## Testear EventSub localmente con ngrok

```bash
# Instalar Twitch CLI
npm install -g @twitchdev/twitch-cli

# En terminal 1: tunnel local
ngrok http 3000

# En terminal 2: simular evento (no envía a Twitch real)
twitch event trigger stream.online -F https://TU_NGROK_URL/eventsub -s TU_EVENTSUB_SECRET

# Simular follow
twitch event trigger channel.follow -F https://TU_NGROK_URL/eventsub -s TU_EVENTSUB_SECRET
```

## WebSocket vs Webhook

| | Webhook (actual) | WebSocket |
|--|-----------------|-----------|
| Requiere URL pública | Sí | No |
| Escala horizontal | Sí | No (una conexión) |
| Recomendado para | servidores con dominio | desarrollo local |
| Reconexión | automática (Twitch reintenta) | manual |

El proyecto usa **webhook** porque está en Railway con URL pública. Para desarrollo local sin ngrok, la alternativa es WebSocket (EventSub `transport.method: 'websocket'`).
