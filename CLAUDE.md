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
- Antes de desplegar cambios en prompts o filtros (`prompts.js`, `quality.js`, `factcheck.js`, `patterns.js`), ejecutar `npm run eval` (casos en `test/eval-cases.json`, informe en `logs/eval.txt`).
- Al terminar cada tarea, actualizar `PROGRESS.md` (Hecho / Pendiente de probar en directo / Ideas futuras).
- `docs/investigacion-buenas-practicas.md`: investigación sobre buenas prácticas de IA, chatbots, seguridad y privacidad (nov. 2026). Consultarla antes de cambiar prompts, el router de IA o el tratamiento de datos. Algunos datos legales y de límites deben verificarse; no es asesoramiento jurídico.

## Comandos

```bash
npm start | npm run dev      # producción | --watch
npm test                     # node --test sobre test/**/*.test.js
npm run check:eventsub       # lista suscripciones EventSub y marca callbacks obsoletos
npm run eval                 # batería con la IA REAL (gasta Groq/IGDB; no va en npm test ni en la CI)
npm run backup | chatlog | forget -- <login> [--dry-run] | bot-token
```

## Arquitectura

`index.js`: valida env, envuelve `client.say()` con la cola IRC, levanta el HTTP (`/health`, `/eventsub`, `/auth/*`), conecta tmi.js, self-ping cada 10 min y watchdog IRC cada 5 min.

| Módulo | Ruta | Notas |
|---|---|---|
| Commands | `src/commands/handler.js`, `help.js` | Despacho, cooldowns, permisos; `config/help.json` alimenta `!ayuda`/`!comandos` |
| AI | `src/ai/handler.js`, `patterns.js`, `style.js` (prompts por tipo y candidatos), `quality.js` (validación pura: tono, muertes, nombres, emotes, cortes, mayúsculas, ortografía, hora, repeticiones del stream), `pick-best.js` (selector con IA); proveedores y cadenas en `src/utils/ai-router.js` | `!dios_fua`, chistes, cohost, hooks, emote/caps, `!quemeperdi`, resumen de fin de stream |
| Games | `src/games/` | Trivia dinámica por juego (Groq) con banco estático de respaldo, `!top` |
| Alerts | `src/alerts/` | Subs/bits/raids, hitos de followers, lurkers, bienvenida |
| Timers | `src/timers/handler.js` | Mensajes recurrentes (`config/commands.json` → `timers`), duración, comentario IA |
| EventSub | `src/eventsub.js` | Webhook HMAC, App Access Token, suscripciones online/offline/follow (+ hype train/predicciones con token del broadcaster) |
| Auth | `src/auth.js` | OAuth del broadcaster (`/auth/broadcaster` → `/auth/callback`); scopes en `BROADCASTER_SCOPES` |
| Twitch API | `src/twitch/api.js` | Helix, refresh de tokens (broadcaster y bot) |
| Datos de juegos | `src/twitch/igdb.js`, `app-token.js` | IGDB única fuente (app token de Twitch compartido con EventSub, límite 4 req/s, `summary` nunca `storyline`, país de la desarrolladora si consta); `lookupGameInfo` devuelve `error` solo si IGDB no contestó (5xx, timeout). `!juego` cita «Datos: IGDB.com» (texto sin confirmar en los términos de IGDB) |
| Memory / Lore | `src/memory/`, `src/lore/` | Resúmenes entre streams; lore manual (`config/lore.json`) + aprendido, `!lore` (mods) |
| Moderación | `src/moderation/bot-detector.js` | Bots vía twitchbots.info |
| Privacidad | `src/privacy/` | `retention.js` (caducidad cada hora), `quality-log.js` (registro de calidad de 30 días), `forget.js` + `commands.js` (`!fua_olvidame`, `!fua_olvidar @x`, `!privacidad`), `names.js` (quitar nicks) |
| Utils | `src/utils/` | `state`, `storage`, `supabase`, `chatlog`, `ratelimit`, `irc-ratelimit`, `filter`, `groq-utils`, `ai-router`, `ai-pseudonym`, `narrative`, `game-match`, `metrics`, `logger` |

Config en `config/`: `commands.json` (solo timers), `channel.json`, `messages.json`, `help.json`, `lore.json`. Esquema Supabase en `supabase/migrations/` (000–011; 010 aditiva, 011 destructiva y posterior al despliegue).

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

