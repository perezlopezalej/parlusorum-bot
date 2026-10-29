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
- **Cohost por eventos**: comenta primera muerte, rachas de 3, récord, boss, sub, raid y explosión del chat (mín. 5 min entre comentarios, 6/hora); al azar, 1 por hora como máximo y con el chat tranquilo.
- **`timer_ia`**: validación de `quality.js` (`validateTimerIA`), sin citar la nota de RAWG, sin repetir ideas ni despreciar el juego.
- **Timers fijos**: follow cada 60 min; fuera "¿tienes alguna pregunta?" (lo cubre el hook).
- **CI**: `.github/workflows/test.yml` ejecuta `npm ci` y `npm test` (Node 22) en cada push y PR a `main`, con variables falsas.

- **Lore y tono**: vlxj97 es el creador del bot, no del canal (Manu y Pao); sin género para ParLusorum (`validateMention` rechaza tía/tío/amigo/amiga junto a ParLusorum); resumen de fin de stream siempre en positivo con muertes/jefes (`negativeSummary` y `positiveSummaryFallback`).
- **Profecía**: ignora sesiones con 0 muertes, sin historial del juego usa la media de todas las que tienen muertes, y dice siempre "hoy" (`src/ai/prophecy.js`).
- **Encuestas y predicciones**: se narran una sola vez por tipo + id del evento, además del Message-Id (`isRepeatedEvent`). `npm run check:eventsub`: 12 suscripciones, una por tipo, sin duplicados ni callbacks obsoletos.

## Pendiente de probar en directo

- Cohost por eventos (frecuencia, tono, que no invente nada del juego) y la comprobación SÍ/NO (que no descarte demasiado).
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
