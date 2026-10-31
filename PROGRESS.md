# PROGRESS

Estado actual del bot de parlusorum. Se actualiza al terminar cada tarea.

## Hecho

- **Comandos y ayuda**: comandos con cooldowns y permisos, `!ayuda`/`!comandos`, timers recurrentes.
- **IA (Dios Fua)**: respuestas por mención, chistes, cohost, hooks para animar el chat, reacción a emotes/caps, `!quemeperdi` y resumen de fin de stream.
- **Memoria y lore**: resúmenes entre streams, lore manual y aprendido, `!lore` para mods, memoria conversacional por usuario.
- **Juegos**: trivia dinámica por juego con banco de respaldo y ranking `!top`.
- **Alertas**: subs, bits, raids, hitos de followers, lurkers y bienvenida.
- **Directo**: detección de inicio y fin de stream, sesiones guardadas y avisos de seguimiento.
- **Moderación**: detección de bots con lista blanca (autoban solo en modo prueba).
- **Validación de respuestas**: `quality.js` revisa tono, muertes, nombres, emotes y cortes antes de enviar.
- **Registro del chat**: `chat_log` en Supabase con el origen de cada respuesta del bot y export con `npm run chatlog`.
- **`!tiempo`**: cuánto lleva un usuario en el canal desde su primer mensaje registrado por el bot (`!tiempo` o `!tiempo @usuario`).
- **Muertes por juego**: `!muertes <juego>` suma las muertes de todos los streams de ese juego.
- **Lore del canal**: Manu y Pao incluidos como streamers del canal.
- **Búsqueda de juegos**: `buscar_juego` con RAWG descartando resultados que no se parecen.
- **Copia de seguridad**: script `npm run backup` de Supabase.
- **Infraestructura**: Supabase, despliegue automático en Render, cola anti-límite de IRC, watchdog y tests.
- **Sin datos inventados del juego**: cohost, hook, `timer_ia` y menciones no hablan de mecánicas, armas, zonas ni dificultad; antes de enviar, una comprobación SÍ/NO con el modelo rápido (`src/ai/factcheck.js`) descarta lo que afirme algo sin respaldo (si falla, calla). `!dios_fua` solo da datos de `buscar_juego` (RAWG).
- **Menciones**: preguntas concretas del juego se redirigen a `!dios_fua`; por las muertes se da el contador real.
- **Cohost por eventos**: boss, primera muerte, racha (3 o más muertes en 10 min, sumando `!muertes +N`), récord, sub, raid y explosión del chat se comentan siempre (salvo `!silencio`, BRB o trivia activa). Van a una cola de uno en uno (15 s entre ellos) y caducan si esperan más de 2 min (`COHOST_EVENT_TTL_MS`); tope de seguridad de 20/h.
- **Cohost libre por reloj**: cada ~15 min (`COHOST_FREE_INTERVAL_MS`, ≈4/h), si hubo ≥3 mensajes en los últimos 5 min, reacciona a un tema concreto del chat con humor (sin juzgar el ambiente). Sin probabilidad por mensaje; si falla reintenta a los 3 min.
- **Factcheck selectivo**: `factcheck.shouldDiscard` solo comprueba mensajes que hablan del juego (`quality.mentionsGame`: nombre, mecánicas, datos). Si no hablan del juego, se envían sin comprobar; si hablan del juego y la comprobación falla o no hay cupo, se descartan. Cupo propio `AI_MAX_RPM_AUX` (15/min) y `AI_MAX_RPM` global sube a 30.
- **Quality más blando**: `validateCohost` marca `soft` (nombre repetido, fórmula, parecido, juzgar el ambiente): reintento único y, si persiste, se envía. Se descarta solo lo grave (inventos del juego, muertes que no cuadran, latam, robot). El emote sobrante se quita en código (`applyEmotePolicy`).
- **Contadores de fin de stream**: el log muestra comentarios intentados/enviados (eventos y libres), motivos de descarte (`skip`, `quality:<regla>`, `factcheck`, `factcheck_ratelimit`/`_error`/`_groq429`, `ratelimit`, `silencio`, `brb`, `trivia`, `caducado`, `cola_llena`, `error`) y los 429 de Groq (límite del proveedor) aparte de nuestro rate limit interno.
- **`timer_ia`**: validación de `quality.js` (`validateTimerIA`), sin citar la nota de RAWG, sin repetir ideas ni despreciar el juego.
- **Timers fijos**: follow cada 60 min; fuera "¿tienes alguna pregunta?" (lo cubre el hook).
- **CI**: `.github/workflows/test.yml` ejecuta `npm ci` y `npm test` (Node 22) en cada push y PR a `main`, con variables falsas.

- **Lore y tono**: vlxj97 es el creador del bot, no del canal (Manu y Pao); sin género para ParLusorum (`validateMention` rechaza tía/tío/amigo/amiga junto a ParLusorum); resumen de fin de stream siempre en positivo con muertes/jefes (`negativeSummary` y `positiveSummaryFallback`).
- **Profecía**: ignora sesiones con 0 muertes, sin historial del juego usa la media de todas las que tienen muertes, y dice siempre "hoy" (`src/ai/prophecy.js`).
- **Encuestas y predicciones**: se narran una sola vez por tipo + id del evento, además del Message-Id (`isRepeatedEvent`). `npm run check:eventsub`: 12 suscripciones, una por tipo, sin duplicados ni callbacks obsoletos.

## Pendiente de probar en directo

- Cohost libre y por eventos (≈4 libres/h, que reaccionen a un tema sin juzgar el ambiente; `!muertes +2` dispara primera muerte/racha/récord) y la comprobación SÍ/NO: mirar en `bot.log` la línea "cohost descartado" para ver si descarta demasiado.
- Redirección de menciones del juego a `!dios_fua` y respuesta con el contador de muertes.
- Menciones y provocaciones (que no dé cuerda al troleo).
- Profecía persistente (con la nueva media y diciendo "hoy").
- Resumen de fin de stream en positivo y que no trate a ParLusorum con género.
- Encuesta/predicción: un solo mensaje por evento.
- Lore aprendido.
- `!tiempo`.
- Muertes por juego.

## Ideas futuras

- Que el bot oiga y vea el directo.
- Aprender de las reacciones del chat.
- Detector de bots usando la lista de conectados.
- Tiempo en el canal por usuario.
