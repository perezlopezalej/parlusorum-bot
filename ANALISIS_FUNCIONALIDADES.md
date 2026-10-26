# Análisis de funcionalidades — Parlusorum Bot (`dios_fua`)

Informe generado por lectura del código (≈5.000 líneas, sin ejecutar nada). Fecha: 2026-10-26.

**Cómo leer este informe**
- Estado: ✅ completa · 🟡 a medias / con bug o limitación seria · 🔴 rota o probablemente rota.
- Comparativa: **Y** = ya lo tienen los otros · **D** = lo tienen pero el mío lo hace distinto/mejor · **X** = diferencial (no de serie) · **?** = dudoso · **—** = no comparable (infraestructura).
- **Aviso sobre la comparativa:** está hecha de memoria sobre Nightbot, StreamElements, Fossabot y Streamer.bot, sin consultar sus docs actuales (estas herramientas cambian rápido). Donde no estoy seguro lo marco `?`. Antes de usarla de cara al público conviene verificarla.
- "🔴 probablemente" = deducido del código/API de Twitch, **no verificado en ejecución** (no se podía ejecutar el bot).

---

## 1. Resumen

| Métrica | Valor |
|---|---|
| Funcionalidades inventariadas | **56** (48 comparables + 8 de infraestructura) |
| ✅ completas | 42 |
| 🟡 a medias / con bug | 10 |
| 🔴 rotas o probablemente rotas | 4 |
| Ya lo tienen los otros (Y) | 18 |
| Lo hace distinto/mejor (D) | 12 |
| Diferenciales (X) | 14 |
| Dudosos (?) | 2 |
| No aplica (roto / limitador) | 2 |

**Lo que no existe en absoluto:** integración con Discord, OBS, overlays/alertas visuales, panel web, gestión de comandos desde el chat (`!addcom`), puntos de lealtad, sorteos, peticiones de canciones, citas, filtros de moderación (links, spam, palabras prohibidas), multicanal. La configuración es JSON en el repo y requiere redeploy.

---

## 2. Inventario detallado

### 2.1 Comandos (`src/commands/handler.js`, `src/games/handler.js`, `src/ai/handler.js`, `config/commands.json`)

| # | Funcionalidad | Archivo | Estado | Comparativa | Notas |
|---|---|---|---|---|---|
| F1 | `!comandos` (comando estático desde JSON, con cooldown por usuario) | `commands/handler.js:51`, `config/commands.json` | ✅ | Y | Solo hay 1 comando estático; no se pueden crear en caliente. Los 4 competidores lo hacen mejor (editables desde chat/panel). |
| F2 | `!ayuda [cmd]` | `commands/handler.js:278` | ✅ | Y | Texto de ayuda hardcodeado. |
| F3 | `!lurk` con despedida generada por IA (con el juego actual) | `commands/handler.js:108` | ✅ | D | `!lurk` es común; aquí es único por usuario y con fallback estático. |
| F4 | `!uptime` (EventSub; cae a uptime del bot si offline) | `commands/handler.js:147` | ✅ | Y | |
| F5 | `!juego` con género/año/nota de RAWG | `commands/handler.js:158` | ✅ | D | Los otros dan juego/título de Twitch; RAWG es un extra. Requiere `RAWG_API_KEY`. |
| F6 | `!estadisticas` (viewers, juego, followers, uptime) | `commands/handler.js:173` | ✅ | Y | |
| F7 | `!muertes [+1\|reset]` | `commands/handler.js:216` | ✅ | Y | Contador en memoria; se guarda en la sesión al acabar el stream, no persiste a mitad si el bot reinicia. |
| F8 | `!boss` / `!score` (sesión + total histórico en Supabase) | `commands/handler.js:200-214`, `supabase.js:223` | ✅ | Y | Contadores genéricos los tienen todos. `total_losses` existe en BD pero nunca se usa. |
| F9 | `!brb` (recordatorio cada 5 min) | `commands/handler.js:222`, `state.js:18` | ✅ | Y | |
| F10 | `!silencio` (apaga mensajes automáticos) | `commands/handler.js:233` | ✅ | Y | Es un mute global; no persiste tras reinicio. |
| F11 | `!so @user` con shoutout IA según su último juego | `ai/handler.js:683` | ✅ | D | Los otros hacen shoutout con plantilla. No usa el shoutout nativo de Twitch (Helix). |
| F12 | `!clip` (Helix) | `commands/handler.js:239`, `twitch/api.js:266` | ✅ | Y | Streamer.bot sí; en los demás es `?`. El mensaje de error cita un scope incorrecto (`channel:manage:clips`; el real es `clips:edit`). |
| F13 | `!marker [desc]` (marcador de VOD) | `commands/handler.js:251`, `twitch/api.js:375` | ✅ | Y | Streamer.bot sí; resto `?`. |
| F14 | `!resumen` | `commands/handler.js:264` | 🟡 | Y | CLAUDE.md lo describe como 2 mensajes con deaths y pico de viewers; el código manda 1 línea (uptime, msg/h, juego). Además `s.uptime` es uptime del *bot*, no del stream, si EventSub no lo da. |
| F15 | `!chiste` (169 chistes, cooldown 30 s persistente) | `ai/handler.js:596`, `data/chistes.json` | ✅ | Y | Banco estático; nada de IA. |
| F16 | `!trivia`: pregunta **generada por Groq sobre el juego actual** (function calling), dificultad adaptativa por racha, pistas, curiosidad al acertar, fallback a banco estático (31 preguntas) | `games/handler.js` | 🟡 | X | Ver debilidades abajo. |
| F17 | `!dios_fua [pregunta]`: IA con personalidad, tono, memoria de 5 turnos por usuario, límites por rol | `ai/handler.js:619` | ✅ | D | Nightbot/Fossabot pueden llamar a un LLM vía URL/variable (`?`), pero sin memoria conversacional ni contexto de canal. Sin búsqueda web desde que Groq retiró `compound`. |
| F18 | `!moneda` (y `!titulo`, `!loss`, `!metricas`) "ya no existe" | `index.js:316`, `commands/handler.js:91` | 🔴 | — | `!moneda` se enruta a `games.handle`, que no tiene `case` para él → **no responde nada**. Los otros tres sí muestran el mensaje. |

