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
- **Menciones**: tope por usuario (`MENTION_MAX_PER_USER` 3 cada `MENTION_WINDOW_MS` 5 min) y las respuestas con más de 20 s de espera se descartan (también en la cola IRC, `expiresAt`). Si la IA no da respuesta válida en una mención normal, se calla; las réplicas de reserva son solo para provocaciones reales.
- **`!quemeperdi`**: datos etiquetados (minutos, muertes, jefes), `validateQueMePerdi` (sin "enemigos derribados", cifras de muertes y jefes), factcheck y 1 reintento.
- **Hooks estáticos**: sin nota de RAWG y con géneros en español (`src/utils/genres.js`).
- **`timer_ia`**: tema obligatorio sorteado distinto al anterior (lore, FUA, usuario activo, tiempo, pregunta al chat); sin nombrar otros juegos ni repetir el año; el tema "usuario" respeta los 15 min sin nombrar al mismo usuario.
- **Profecía**: `falseSurpass` rechaza "superando/récord" si la cifra no supera las anteriores.

- **F0 vida y aprendizaje (medir y autorrevisión)**: `src/ai/reactions.js` puntúa la reacción del chat (60 s) a los mensajes de la IA (cohost, mención, timer_ia, hook, quemeperdi, dios_fua; no timers ni comandos) restando la risa de base; `chat_log.reply_parent_login` guarda a quién responde cada usuario. `src/ai/self-review.js`, al acabar el stream (15 s después del cierre), marca repeticiones, posibles inventos, negativos e ignorados, y la IA redacta un informe corto solo sobre ellos: va a `bot.log` y a `bot_self_reviews`, nunca al chat ni al prompt. Migración `supabase/migrations/006_vida_aprendizaje_f0.sql`. Plan completo en `logs/plan-vida-aprendizaje.md`.

- **Cultura general sin control de videojuegos**: `!dios_fua` y menciones solo aplican la comprobación contra RAWG / "no inventar" si la pregunta o la respuesta hablan de juegos (`quality.talksAboutGames`: palabras de gaming o nombre del juego actual). Para el resto (ej. las abejas) responde con el conocimiento del modelo, corto y con humor si duda (`GENERAL_RULE` en `prompts.js`; la herramienta `buscar_juego` queda marcada solo para videojuegos). Nada técnico en el chat: `quality.leaksTech` (solo RAWG, "base(s) de datos", "no tengo datos", "mis datos", "herramienta(s)", "API" y `buscar_juego`; la palabra "datos" suelta se permite) rechaza la mención o cambia `!dios_fua` por una de las frases de `dios_fua_no_data` (ahora lista con personalidad); `!juego` y `!ayuda` ya no citan RAWG.

- **Evaluación con IA real**: `npm run eval` (`scripts/eval.js` + `test/eval-cases.json`, 9 casos de los logs) pasa cada caso por `handleQuestion`/`checkPatternMatch` reales con un cliente de chat falso y las escrituras a Supabase bloqueadas; muestra respuesta, filtro que descartó y si cumple lo esperado (informe en `logs/eval.txt`, `--only id`, `--verbose`). No se ejecuta en `npm test` ni en la CI.

- **Arreglos del primer eval**: el factcheck de `!dios_fua` solo marca datos concretos y comprobables (fechas, estudio, mecánicas, armas, zonas, dificultades, personajes, tramas) ausentes de RAWG, incluida la descripción; opiniones y tono no se comprueban. Si descarta con datos reales hay un único reintento ciñéndose a ellos. Juego que RAWG no encuentra y descartado → `dios_fua_unknown_game` (humor, "no lo conozco") en vez de `dios_fua_no_data`. Menciones: tope `MENTION_MAX_CHARS` = 200 (con el @usuario, recortado en final de frase) y el prompt pide ≤150; caso `cielo-azul` del eval a 200. `applyEmotePolicy` ya no quita el espacio en "usa !dios_fua" (`SPACE_BEFORE_PUNCT_RE`, con test). Las frases de reserva de `messages.json` se comprobaron: ninguna se corta con `truncate`.