Opcionales (defaults en el código y en `render.yaml`): `BROADCASTER_REFRESH_TOKEN`, `BOT_REFRESH_TOKEN` (se persisten en Supabase), `PUBLIC_URL` (prevalece sobre `RENDER_EXTERNAL_URL` para callback EventSub), `SUPABASE_URL`/`SUPABASE_KEY` (sin ellas, `NPOINT_BIN_ID` como fallback), `PREFIX`, `PORT`, `GROQ_MODEL`, `GROQ_MODEL_FAST`, `GROQ_MODEL_COMPOUND`, `GROQ_MODEL_FALLBACKS`, `AI_MAX_RPM` (+ `_USER`, `_MOD`, `_CREATOR`, `_AUX` para el factcheck), `AI_TIMER_INTERVAL_MS`, `COHOST_*` (`FREE_INTERVAL_MS`, `EVENT_TTL_MS`, `FREE_MAX_PER_HOUR`, `MAX_PER_HOUR`, `NAME_WINDOW_MS`), `PROVOCATION_WINDOW_MS`, `GROQ_MODEL_PICK` y `GROQ_MODEL_LIGHT` (qwen/qwen3.8-27b), `COHOST_CANDIDATES` (2 o 3, por defecto 2), `AI_CHAIN_<TIPO>`, `AI_GROQ_RPM`/`AI_GROQ_TPM`, `AI_*_TIMEOUT_MS`, `AI_BLOCK_ERROR_MS`, `AI_PSEUDONYM_EXCLUDE`, `MENTION_MAX_PER_USER` (3) y `MENTION_WINDOW_MS` (300000; tope de respuestas a menciones por usuario), `QUESTION_COOLDOWN_MS`, `HOOK_INTERVAL_MS`, `HOOK_SILENCE_MS`, `TRIVIA_DURATION_MS`, `LURKER_THRESHOLD_MS`.

- `GROQ_MODEL_FALLBACKS`: modelos de reserva (coma, por orden de prioridad) si el pedido da 404/decommissioned **o 429 por cupo agotado** (por minuto o diario). Cada modelo tiene su propio cupo en Groq; en Render: `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b`. Un 429 no espera: salta al siguiente y bloquea el modelo agotado unos minutos (`groq-utils.js`); solo el último de la cadena reintenta con espera. `GROQ_DAILY_TOKEN_LIMIT` (200000) solo sirve para el % del resumen. Las peticiones servidas por uno de reserva se cuentan en `state.js` y salen en el resumen de fin de stream del log (`bot.log`, nunca el chat).

## Patrones clave