**Debilidades de F16 (trivia):** las "pistas" son las 2 primeras de 4 opciones (pueden ser opciones erróneas, no pistas reales); la respuesta debe coincidir **exactamente** (normalizada) con el texto de la opción correcta, así que respuestas "correctas" escritas distinto se rechazan; no hay ranking ni puntos ni ganador persistido; el banco estático tiene una respuesta (`fuerza universal aplicada`) que contradice el propio prompt del bot, que explica que el FUA no es un acrónimo (ver §5); estado activo guardado en el handler (infringe la convención de `state.js`).

### 2.2 IA y contexto (`src/ai/handler.js`, `src/memory/handler.js`, `src/utils/*`)

| # | Funcionalidad | Archivo | Estado | Comparativa | Notas |
|---|---|---|---|---|---|
| F19 | **Pattern matcher sin `!`**: responde a menciones directas ("dios fua") y frases naturales ("qué juego es", "eres un bot") | `ai/handler.js:923-1031` | 🟡 | X | Funciona, pero **consume el límite global de Groq con cada mensaje de chat** (ver §5, bug nº 1). |
| F20 | **Cohost espontáneo**: comentario aleatorio (25 %, 120 s cooldown) según el chat reciente, con anti-repetición (similitud de contexto + últimos 3 mensajes del bot) y detección de ánimo (hype/frustración) | `ai/handler.js:352` | ✅ | X | |
| F21 | **Hooks anti-silencio**: tras 5 min de chat muerto, 50 % comentario IA sobre el juego (con RAWG), si no, pregunta estática; bienvenida a raiders si hay raid activa; no actúa con < 3 viewers | `ai/handler.js:499` | ✅ | D | Los timers existen en todos; aquí se activan por silencio real y con contexto. |
| F22 | **Comentario IA del juego cada ~25 min** (estilo narrador deportivo) | `timers/handler.js:46` | ✅ | X | Los demás repiten mensajes fijos. |
| F23 | **Modos de personalidad dinámicos** (`hype`, `chill`, `focus`, `victory`, `normal`) deducidos del estado del stream (raid, caps rage, BRB, silencio, marker reciente); cambian prompt, probabilidad de cohost y longitud máxima | `ai/handler.js:230`, `config/channel.json` | ✅ | X | |
| F24 | **Narrativa del stream**: buffer de 5 eventos (victoria, rage…) inyectado en cohost/hooks | `state.js:56`, `ai/handler.js` | 🟡 | X | Solo se emiten `victory` y `rage`. El tipo `death` se **lee** (`ai/handler.js:1000`) pero **nadie lo emite** (`!muertes` no llama a `addNarrativeEvent`) → la rama de "no hagas chistes tras muchas muertes" es código muerto. |
| F25 | **Memoria entre streams**: al acabar, Groq resume el stream (resumen, momentos, frases recurrentes) → Supabase; los 5 últimos se inyectan en el prompt (caché 10 min, saneados) | `memory/handler.js` | ✅ | X | Ningún competidor la trae de serie hasta donde sé (`?` Streamer.bot con scripting propio). |
| F26 | **Hechos por usuario** (`user_facts`: `is_regular`, `last_game_mentioned`, `recurring_joke`) inyectados en el prompt, caducidad 30 días | `memory/handler.js:90`, `supabase.js:397`, `ai/handler.js:281` | 🟡 | X | `recurring_joke` se guarda pero se **filtra fuera del prompt** (`ai/handler.js:287`) → nunca se usa. Se asigna la misma frase a los 5 primeros usuarios activos sin criterio. `is_regular` ya exige ≥ 3 mensajes (el "Known limitation" de CLAUDE.md está desactualizado). |
| F27 | Memoria conversacional por usuario (5 turnos, 1 h, máx. 200 usuarios) | `ai/handler.js:173` | ✅ | D | |
| F28 | Filtro de contenido + anti-prompt-injection antes de cada llamada IA | `utils/filter.js` | 🟡 | D | Lista de subcadenas ES/EN. **Falsos positivos**: "isis" bloquea "crisis", "análisis", "parálisis"; "coger", "simulate", "perra"… Un mensaje bloqueado ni entra al historial ni recibe respuesta. Evadible con ofuscación. Protege a la IA, **no es moderación de chat**. |
| F29 | Límite de peticiones Groq (global 20 rpm; por usuario 3/8/15 rpm según rol) | `utils/ratelimit.js` | 🟡 | — | Bug serio (§5, nº 1). Además, `getUserType` nunca devuelve `'mod'` → `AI_MAX_RPM_MOD` jamás se aplica; streamer y subs usan el límite de "normal". |
| F30 | Detección de tono (frustración/hype/pregunta) y "trampa de confirmación" (el bot no da la razón por defecto) | `ai/handler.js:213-227` | ✅ | X | |
| F31 | **Warmup**: a los 60 s de empezar, si hay < 5 viewers, el bot lanza una pregunta de calentamiento sobre el juego | `eventsub.js:335`, `ai/handler.js:460` | ✅ | X | |
| F32 | **Resumen IA de fin de stream** publicado en el chat | `ai/handler.js:483`, `eventsub.js:355` | ✅ | X | Guarda sesión (peak, mensajes, muertes, top comandos) y evita doble mensaje de cierre. |
| F33 | **Auto-highlights**: 4+ mensajes con palabras clave en 15 s → crea stream marker + narración IA + fila en `stream_highlights` | `ai/handler.js:723` | ✅ | X | Streamer.bot podría montarlo a mano (`?`); ninguno lo trae de serie. |
| F34 | **Narrador de spam de emotes** (8+ usuarios, mismo emote, 20 s) | `ai/handler.js:820` | ✅ | X | Los competidores *moderan* el spam de emotes; este lo *narra*. |
| F35 | **Narrador de CAPS rage** (5+ usuarios, 70 % mayúsculas, 15 s); además alimenta el modo `hype` | `ai/handler.js:887` | ✅ | X | Igual que F34: filtro de caps en los demás, narración aquí. |

