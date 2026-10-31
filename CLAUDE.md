# CLAUDE.md

Guía para Claude Code en este repo. Funcionalidades y despliegue general: `README.md` y `docs/FUNCIONALIDADES.md`.

## Proyecto

Bot de Twitch del canal "parlusorum": comandos, IA con Groq, trivia, alertas, timers y memoria entre streams. Node.js 22+, CommonJS, sin build. Render (free tier), auto-deploy en cada push a `main`.

## Reglas de trabajo

- Nunca leer ni mostrar `.env`, tokens o secrets.
- No hacer commit ni push salvo que se pida.
- Las tareas nuevas empiezan en solo lectura salvo que se indique lo contrario.
- Salidas largas a un fichero en `logs/` y resumen corto en el chat.
- Tras cualquier cambio de código, ejecutar `npm test`; no dar la tarea por terminada si algún test falla.
- Si se añade una función pura nueva, añadirle su test en `test/`.
- Al terminar cada tarea, actualizar `PROGRESS.md` (Hecho / Pendiente de probar en directo / Ideas futuras).

## Comandos

```bash
npm start | npm run dev      # producción | --watch
npm test                     # node --test sobre test/**/*.test.js
npm run check:eventsub       # lista suscripciones EventSub y marca callbacks obsoletos
npm run backup | chatlog | bot-token
```

## Arquitectura

`index.js`: valida env, envuelve `client.say()` con la cola IRC, levanta el HTTP (`/health`, `/eventsub`, `/auth/*`), conecta tmi.js, self-ping cada 10 min y watchdog IRC cada 5 min.

| Módulo | Ruta | Notas |
|---|---|---|
| Commands | `src/commands/handler.js`, `help.js` | Despacho, cooldowns, permisos; `config/help.json` alimenta `!ayuda`/`!comandos` |
| AI | `src/ai/handler.js`, `patterns.js`, `prompts.js`, `quality.js` (validación pura: tono, muertes, nombres, emotes, cortes) | `!dios_fua`, chistes, cohost, hooks, emote/caps, `!quemeperdi`, resumen de fin de stream |
| Games | `src/games/` | Trivia dinámica por juego (Groq) con banco estático de respaldo, `!top` |
| Alerts | `src/alerts/` | Subs/bits/raids, hitos de followers, lurkers, bienvenida |
| Timers | `src/timers/handler.js` | Mensajes recurrentes (`config/commands.json` → `timers`), duración, comentario IA |
| EventSub | `src/eventsub.js` | Webhook HMAC, App Access Token, suscripciones online/offline/follow (+ hype train/predicciones con token del broadcaster) |
| Auth | `src/auth.js` | OAuth del broadcaster (`/auth/broadcaster` → `/auth/callback`); scopes en `BROADCASTER_SCOPES` |
| Twitch API | `src/twitch/api.js` | Helix, RAWG, refresh de tokens (broadcaster y bot) |
| Memory / Lore | `src/memory/`, `src/lore/` | Resúmenes entre streams; lore manual (`config/lore.json`) + aprendido, `!lore` (mods) |
| Moderación | `src/moderation/bot-detector.js` | Bots vía twitchbots.info |
| Utils | `src/utils/` | `state`, `storage`, `supabase`, `chatlog`, `ratelimit`, `irc-ratelimit`, `filter`, `groq-utils`, `narrative`, `game-match`, `metrics`, `logger` |

Config en `config/`: `commands.json` (solo timers), `channel.json`, `messages.json`, `help.json`, `lore.json`. Esquema Supabase en `supabase/migrations/` (000–004).

- `bot_whitelist` (channel.json): nunca se auto-banean.
- `bot_autoban_dry_run` es `true` **a propósito**: solo registra. No cambiarlo sin que se pida.

## Flujo de mensajes

```
tmi 'message' → ignora propios, dedupe por tags.id
  → checkNewUser → trackMessage/historial → alerts.handleMessage
  → sin prefijo: checkForHighlight → checkPatternMatch (@dios_fua / disparadores; si no, cohost) → emote spam → caps rage
  → games.checkTriviaAnswer (siempre)
  → con prefijo: games / ai / commands → client.say() → cola IRC

EventSub POST /eventsub → HMAC + dedupe por Message-Id → 204 → proceso en setImmediate
  stream.online: sesión Supabase, warmup IA a los 60 s si hay pocos viewers
  stream.offline: espera _sessionStarting, memoria + lore IA, postStreamEnd()
  channel.follow: mensaje + hitos
```

Comandos retirados (responden "ese comando ya no existe"): `!moneda`, `!titulo`, `!loss`, `!metricas`.

## Variables de entorno