- **Cooldowns**: Maps `${command}-${userId}` (usuario) o `${command}` (global).
- **Permisos de mod**: `tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1'`.
- **IRC**: `irc-ratelimit.js` envuelve `client.say()` una vez (cola FIFO con tope y separación mínima); descarta si el cliente está desconectado; en SIGTERM/SIGINT vacía la cola (máx. 5 s). Watchdog: si `chatStatus.connected` es false llama a `connectChat()`, que no abre otro socket si ya está OPEN/CONNECTING.
- **Origen de mensajes**: `runWithOrigin(origin, fn)` (`chatlog.js`, AsyncLocalStorage) etiqueta cada `say()` del bot; el chat se vuelca por lotes a la tabla `chat_log` (retención **24 h**; al acabar el stream, `privacy/quality-log.js` guarda en `quality_log` los mensajes del bot con 3 líneas de contexto y nicks seudonimizados, 30 días).
- **Dos tokens**: el App Access Token (caché 23 h) solo para crear/listar/borrar suscripciones EventSub y consultas públicas de `streams`; todo lo que actúa en nombre del canal (clips, markers, bans, followers, `BROADCASTER_SCOPES`) usa el token del broadcaster, cargado de Supabase al arrancar (pisa .env si es más reciente) y refrescado en 401.
- **Storage**: Supabase primero; sin sus variables usa npoint.io y migra cuando se configure.
- **Memoria**: en `stream.offline` Groq resume el stream a Supabase; los últimos 5 resúmenes entran en el prompt (caché 10 min). Memoria conversacional por usuario: 5 turnos, TTL 1 h, máx. 200 usuarios.
- **Groq**: Groq retira modelos a menudo (`llama-3.x`/`llama-4` y `groq/compound` dan 404). Consultar `GET https://api.groq.com/openai/v1/models` antes de cambiar `GROQ_MODEL*`. Los gpt-oss son de razonamiento: sin `reasoning_effort: 'low'` agotan `max_tokens` y devuelven `content` vacío; el router lo fija y añade margen de tokens.
- **Router de IA** (`src/utils/ai-router.js`): solo Groq (Gemini retirado: sus términos no permiten el nivel gratuito para usuarios del EEE). Todo sitio llama a `aiChat(tipo, params, { names })`, sin elegir modelo. Reparto por modelo para que un directo de 6 h quepa en el cupo diario de cada uno (200.000 tokens/día y 8.000/min por modelo; presupuesto en `PROGRESS.md`): `GROQ_MODEL` (gpt-oss-120b) para `cohost`, `diosfua`, `quemeperdi`, `reaction`; gpt-oss-20b (`GROQ_MODEL_FAST`) para `mention` y `provocation`; qwen (`GROQ_MODEL_LIGHT`) para `alert`, `timer`, `hook`, `endstream`, `trivia` y `command`; cada grupo lleva a los otros dos de reserva. `review` (factcheck): 20b primero. `pick` (selector de candidatos de `pick-best.js`): `aiChat('pick', …, { generator })` solo usa modelos de OTRA familia que el generador (`modelFamily`: gpt-oss ↔ qwen; `GROQ_MODEL_PICK` primero) y recibe los candidatos en orden aleatorio. Cadenas por entorno con `AI_CHAIN_<TIPO>=groq:modelo,…`. Se pasa al siguiente ante 429, 500/502/503/504, timeout o 404 y el modelo queda bloqueado (1 min por minuto, 3 min por 5xx/timeout). Contadores propios en `state.js` (ventana de 60 s; día UTC) hacen saltar antes del 429. Los nicks del chat salen a Groq como `user1`, `user2`… y se restauran en la respuesta (`ai-pseudonym.js`, en todas las llamadas; los streamers, el creador y el bot no se tocan). El texto generado pasa siempre por `quality.js`, el selector y el factcheck (revisión de sentido incluida).

## Prompts por tipo (cupo de Groq)

`src/ai/style.js` monta los prompts de provocaciones, cohost, menciones, `!dios_fua`, alertas (sub, raid, bienvenida, predicciones y encuestas) y resumen de fin de stream con una sola plantilla: identidad corta (~60 tokens) + `<forma>` fija en 1-2 líneas + 3-5 `<example>` + lo variable del momento entre etiquetas (`<stream>`, `<contexto>`, `<ajustes>`…) + `<tarea>` al final (lo fijo va primero por si Groq cachea el prefijo; la documentación dice que los tokens cacheados no cuentan para TPM y no aclara el TPD). Los ejemplos están en `config/style-examples.json` (por tipo, editables) y rotan al azar en cada llamada. Reglas del prompt: todo en positivo y ninguna palabra o frase prohibida citada; las prohibiciones viven en `quality.js`. Un reintento solo añade `<correccion>` con la corrección en positivo (`positiveFix`/`retryNote`), sin citar la frase rechazada. El cohost no recibe los últimos mensajes del bot (el parecido lo comprueba el código), cambia de forma en cada comentario (`COHOST_FORMS`, sin repetir la anterior) y pide 2 candidatos (`COHOST_CANDIDATES`) en un JSON: `rankCandidates` descarta los que no pasan `validateCohost` y elige el que menos se parece a lo reciente; entre los que quedan, `pick-best.js` (modelo de otra familia que el generador, con el chat, la hora y el contador) elige el mejor o dice que ninguno vale (se calla tras un reintento); si el selector no puede contestar, vale el orden del código. El timer IA pasa su texto por el mismo selector y recalcula el contador en cada intento. Si los tres fallan, un reintento y, si vuelve a fallar, se calla. Los minutos de directo se dan aproximados (`approxDuration`), y el día de la semana, «Entre X y Y…» y las palabras largas llamativas solo salen una vez por stream (`streamMarks` en `usedStructures`). Los de hook, timer IA, `!so` y `!quemeperdi` usan la misma plantilla (`buildHookSystem`, `buildTimerSystem`, `buildShoutoutSystem`, `buildQueMePerdiSystem`); `dayLine()` pasa el día de la semana y la parte del día reales (Madrid) a los prompts que hablan del momento, y `quality.wrongWeekday` rechaza un día que no es hoy. Timer IA (cada `AI_TIMER_INTERVAL_MS`, 30 min): resumen de la última media hora con `windowFacts` (caídas, jefes, racha) y `topChatWords`; sin sucesos relevantes no se envía, y el parecido con lo que ya dijo el cohost lo comprueba el código. Hook IA: pregunta al chat sobre lo ocurrido (`requireQuestion`); sin sucesos, hooks fijos, y los fijos del juego («¿Qué os parece X?») solo si `countSessionsOfGame` ≤ 2. Varios `!boss` en ~2 min se agrupan en un solo comentario del cohost (`mergeBossMoments`). `!dios_fua` con un juego en la pregunta: `quality.extractGameMention` saca el nombre, el código busca la ficha en IGDB antes de llamar al modelo y se la pasa en `<ficha_igdb>` sin ofrecer la herramienta (la ficha la monta `src/ai/game-sheet.js` en español: fecha «octubre de 2026», géneros traducidos y un resumen en español generado una vez por juego con qwen y cacheado, nunca la descripción inglesa; `leaksSheetRaw` descarta respuestas con inglés, fechas ISO o campos de la ficha copiados) (sin coincidencia segura sigue el flujo con `buscar_juego`). Una mención que pide un juego («cuéntame de qué va X», `quality.extractGameQuery`) se responde con los datos de IGDB (`buildGameTemplate`), sin IA; si IGDB no lo conoce, `mention_not_understood`.