### 2.3 Eventos y alertas (`index.js`, `src/eventsub.js`, `src/alerts/handler.js`, `src/timers/handler.js`)

| # | Funcionalidad | Archivo | Estado | Comparativa | Notas |
|---|---|---|---|---|---|
| F36 | Alerta de follow (EventSub `channel.follow` v2, mensaje aleatorio) | `eventsub.js:309` | ✅ | Y | Sin throttle propio: un follow-bot spamearía el chat (solo lo frena la cola IRC). |
| F37 | Alerta de sub (`subscription` de IRC) | `index.js:326`, `alerts/handler.js:202` | 🟡 | Y | Solo el evento `subscription` (nueva sub). No hay `resub`, `subgift`, `submysterygift` ni se usa tier/meses/mensaje. |
| F38 | Alerta de bits por tramos (<100, ≥100, ≥1000) | `alerts/handler.js:206` | ✅ | Y | |
| F39 | Raid: aviso fijo + bienvenida IA con el juego del raider; activa modo `hype` 5 min | `alerts/handler.js:212` | ✅ | D | |
| F40 | Hitos de seguidores (polling cada 5 min, lista en `channel.json`) | `alerts/handler.js:244` | ✅ | Y | Por polling, no por EventSub; un hito puede anunciarse con retraso de hasta 5 min. |
| F41 | Hype train begin/progress/end | `eventsub.js:405-423` | 🔴 (probable) | Y | Ver §5 nº 5: se suscribe por *webhook* usando el token de usuario. |
| F42 | Predicciones (begin/lock/end) y encuestas (begin/end) narradas por IA | `eventsub.js:427-519` | 🔴 (probable) | D | Mismo problema de suscripción. Si funcionara, es más rico que las plantillas de los demás. |
| F43 | Canjes de puntos del canal: si el título contiene "bot/pregunta/dios" responde con IA; si no, agradece | `eventsub.js:521` | 🔴 (probable) | D | Mismo problema. Convierte una recompensa en `!dios_fua`. |
| F44 | Bienvenida IA al **primer mensaje**, aviso de regreso tras ≥ 7 días, aniversario | `alerts/handler.js:62-140` | ✅ | D | Los demás tienen saludo genérico (`?`). |
| F45 | Detección de **lurker que vuelve** (15 min sin hablar; ignora los primeros 15 min del stream) | `alerts/handler.js:143` | ✅ | ? | |
| F46 | Logros por nº de mensajes (10/100/500) | `alerts/handler.js:186` | ✅ | ? | Equivalente a niveles de lealtad en SE/Streamer.bot, pero sin puntos ni tienda. |
| F47 | Timers: 2 mensajes fijos (20/30 min), duración del stream cada 40 min (solo en directo) | `timers/handler.js` | ✅ | Y | Añade un carácter invisible para evitar el filtro de mensaje repetido. |