- **Factcheck con motivo y plantilla RAWG**: con `source: 'rawg'` el verificador responde "NO" o "SÍ: <frase no respaldada>" (`factcheck.evaluate` → `{discard, claim}`; `shouldDiscard` sigue devolviendo boolean). El reintento de `!dios_fua` recibe esa frase ("no digas X, cíñete a los datos"). Si el reintento falla y RAWG tiene el juego (coincidencia exacta), se responde con `buildRawgTemplate` (`src/ai/rawg-template.js`: nombre, género en español, estudio, año + frase de `dios_fua_rawg_quips`); `dios_fua_no_data` queda solo para cuando no hay datos. `eval.js`: cada repetición usa un usuario distinto y se instrumenta `evaluate`. Tests en `test/rawg-template.test.js`.

- **Diagnóstico de latencia/inestabilidad del eval**: las llamadas sueltas tardan ~1 s; los 22 s eran esperas de `retry-after` tras 429 (`requestWithRetry` dormía lo que pidiera Groq) y los casos `signo-zodiaco`/`cielo-azul` sin respuesta eran el cupo diario TPD de `gpt-oss-20b` (200k) agotado por las propias tandas de eval (cada mención gasta ~3k tokens). La provocación es una sola llamada, sin factcheck ni reintentos. Arreglos: `groqWithRetry(params, retries, { maxDelayMs })` falla al momento si la espera supera el tope (provocación 3 s → réplica de reserva; menciones 5 s → callan, como ya hacían si llegaban tarde); temperatura 0,3 en cultura general (`!dios_fua` sin juego y menciones) y regla de prudencia en `GENERAL_RULE`; eval con tiempos por llamada y nº de 429 por caso, motivo "Groq 429 (cupo agotado)", campo `informativo` (avisa pero no cuenta; `abejas` marcado). Test del tope en `groq-fallback.test.js`.

## Pendiente de probar en directo

- Eval `--repeat 3` tras la plantilla RAWG: hell-is-us 3/3; siguen inestables `abejas` (la IA a veces responde "No, al revés", mal) y casos con latencia de Groq >20 s (respuesta tardía descartada, sobre todo `provocacion`). Eval 2026-10-31 anterior: 9/9 (la IA real es variable: `quien-lleva-el-canal` falló 2 de 4 tandas por omitir a vlxj97; repetir el eval si un caso suelto falla).

- Pregunta de cultura general con `!dios_fua` y por mención ("es cierto que las abejas en verano viven menos que en invierno?"): debe responder corto y sin hablar de RAWG/datos; una pregunta de juego sigue consultando `buscar_juego`.

- F0: tras ejecutar la migración 006 y hacer un directo, comprobar en `bot.log` las líneas "📊 Reacciones" y "📝 Autorrevisión del bot" y la fila en `bot_self_reviews`; revisar si la detección de risas/negativas acierta (es la línea base para F1-F5).

- Cohost libre y por eventos (≈4 libres/h, que reaccionen a un tema sin juzgar el ambiente; `!muertes +2` dispara primera muerte/racha/récord) y la comprobación SÍ/NO: mirar en `bot.log` la línea "cohost descartado" para ver si descarta demasiado.
- Redirección de menciones del juego a `!dios_fua` y respuesta con el contador de muertes.
- Menciones y provocaciones (que no dé cuerda al troleo).
- Tope de menciones (3 cada 5 min) con un usuario spameando "dios fua", y que no salgan respuestas tardías.
- `!quemeperdi` con cifras correctas y variedad de temas en `timer_ia`.
- Profecía persistente (con la nueva media y diciendo "hoy").
- Resumen de fin de stream en positivo y que no trate a ParLusorum con género.
- Encuesta/predicción: un solo mensaje por evento.
- Lore aprendido.
- `!tiempo`.
- Muertes por juego.

## Ideas futuras

- Que el bot oiga y vea el directo.
- Aprender de las reacciones del chat: fases F1-F5 de `logs/plan-vida-aprendizaje.md` (carácter, seguir el juego, chistes internos y `regulars`, ejemplos aprendidos con `!estilo`, intervalo adaptable). Chistes aprobados para el borrador: profecía que siempre falla, Pao con "¡Joooosuaaa!", Monster y caramelos de gangar79, su "back-trakin" y rivalidad cariñosa (pendiente de que gangar79 acepte). Descartados: "el retraso de Manu" y expresiones con etnias.
- Detector de bots usando la lista de conectados.
- Tiempo en el canal por usuario.
