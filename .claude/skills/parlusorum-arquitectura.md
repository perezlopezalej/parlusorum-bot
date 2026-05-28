# Skill: parlusorum-arquitectura

Arquitectura del proyecto y patrones recomendados para bots Twitch persistentes.

## Estructura real del proyecto

```
index.js                    ← entrada: env, HTTP server, tmi.js client, wiring
src/
  commands/handler.js       ← dispatch de !comandos, cooldowns, permisos
  ai/handler.js             ← Groq, cohost, historial, stream hooks
  alerts/handler.js         ← subs, bits, raids, lurker, logros, seguidores
  games/handler.js          ← trivia, moneda
  timers/handler.js         ← mensajes recurrentes
  eventsub.js               ← webhook HTTP, HMAC, estado del stream
  twitch/api.js             ← Helix API, cache de tokens y respuestas
  memory/handler.js         ← memoria entre streams (Supabase)
  utils/
    storage.js              ← abstracción Supabase / npoint.io
    supabase.js             ← cliente Supabase, sesiones, memoria
    state.js                ← estado global mutable (triviaActive, silenced, brb)
    ratelimit.js            ← rate limiter global + por usuario para Groq
    filter.js               ← sanitización y anti-prompt-injection
    metrics.js              ← contadores de actividad del chat
    logger.js               ← consola + archivo logs/bot.log
    search.js               ← búsqueda web Tavily para contexto IA
config/
  commands.json             ← respuestas y cooldowns de comandos simples + timers
  channel.json              ← metadatos: broadcaster_id, personalidad, juegos, milestones
```

## Flujo de mensajes (index.js:140-183)

```
tmi.js 'message' event
  └─ if self / bot username → return (anti-loop)
  └─ deduplicación por tags['id'] (Set limpiado cada 60s) ← BUG FIX reconexiones
  └─ trackMessage() + addToHistory() + updateLastChatTime()
  └─ alerts.handleMessage() → checkFirstMessage + trackLurker
  └─ if NO prefix → checkForHighlight + handleCohost
  └─ games.checkTriviaAnswer() (siempre, incluso sin prefix)
  └─ if NO prefix → return
  └─ parse: args[0].toLowerCase() = command
  └─ dispatch: trivia/moneda → games | dios_fua/chiste → ai | resto → commands
```

## Deduplicación de mensajes

`index.js:77-78` — el Set de IDs procesados se limpia cada minuto:
```js
const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 60 * 1000);
// En el handler:
const msgId = tags['id'];
if (msgId) {
  if (processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
}
```
Necesario porque tmi.js puede emitir el mismo mensaje dos veces en reconexiones.

## Watchdog (index.js:81-90)

Reconecta si el canal está en directo pero no llegan mensajes en 30 min:
```js
const WATCHDOG_TIMEOUT = parseInt(process.env.WATCHDOG_TIMEOUT_MS || '1800000', 10);
setInterval(() => {
  if (!isLiveViaEventSub()) return;
  if (Date.now() - lastMessageTime > WATCHDOG_TIMEOUT) client.connect().catch(logger.error);
}, 5 * 60 * 1000);
```

## Gestión de estado global

`src/utils/state.js` exporta getters/setters para:
- `isSilenced()` / `setSilenceMode(bool)` — modo silencio de mods
- `isTriviaActive()` / `setTriviaActive(bool)` — bloquea cohost y hooks durante trivia
- `isBrb()` / `setBrbMode(bool, client, channel)` — modo ausencia con recordatorio

## Reconexión automática con tmi.js

El cliente ya tiene `connection: { reconnect: true }` — tmi.js reconecta solo. El problema real es el estado post-reconexión:
- `timersStarted` flag evita duplicar timers en cada reconexión (index.js:73)
- En `'disconnected'`, se resetea `setTriviaActive(false)` para no dejar trivia colgada
- El watchdog actúa como capa extra para canales con poco chat

## Patrón para añadir un nuevo módulo handler

1. Crear `src/[nombre]/handler.js` con `module.exports = { handle }`
2. Importar en `index.js` junto al resto de handlers
3. Llamar en el event `'message'` en el punto apropiado del flujo
4. Si necesita estado del stream, importar `{ isLiveViaEventSub }` de `../eventsub`
5. Si escribe en chat, respetar `isSilenced()` antes de `client.say()`

## Consideraciones de memoria en producción

- `chatHistory` (MAX 40 mensajes, últimos 10 min) — en `src/ai/handler.js:120`
- `userConversations` (MAX 200 usuarios, 5 turnos/usuario, 1h TTL) — se purgan los 50 más antiguos cuando llega al límite
- `processedMessages` Set — se limpia cada 60s
- Todo estado vive en memoria del proceso — Railway reinicia el proceso en cada deploy, reseteando estado en memoria