### 2.4 Moderación

| # | Funcionalidad | Archivo | Estado | Comparativa | Notas |
|---|---|---|---|---|---|
| F48 | **Auto-ban de bots conocidos** consultando twitchbots.info en lotes de hasta 100 ids | `moderation/bot-detector.js` | 🟡 | D | Es la **única** moderación real. Riesgos: (a) no pude confirmar que el endpoint `?ids=` exista (`?`); (b) si la respuesta incluye bots "legítimos" (Nightbot, StreamElements…) los banearía; no hay lista blanca; (c) `422` (ya baneado) se loguea como éxito; (d) `verifiedIds` crece sin límite. Requiere scope `moderator:manage:banned_users`. Sin filtros de links/spam/palabras ni timeouts: aquí los 4 competidores van muy por delante. |

### 2.5 Datos e infraestructura

| # | Funcionalidad | Archivo | Estado | Notas |
|---|---|---|---|---|
| F49 | Persistencia Supabase (tablas: `users`, `stream_sessions`, `stream_memory`, `stream_highlights`, `channel_stats`, `channel_config`, `cooldowns`, `user_facts`) con fallback npoint.io (solo usuarios) y migración automática | `utils/supabase.js`, `utils/storage.js` | 🟡 | Funciona, pero `saveUsers` recorre **todos** los usuarios en cada mensaje (§5 nº 2). Highlights no se guardan sin Supabase. |
| F50 | Cola IRC FIFO (18 msg/30 s, 1,1 s entre mensajes, máx. 50) sobre `client.say` | `utils/irc-ratelimit.js` | ✅ | Hay una segunda cola (1,6 s) en `alerts/handler.js:throttleSay`: doble throttle redundante. No hay prioridades (un mensaje de raid espera tras timers). |
| F51 | Gestión de tokens: refresh automático del broadcaster (en 401) y del bot (cada hora), persistencia en Supabase | `twitch/api.js` | ✅ | Los tokens se guardan en claro en `channel_config` (ver §3). |
| F52 | Receptor EventSub con HMAC-SHA256, `timingSafeEqual`, dedupe por message-id, respuesta 204 inmediata | `eventsub.js`, `index.js:59` | ✅ | |
| F53 | `/health`, `/status`, self-ping cada 10 min, watchdog, reconexión con backoff | `index.js` | ✅ | El watchdog llama a `client.connect()` aun conectado. |
| F54 | Logger a consola y `logs/bot.log` con rotación a 5 MB | `utils/logger.js` | ✅ | Sin tokens en el log actual (0 coincidencias). |
| F55 | Scripts `check-eventsub` (lista/poda suscripciones con callback obsoleto) y `get-bot-token` (OAuth del bot → Supabase) | `scripts/` | ✅ | `get-bot-token.js` y `.claude/settings.json` están sin commitear. |
| F56 | Cooldowns persistentes (`!chiste`, `!dios_fua`, `!lurk`) que sobreviven a reinicios | `supabase.js:354` | ✅ | |

