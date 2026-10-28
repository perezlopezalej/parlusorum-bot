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

## Pendiente de probar en directo

- Cohost nuevo (frecuencia y tono).
- Menciones y provocaciones (que no dé cuerda al troleo).
- Profecía persistente.
- Lore aprendido.
- `!tiempo`.
- Muertes por juego.

## Ideas futuras

- Que el bot oiga y vea el directo.
- Aprender de las reacciones del chat.
- Detector de bots usando la lista de conectados.
- Tiempo en el canal por usuario.