## Privacidad (datos personales)

- **Por `user_id`, no por nick**: `user_facts`, `channel_lore.users` y el registro de calidad se identifican por el ID de Twitch (`tags['user-id']`); el nick vive solo en `users.username`. Cualquier dato nuevo por usuario debe seguir esa regla y añadirse a `privacy/forget.js` (con su test en `test/forget.test.js`) y a `privacy/retention.js`.
- **Caducidad** (`retention.js`, cada hora): chat 24 h; `quality_log` 30 d; `user_facts` que no son contadores, 90 d; `users` y contadores (`trivia_wins`), 1 año sin actividad (`last_seen`).
- **Nada personal entre streams**: los resúmenes se guardan sin nicks (`names.scrubNicks`), y `active_users`, `trigger_messages` y `recurring_joke` ya no se escriben.
- **Registro de calidad**: sin nicks ni `user_id`; `user_keys` = HMAC (con `EVENTSUB_SECRET`) de los participantes. Olvidar a alguien borra la entrada completa.
- **Lore aprendido**: nada entra en los prompts sin `!lore aprobar` (solo `status = 'active'`, que solo activa un mod).
- **`!fua_olvidame`** limpia también la RAM (cachés, conversaciones, cola de `chat_log`, guardados diferidos) y evita la bienvenida de «primer mensaje» durante 10 min.
- El texto del aviso y del panel está en `docs/aviso-privacidad.md`; si cambian plazos o proveedores, actualizarlo junto con `!privacidad` (`config/messages.json`).

## Convenciones

- **Estado mutable**: toda variable de estado compartida vive en `src/utils/state.js`; nunca en los handlers.
- **require()**: al inicio, agrupados core Node → npm → propios. Excepción: dependencias circulares conocidas (`eventsub` ↔ `ai`, `alerts` ↔ `ai`), lazy dentro de la función.
- **Caché in-memory**: `Map` con TTL (patrón `fullContextCache` / `userFactsCache`), sin dependencias externas.
- **Map con TTL → `setInterval` de pruning** justo después (ver `chisteCooldowns`, `questionCooldowns`, `userFactsCache`).
- **Mensajes al chat**: textos en español en `config/messages.json` (excepto errores internos y logs).
- **`truncate()` obligatorio** en todo `client.say()` con contenido dinámico o de `config/` (límite 500 de Twitch).
- **Supabase**: clave secreta (service role), RLS activado en todas las tablas y sin políticas; nunca volver a la clave anon ni añadir políticas permisivas.