---

## 3. Credenciales

- **No hay credenciales reales hardcodeadas** en los archivos versionados. Los patrones tipo `oauth:…` de `.claude/skills/parlusorum-deploy.md` son marcadores de posición (caracteres repetidos).
- `.env` está en `.gitignore` y no está trackeado actualmente; hay credenciales en `.env` (local), correcto. Falta `EVENTSUB_SECRET` en ese `.env`, así que el bot no arranca en local (hace `process.exit`).
- 🔴 **Credenciales expuestas en el historial de git:** `.env` se commiteó en el commit inicial (`cd72bf9`) y se quitó en `3d1909f`, pero **sigue en el historial**. Por longitudes, contiene valores con aspecto real de `BOT_TOKEN`, `CLIENT_ID` y `CLIENT_SECRET`, y una entrada `ANTHROPIC_API_KEY` (18 caracteres, probablemente un placeholder). El remoto es `github.com/perezlopezalej/parlusorum-bot`; no pude comprobar si el repo es público ni si esos commits se subieron. **Acción recomendada:** rotar el client secret y los tokens del bot, y reescribir el historial o asumir que están comprometidos.
- Tokens de broadcaster y bot guardados **en texto plano** en la tabla `channel_config` de Supabase. Con una clave anon expuesta serían legibles; conviene RLS estricta o cifrado.

---

## 4. Lo que de verdad es diferencial

La mayoría de la capa de **comandos y alertas** es la que ya tienen Nightbot/SE/Fossabot/Streamer.bot (y mejor editable). El valor está en la capa de **contexto e IA**, y sobre todo en que está *conectada entre sí*:

1. **Memoria viva del canal** (F25 + F26 + F27): el bot sabe qué pasó en los últimos 5 streams, quién es habitual y qué dijo antes cada usuario, y lo usa en cada respuesta.
2. **Narrador reactivo del chat** (F33 + F34 + F35 + F23): detecta hype colectivo (palabras clave, emotes, caps), marca el VOD, lo narra y **cambia su propia personalidad** según el momento.
3. **Trivia por juego con dificultad adaptativa** (F16) — hay que pulirla (puntos, aceptar respuestas flexibles).
4. **Presencia proactiva** (F19, F20, F21, F22, F31, F32): habla cuando hay silencio, calienta al abrir, resume al cerrar.
5. **Personalidad con criterio** (F30): no da la razón por sistema; refuerzo periódico de identidad.

---

## 5. Problemas encontrados (ordenados por impacto)