Obligatorias (validadas en `index.js`): `BOT_USERNAME`, `BOT_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `CHANNEL`, `GROQ_API_KEY`, `BROADCASTER_TOKEN`, `EVENTSUB_SECRET` (mín. 10 caracteres).

Opcionales (defaults en el código y en `render.yaml`): `BROADCASTER_REFRESH_TOKEN`, `BOT_REFRESH_TOKEN` (se persisten en Supabase), `PUBLIC_URL` (prevalece sobre `RENDER_EXTERNAL_URL` para callback EventSub), `SUPABASE_URL`/`SUPABASE_KEY` (sin ellas, `NPOINT_BIN_ID` como fallback), `PREFIX`, `PORT`, `RAWG_API_KEY`, `GROQ_MODEL`, `GROQ_MODEL_FAST`, `GROQ_MODEL_COMPOUND`, `GROQ_MODEL_FALLBACKS`, `AI_MAX_RPM` (+ `_USER`, `_MOD`, `_CREATOR`, `_AUX` para el factcheck), `AI_TIMER_INTERVAL_MS`, `COHOST_*` (`FREE_INTERVAL_MS`, `EVENT_TTL_MS`, `FREE_MAX_PER_HOUR`, `MAX_PER_HOUR`, `NAME_WINDOW_MS`), `PROVOCATION_WINDOW_MS`, `MENTION_MAX_PER_USER` (3) y `MENTION_WINDOW_MS` (300000; tope de respuestas a menciones por usuario), `QUESTION_COOLDOWN_MS`, `HOOK_INTERVAL_MS`, `HOOK_SILENCE_MS`, `TRIVIA_DURATION_MS`, `LURKER_THRESHOLD_MS`.

- `GROQ_MODEL_FALLBACKS`: modelos de reserva (coma) si el pedido da 404/decommissioned. Las peticiones servidas por uno de reserva se cuentan en `state.js` y salen en el resumen de fin de stream del log (`bot.log`, nunca el chat).

## Patrones clave

- **Cooldowns**: Maps `${command}-${userId}` (usuario) o `${command}` (global).
- **Permisos de mod**: `tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1'`.
- **IRC**: `irc-ratelimit.js` envuelve `client.say()` una vez (cola FIFO con tope y separación mínima); descarta si el cliente está desconectado; en SIGTERM/SIGINT vacía la cola (máx. 5 s). Watchdog: si `chatStatus.connected` es false llama a `connectChat()`, que no abre otro socket si ya está OPEN/CONNECTING.
- **Origen de mensajes**: `runWithOrigin(origin, fn)` (`chatlog.js`, AsyncLocalStorage) etiqueta cada `say()` del bot; el chat se vuelca por lotes a la tabla `chat_log` (retención 60 días).
- **Dos tokens**: el App Access Token (caché 23 h) solo para crear/listar/borrar suscripciones EventSub y consultas públicas de `streams`; todo lo que actúa en nombre del canal (clips, markers, bans, followers, `BROADCASTER_SCOPES`) usa el token del broadcaster, cargado de Supabase al arrancar (pisa .env si es más reciente) y refrescado en 401.
- **Storage**: Supabase primero; sin sus variables usa npoint.io y migra cuando se configure.
- **Memoria**: en `stream.offline` Groq resume el stream a Supabase; los últimos 5 resúmenes entran en el prompt (caché 10 min). Memoria conversacional por usuario: 5 turnos, TTL 1 h, máx. 200 usuarios.
- **Groq**: Groq retira modelos a menudo (`llama-3.x`/`llama-4` y `groq/compound` dan 404). Consultar `GET https://api.groq.com/openai/v1/models` antes de cambiar `GROQ_MODEL*`. Los gpt-oss son de razonamiento: sin `reasoning_effort: 'low'` agotan `max_tokens` y devuelven `content` vacío; `groqWithRetry()` lo fija y añade margen de tokens.

## Convenciones

- **Estado mutable**: toda variable de estado compartida vive en `src/utils/state.js`; nunca en los handlers.
- **require()**: al inicio, agrupados core Node → npm → propios. Excepción: dependencias circulares conocidas (`eventsub` ↔ `ai`, `alerts` ↔ `ai`), lazy dentro de la función.
- **Caché in-memory**: `Map` con TTL (patrón `fullContextCache` / `userFactsCache`), sin dependencias externas.
- **Map con TTL → `setInterval` de pruning** justo después (ver `chisteCooldowns`, `questionCooldowns`, `userFactsCache`).
- **Mensajes al chat**: textos en español en `config/messages.json` (excepto errores internos y logs).
- **`truncate()` obligatorio** en todo `client.say()` con contenido dinámico o de `config/` (límite 500 de Twitch).
- **Supabase**: clave secreta (service role), RLS activado en todas las tablas y sin políticas; nunca volver a la clave anon ni añadir políticas permisivas.