1. **La IA se queda sin cupo por culpa del chat normal.** `checkPatternMatch` llama a `canMakeRequest()` *antes* de comprobar si el mensaje encaja con algún patrón (`ai/handler.js:964`), y `canMakeRequest()` registra un uso cada vez que devuelve `true`. `index.js` lo invoca con **cada** mensaje sin `!`. Con `AI_MAX_RPM=20`, un chat de >20 mensajes/min agota el cupo global sin haber llamado a Groq, y entonces fallan `!dios_fua` ("demasiadas peticiones globales"), cohost, hooks, trivia dinámica, raids, etc. justo cuando el chat está más activo. *Arreglo:* comprobar el patrón primero y pedir el cupo después.
2. **Amplificación de escrituras a Supabase.** `checkFirstMessage` llama a `saveUsers(users)` con todo el objeto tras cada mensaje, y `saveUsers` hace upsert de **todos** los usuarios (`supabase.js:100`). O(N) por mensaje. *Arreglo:* llamar solo a `saveUser(userId, userData)`.
3. **`TWITCH_MAX_LENGTH` no está importado** en `ai/handler.js` (usado en las líneas 406 y 665). Hoy no estalla porque todos los modos definen `max_chars`, pero cualquier modo sin ese campo lanzaría `ReferenceError` en cohost y `!dios_fua`.
4. **`!moneda` no responde** (enrutado a `games.handle` sin handler).
5. **EventSub con token de usuario por webhook (probable fallo).** `registerSubscriptions` crea hype train, predicciones, polls y canjes con `BROADCASTER_TOKEN`, pero, hasta donde sé, las suscripciones con transporte *webhook* exigen **app access token** (el token de usuario es para WebSocket). Si es así, F41–F43 no se registran nunca; el bot solo registraría un `⚠️` en el log. *No verificado:* ejecutar `npm run check:eventsub` o revisar los logs de arranque.
6. **Auto-ban sin lista blanca** (F48), con un endpoint que no he podido confirmar.
7. **Falsos positivos del filtro** ("crisis", "análisis"…) (F28).
8. **Código muerto / incoherencias:** evento narrativo `death` sin emisor (F24), `recurring_joke` filtrado (F26), `AI_MAX_RPM_MOD` sin efecto (F29), `total_losses`, `getModeSetAt`, `getRecentGames`, `isStreamLive` sin usar.
9. **Lore inconsistente:** `ai/handler.js` define el FUA como un grito (no acrónimo) mientras `channel.json` (`bot_personality`) y la trivia lo llaman "Fuerza Universal Aplicada". El modelo recibe señales contradictorias según el camino.
10. **Documentación desactualizada:** el README lista comandos que no existen (`!discord`, `!redes`, `!ruleta`, `!pregunta`, `!cita`, `!consejo`, `!meme`) y CLAUDE.md describe `!resumen` y el límite de `is_regular` de forma que ya no coincide con el código.
11. **Otras:** `!dios_fua` por canje de puntos usa el *nombre* como `user-id` (cooldown por nombre); si Groq cae, el cohost publica un mensaje de error en el chat en vez de callar; la cola `throttleSay` + la cola IRC duplican el throttling.

---

## 6. Ideas de diferencial (poco esfuerzo, sobre lo que ya existe)

1. **Conectar `!muertes` con la narrativa** (esfuerzo: ~5 líneas). Emitir `addNarrativeEvent('death', …)` en `!muertes +1` activa el código ya escrito: el bot cambia de tono tras rachas de muertes (empatía en vez de chistes), y el cohost puede comentar la racha. Es un bot que *reacciona al sufrimiento del streamer*; ningún competidor lo hace de serie.
2. **`!quemeperdi` — "ponme al día" para quien llega tarde.** Ya existen el buffer de chat (`streamChatBuffer`), la narrativa (`getStreamNarrative`), los highlights y el contexto del juego. Un comando que los resuma en 2 frases con la personalidad del bot. Esfuerzo bajo, valor alto para retención y no existe de serie (`?`).
3. **Capítulos de VOD y recap automático.** Ya guardas markers (`marker_id`) con descripción IA, la sesión y el resumen. Exponer `GET /recap` (el servidor HTTP ya existe) con una lista de "momentos" + resumen, o publicarlo en un webhook de Discord al cerrar el stream. Da un entregable tangible por stream sin infraestructura nueva.
4. **Trivia con ranking y memoria.** Guardar el ganador en `user_facts` (`trivia_wins`), añadir `!top` y dejar que la IA mencione al campeón ("@x, el rey de la trivia"). Además, aceptar respuestas por letra/número de opción o por similitud. Convierte la trivia (ya diferencial) en bucle de retención y reutiliza `user_facts`.
5. **Clip automático en el highlight.** El detector ya crea marker y narra; añadir `createClip()` (ya implementado) y que el bot publique el enlace con un título IA. Esfuerzo mínimo; combinaría detección colectiva + clip sin intervención del mod.

---

## 7. Orden sugerido antes de añadir nada

1. Rotar credenciales expuestas en el historial (§3).
2. Corregir el bug de rate limit (§5 nº 1) — afecta a todas las funciones IA.
3. Verificar en logs/`check:eventsub` si hype train/predicciones/polls/canjes se registran (§5 nº 5).
4. Arreglar `saveUsers`, `TWITCH_MAX_LENGTH` y `!moneda` (§5 nº 2-4).
5. Lista blanca en el detector de bots antes de que banee a un bot legítimo (§5 nº 6).
