# Funcionalidades — parlusorum-bot

_Documento único que sustituye a `INVENTARIO_FUNCIONES*.md` (v1–v4) y `ANALISIS_FUNCIONALIDADES.md`. La base es el inventario v4 (2026-10-27, HEAD 9e69e64, 219 tests pasando); al final se conserva lo útil del análisis del 2026-10-26 (comparativa con otros bots, diferenciales, ideas). Las versiones anteriores del inventario y los bugs ya corregidos del análisis se han descartado; siguen en el historial de git (los `v2`–`v4` eran locales y no se conservan)._

_Auditoría de solo lectura (2026-10-27) repetida sobre el código actual (HEAD 9e69e64, árbol limpio) y comparada con INVENTARIO_FUNCIONES_v3.md (HEAD 3afa21e). Se ha ejecutado `npm test` (219 pasan, 0 fallan) pero no el bot, y no se ha leído .env._

**Alcance real de la revisión:** desde v3 hay 4 commits (71a29fb tests de memoria/lore, 523b142 cohost/narrativa/pausas, 93a7ef1 respuesta natural y modos, 9e69e64 subs con contexto, trivia del canal y trivia_wins). He leído el diff completo de src/ y config/ (21 ficheros, +1403/−122) y los módulos nuevos (patterns.js, narrative.js, sub-context.js, channel-questions.js). Las notas de lo que esos commits no tocan se reutilizan de v3 sin releer su código; las comprobaciones "no re-verificado" de v3 siguen sin verificarse. Verificado a mano: SIGTERM sigue solo registrando la cola (src/utils/irc-ratelimit.js:89) y GROQ_MODEL_FALLBACKS sigue sin estar en CLAUDE.md.

**PRUEBAS_EN_DIRECTO.md:** no existe en el repositorio, así que no se ha podido tener en cuenta. La solidez se valora solo por lectura de código y tests; nada de lo nuevo (cohost, modos, patrones, contexto de subs) está contrastado en un directo real.

**Funcionalidades:** 73 (72 de v3 + 1 nueva) · **Criterios:** S solidez 40 %, V valor 30 %, D diferenciación 30 %; final = 0,4·S + 0,3·V + 0,3·D, redondeado a 1 decimal (las medias usan las notas redondeadas).

**Importancia:** Núcleo ×3 (19) · Importante ×2 (33) · Básico ×1 (21). No depende de la nota. Las medias de v3 se recalculan aquí con la misma fórmula sobre las 72 funciones de v3.

## Inventario: medias

| Media | v3 | v4 | Δ |
|---|:-:|:-:|:-:|
| Simple (v3: 72; v4: 73) | 5.93 | 6.07 | +0.14 |
| Ponderada por importancia | 6.21 | 6.37 | +0.16 |
| Solo núcleo (19) | 6.97 | 7.19 | +0.22 |

- Media Núcleo (19): v3 6.97 → v4 7.19
- Media Importante (33): v3 5.92 → v4 6.08
- Media Básico (21): v3 5.02 → v4 5.03

## Comandos

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| !lurk (despedida IA) | 8 | 5 | 6 | 6.5 | **6.5** | B | Sin cambios. Fallback fijo si Groq falla. _Importancia: Detalle simpático; lo cubre cualquier bot._ |
| !uptime | 8 | 4 | 2 | 5.0 | **5.0** | B | Sin cambios. |
| !juego (RAWG) | 8 | 5 | 5 | 6.2 | **6.2** | B | Sin cambios. |
| !estadisticas | 7 | 4 | 3 | 4.9 | **4.9** | B | Sin cambios. |
| !muertes (+1/reset) | 8 | 6 | 3 | 5.9 | **5.9** | I | ▲ Ya se persiste en stream_sessions.death_count (guardado con retardo de 3 s) y se recupera si el bot arranca con el stream en directo; test de pickOpenSession. Límites: se pierde si no hay sesión abierta y no se restaura fuera de directo. _Importancia: Alimenta profecía, !quemeperdi y !score; el streamer lo usa a menudo._ |
| !boss / !score | 6 | 6 | 4 | 5.1 | **5.4** ▲ | I | ▲ (V) !boss ya alimenta la narrativa y dispara el modo victoria. Sigue sin atomicidad y con total_losses huérfano. |
| !brb | 7 | 5 | 3 | 5.2 | **5.2** | I | Sin cambios. no se apaga al acabar el stream (no re-verificado). _Importancia: Comando de stream._ |
| !silencio | 7 | 6 | 3 | 5.5 | **5.5** | I | Sin cambios. _Importancia: Interruptor de seguridad de los mods; protege el funcionamiento._ |
| !so (shoutout IA) | 7 | 6 | 6 | 6.4 | **6.4** | I | Sin cambios. _Importancia: Comando de stream, uso a menudo._ |
| !clip | 7 | 6 | 2 | 5.2 | **5.2** | I | Sin cambios. _Importancia: Comando de stream._ |
| !marker | 7 | 5 | 4 | 5.5 | **5.5** | I | Sin cambios. _Importancia: Comando de stream._ |
| !resumen | 5 | 3 | 3 | 3.8 | **3.8** | B | Sin cambios. casi duplica !estadisticas y !quemeperdi lo supera. |
| !comandos / !ayuda | 8 | 4 | 2 | 5.0 | **5.0** | B | ▲ Una sola fuente (config/help.json + src/commands/help.js): lista y ayuda se generan del mismo JSON, !top/!quemeperdi/!lore ya aparecen, !lore oculto a no mods, con tests. Pendiente: nada impide que un comando nuevo del switch se olvide en help.json. _Importancia: Accesorio, pero es la vía para descubrir comandos nuevos (dudoso Básico/Importante)._ |
| Comandos personalizados (config JSON) | 5 | 3 | 1 | 3.2 | **3.2** | B | Sin cambios. en nota: commands.json ya está vacío ("commands": {}), solo queda el mecanismo. |

## IA

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| !dios_fua (Q&A + tool buscar_juego) | 8 | 9 | 9 | 8.6 | **8.6** | N | Sin cambios. Sin búsqueda web. _Importancia: Define al bot._ |
| Personalidad / modos / tono | 8 | 8 | 8 | 7.7 | **8.0** ▲ | N | ▲ Los modos se deciden con la narrativa (victory/hype/ánimo por racha de muertes/BRB/chill), caducan por la hora de cada evento, permanencia mínima 60 s, max_tokens/max_chars/cooldowns por modo y variante BRB; decideMode con tests. Se nota de verdad en longitud y tono. |
| Respuesta natural (@dios_fua y patrones) | 8 | 7 | 8 | 7.3 | **7.7** ▲ | N | ▲ Detección pura en patterns.js (menciones con errata/tildes/mayúsculas, patrones anclados a frase completa, ignora respuestas y @ a otros), cooldown escalado por modo, la reserva de cooldown se devuelve si la IA falla, "blocked" distingue de "no era para el bot" para el cohost; test/patterns.test.js. Límite: el flujo checkPatternMatch (E/S) no se prueba. |
| Co-host espontáneo | 7 | 7 | 8 | 6.6 | **7.3** ▲ | N | ▲ Probabilidad por mensaje que crece con el silencio del cohost, tope por hora (10), cooldown 180 s, turno en pausas del chat tras el hook, contexto con resumen del chat, minutos de stream y muertes, historia con tiempos relativos; un fallo de la IA no gasta cupo. Funciones puras con tests (narrative.test.js); handleCohost en sí no tiene test. Límite: la comparación de similitud de contexto sigue siendo burda. |
| Hooks de silencio | 7 | 5 | 6 | 5.4 | **6.1** ▲ | I | ▲ Ahora coordinados con el cohost por turnos (un hook y un cohost por pausa; claimHookPause con test) y con la narrativa con tiempos. Sigue limitado a chat callado y a un mínimo de espectadores. |
| Comentario IA del juego (25 min) | 7 | 5 | 7 | 6.4 | **6.4** | I | Sin cambios. _Importancia: Periódico y visible, pero no decisivo._ |
| Detección de highlights + marker + narración | 7 | 8 | 8 | 7.6 | **7.6** | I | Sin cambios. Siguen keywords con falsos positivos ("gg"). _Importancia: Listado como Importante._ |
| Detección de spam de emotes | 7 | 5 | 7 | 6.4 | **6.4** | I | Sin cambios. _Importancia: Reacción frecuente en directos con emotes._ |
| Detección de CAPS rage | 6 | 4 | 7 | 5.7 | **5.7** | B | Sin cambios. _Importancia: Humor accesorio._ |
| !chiste (banco estático) | 8 | 4 | 3 | 5.3 | **5.3** | B | Sin cambios. _Importancia: Banco estático._ |
| Warmup al empezar el stream | 7 | 6 | 8 | 7.0 | **7.0** | B | Sin cambios. _Importancia: Una vez por directo y solo con <5 espectadores (dudoso)._ |
| Inicio / fin de stream (+ resumen IA) | 7 | 6 | 6 | 6.4 | **6.4** | I | Sin cambios. _Importancia: Cierra el ciclo del stream y dispara la memoria._ |
| Filtro anti-inyección / contenido | 7 | 6 | 5 | 6.1 | **6.1** | N | Sin cambios. Lista de bloqueo evasible. _Importancia: Seguridad._ |
| Infra Groq (retry, rate limit, reasoning, modelos de reserva) | 8 | 6 | 3 | 5.9 | **5.9** | N | ▲ Cadena de modelos de reserva ante 404/model_decommissioned (GROQ_MODEL_FALLBACKS, por defecto el modelo rápido), parámetros de razonamiento por modelo, tests. Límites: si el modelo de reserva también cae no hay tercero; GROQ_MODEL_FALLBACKS no está en CLAUDE.md. _Importancia: Toda la IA depende de ella: estabilidad._ |
| !quemeperdi | 8 | 8 | 8 | 7.6 | **8.0** ▲ | I | ▲ Usa la narrativa ampliada y con tiempos: resume mucho mejor lo que se perdió el espectador. |
| Profecía de muertes | 7 | 6 | 9 | 7.3 | **7.3** | I | Sin cambios. no compara si nadie lleva la cuenta (!muertes); ahora el contador sobrevive a reinicios. _Importancia: Listado como Importante._ |

## Memoria

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Memoria entre streams | 8 | 8 | 9 | 7.9 | **8.3** ▲ | N | ▲ Ahora con tests (parseo JSON, degradación sin IA, saneado, caché y TTL, fallo de Supabase). |
| Hechos por usuario (user_facts) | 6 | 5 | 8 | 5.6 | **6.3** ▲ | I | ▲ recurring_joke ya se usa (contexto de subs) y trivia_wins se lee sin la caducidad de 30 días. Siguen siendo pocos tipos de hecho y poco visibles fuera de los subs. |
| Conversación por usuario | 7 | 6 | 7 | 6.7 | **6.7** | N | Sin cambios. solo RAM. _Importancia: Da continuidad a cada charla con el bot (dudoso)._ |
| Narrativa del stream (eventos) | 8 | 7 | 8 | 6.6 | **7.7** ▲ | N | ▲ 12 eventos (antes 5) con poda por prioridad, alimentada por subs, raids, bits ≥500, hitos y bosses (antes solo muertes/rage/victoria), persistida en Supabase y recuperada tras reinicio, bloque con "hace Nmin"; tests. Límite: depende de la columna stream_sessions.narrative, sin migración en el repo (no verificado en la base); se pierde si el proceso muere dentro de los 3 s de retardo. |
| Sesiones, highlights y métricas en Supabase | 6 | 6 | 5 | 5.7 | **5.7** | I | Sin cambios. _Importancia: Base de profecía, memoria y backup._ |

## Moderación

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Detector de bots (twitchbots.info) | 7 | 6 | 5 | 6.1 | **6.1** | I | Sin cambios. ; sigue en dry-run por diseño. _Importancia: Seguridad, pero en dry-run no actúa (dudoso)._ |

## Alertas

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Subs (sub, resub, gift, mystery, Prime, upgrade) | 8 | 7 | 8 | 7.1 | **7.7** ▲ | N | ▲ El agradecimiento puede incluir un dato del suscriptor (apodo oficial, frase habitual, trivias ganadas, habitual) por lista blanca y sin temas vetados; best-effort si falla; test/sub-context.test.js. Cada sub entra en la narrativa. |
| Bits | 7 | 4 | 2 | 4.6 | **4.6** | I | Sin cambios. _Importancia: Alerta de dinero, poco frecuente (dudoso)._ |
| Raid + modo raid | 7 | 6 | 7 | 6.4 | **6.7** ▲ | N | ▲ (D) El raid entra en la narrativa y activa el modo hype. |
| Nuevo seguidor (EventSub) | 8 | 5 | 3 | 5.6 | **5.6** | I | Sin cambios. _Importancia: Frecuente._ |
| Hitos de seguidores | 6 | 5 | 4 | 4.8 | **5.1** ▲ | B | ▲ (V) El hito entra en la narrativa (modo victoria) aunque el bot esté en silencio. |
| Bienvenida primer mensaje (IA) | 7 | 6 | 6 | 6.4 | **6.4** | I | Sin cambios. _Importancia: Listado como Importante._ |
| Regreso tras 7+ días | 7 | 4 | 5 | 5.5 | **5.5** | B | Sin cambios. |
| Lurker que vuelve | 6 | 4 | 4 | 4.8 | **4.8** | B | Sin cambios. |
| Logros por mensajes | 7 | 4 | 4 | 5.2 | **5.2** | B | Sin cambios. |
| Aniversario de primer mensaje | 5 | 3 | 4 | 4.1 | **4.1** | B | Sin cambios. |
| Hype train | 8 | 5 | 4 | 5.9 | **5.9** | I | Sin cambios. _Importancia: Evento de alta carga del canal._ |
| Predicciones (IA) | 7 | 5 | 7 | 6.4 | **6.4** | I | Sin cambios. _Importancia: Interacción de canal._ |
| Encuestas (IA) | 7 | 4 | 7 | 6.1 | **6.1** | B | Sin cambios. |
| Canjes de puntos (IA / pregunta al bot) | 6 | 6 | 7 | 6.3 | **6.3** | I | Sin cambios. _Importancia: Interacción directa con el bot._ |
| Timers (2 fijos + duración 40 min) | 8 | 5 | 2 | 5.3 | **5.3** | B | Sin cambios. _Importancia: Mensajes estáticos._ |

## Trivia

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Trivia dinámica (Groq + datos RAWG) | 8 | 7 | 8 | 7.7 | **7.7** | N | Sin cambios de código propio; ahora un 25 % de las partidas pasa antes por la pregunta del canal (fila nueva) y esta es la que se usa si no hay datos del canal. |
| Banco estático (32 preguntas) | 7 | 4 | 4 | 5.2 | **5.2** | I | Sin cambios. _Importancia: Fallback que mantiene viva la trivia sin Groq._ |
| Pistas + coincidencia difusa | 9 | 5 | 5 | 6.6 | **6.6** | N | Sin cambios. _Importancia: Sin ella la trivia no se juega bien._ |
| Dificultad adaptativa | 6 | 4 | 8 | 6.0 | **6.0** | I | Sin cambios. racha en RAM. |
| Ranking de trivia + !top + campeón en el contexto IA | 8 | 7 | 6 | 6.7 | **7.1** ▲ | I | ▲ trivia_wins sin caducidad (getUserCounter): el ranking y el contexto IA ya no pierden victorias antiguas. |
| Preguntas de trivia sobre el canal (plantilla, sin IA) | 8 | 6 | 9 | nueva | **7.7** (nueva) | I | NUEVA. 25 % de las partidas: récord de muertes, juego del récord, juegos distintos, líder del ranking y "completa el lema" del lore activo; solo cifras, títulos y lore neutro (sin trama), sin repetir, con alias; cubierta en test/sub-context.test.js. Límite: necesita ≥3 sesiones guardadas. |

## Infraestructura

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Receptor EventSub (HMAC, anti-replay, dedupe) | 8 | 8 | 4 | 6.8 | **6.8** | N | Sin cambios. _Importancia: Sin él no hay alertas ni estado de directo._ |
| Gestión de tokens (bot + broadcaster, OAuth) | 8 | 8 | 4 | 6.8 | **6.8** | N | Sin cambios. _Importancia: Seguridad y continuidad._ |
| Conexión IRC (watchdog + backoff) | 8 | 8 | 2 | 6.2 | **6.2** | N | Sin cambios. _Importancia: Estabilidad de la conexión._ |
| Cola IRC anti-throttle | 7 | 7 | 2 | 5.5 | **5.5** | N | Sin cambios. SIGTERM solo registra lo pendiente. _Importancia: Evita limitación/baneos de Twitch (dudoso Núcleo/Importante)._ |
| Cola de alertas (throttleSay) | 7 | 5 | 3 | 5.2 | **5.2** | I | Sin cambios. |
| Almacenamiento Supabase / npoint | 7 | 6 | 2 | 5.2 | **5.2** | I | Sin cambios. _Importancia: Soporta memoria, ranking y tokens._ |
| Cooldowns persistentes | 7 | 3 | 2 | 4.3 | **4.3** | B | Sin cambios. |
| /health, /status y self-ping | 7 | 6 | 1 | 4.9 | **4.9** | I | Sin cambios. _Importancia: Evita que Render duerma el bot._ |
| Logger con rotación | 7 | 4 | 1 | 4.3 | **4.3** | B | Sin cambios. |
| Métricas del bot | 5 | 3 | 2 | 3.5 | **3.5** | B | Sin cambios. |
| Scripts (check-eventsub, get-bot-token) | 7 | 5 | 2 | 4.9 | **4.9** | B | Sin cambios. |
| Script de copia de seguridad (npm run backup) | 7 | 7 | 2 | 5.5 | **5.5** | I | Sin cambios. manual, sin programación ni restauración. _Importancia: Listado como Importante._ |
| Tests (node:test, 219) | 9 | 7 | 1 | 5.3 | **6.0** ▲ | I | ▲ 219 tests pasan (antes 56), 37 suites, 0 fallos. Ahora cubren memoria entre streams, lore, narrativa/modos, patrones y contexto de subs. Siguen sin cubrir EventSub, el despacho de comandos ni los flujos con E/S (handleCohost, checkPatternMatch). |

## Lore

| Funcionalidad | S | V | D | v3 | v4 | Imp. | Notas |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Lore manual (identidad, chistes internos, temas a evitar) | 8 | 7 | 9 | 8.0 | **8.0** | N | Sin cambio de nota. Nuevo: apodos oficiales (config/lore.json "nicknames", hoy vacío) filtrados por temas vetados. |
| Lore aprendido entre streams | 8 | 8 | 9 | 7.9 | **8.3** ▲ | N | ▲ Ahora con tests (promoción, decaimiento, archivado, candidatos inventados, degradación sin IA, contexto y caché). |
| !lore (ver / aprobar / borrar) | 8 | 6 | 8 | 7.0 | **7.4** ▲ | I | ▲ approve/delete/overview cubiertos por tests; el comando en sí sigue sin test. |

_Imp.: N = Núcleo (×3), I = Importante (×2), B = Básico (×1)._

## Núcleo: peor y mejor

- Peor puntuadas: Cola IRC anti-throttle (5.5); Infra Groq (retry, rate limit, reasoning, modelos de reserva) (5.9); Filtro anti-inyección / contenido (6.1)
- Mejor puntuadas: !dios_fua (Q&A + tool buscar_juego) (8.6); Lore aprendido entre streams (8.3); Memoria entre streams (8.3)

## Núcleo completo, de menor a mayor

- Cola IRC anti-throttle: 5.5 (v3 5.5)
- Infra Groq (retry, rate limit, reasoning, modelos de reserva): 5.9 (v3 5.9)
- Filtro anti-inyección / contenido: 6.1 (v3 6.1)
- Conexión IRC (watchdog + backoff): 6.2 (v3 6.2)
- Pistas + coincidencia difusa: 6.6 (v3 6.6)
- Conversación por usuario: 6.7 (v3 6.7)
- Raid + modo raid: 6.7 (v3 6.4)
- Receptor EventSub (HMAC, anti-replay, dedupe): 6.8 (v3 6.8)
- Gestión de tokens (bot + broadcaster, OAuth): 6.8 (v3 6.8)
- Co-host espontáneo: 7.3 (v3 6.6)
- Respuesta natural (@dios_fua y patrones): 7.7 (v3 7.3)
- Narrativa del stream (eventos): 7.7 (v3 6.6)
- Subs (sub, resub, gift, mystery, Prime, upgrade): 7.7 (v3 7.1)
- Trivia dinámica (Groq + datos RAWG): 7.7 (v3 7.7)
- Personalidad / modos / tono: 8.0 (v3 7.7)
- Lore manual (identidad, chistes internos, temas a evitar): 8.0 (v3 8.0)
- Memoria entre streams: 8.3 (v3 7.9)
- Lore aprendido entre streams: 8.3 (v3 7.9)
- !dios_fua (Q&A + tool buscar_juego): 8.6 (v3 8.6)

## Cambios respecto a v3

- Subidas (16): Narrativa del stream (eventos) 6.6→7.7; Co-host espontáneo 6.6→7.3; Hechos por usuario (user_facts) 5.6→6.3; Tests (node:test, 219) 5.3→6.0; Hooks de silencio 5.4→6.1; Subs (sub, resub, gift, mystery, Prime, upgrade) 7.1→7.7; Respuesta natural (@dios_fua y patrones) 7.3→7.7; !quemeperdi 7.6→8.0; Memoria entre streams 7.9→8.3; Lore aprendido entre streams 7.9→8.3; !lore (ver / aprobar / borrar) 7.0→7.4; Ranking de trivia + !top + campeón en el contexto IA 6.7→7.1; !boss / !score 5.1→5.4; Personalidad / modos / tono 7.7→8.0; Raid + modo raid 6.4→6.7; Hitos de seguidores 4.8→5.1. Bajadas: ninguna. Nueva: Preguntas de trivia sobre el canal (7.7).
- Cerrados desde v3: lore, memoria entre streams sin tests (ya los tienen); narrativa solo en RAM y de 5 eventos (ahora 12 y persistida); recurring_joke sin uso (ya se usa en subs); modos poco perceptibles; cohost con disparo poco fiable; falsos disparos de la respuesta natural.
- Siguen abiertos: SIGTERM descarta la cola IRC (solo se registra), GROQ_MODEL_FALLBACKS sin documentar y sin tercer modelo, EventSub y despacho de comandos sin tests, flujos con E/S (handleCohost, checkPatternMatch) sin tests, !brb sin auto-apagado (no re-verificado), backup manual, detector de bots en dry-run (por diseño), sin comandos personalizados.
- Nuevos matices: la columna stream_sessions.narrative no tiene migración en el repo y, si falta, solo se avisa una vez en el log; cohost y modos son lógica nueva sin prueba en directo (no hay PRUEBAS_EN_DIRECTO.md); "nicknames" del lore está vacío, así que el apodo en subs aún no se usa.

## Lectura de las medias

Siguen la misma lógica que en v3: la ponderada y la del núcleo quedan por encima de la simple porque lo que más pesa en el directo (IA, lore, memoria, trivia, subs) está mejor construido que lo accesorio. Las debilidades del núcleo siguen siendo infraestructura de baja diferenciación (cola IRC, Infra Groq, filtro, IRC).

## Mejoras del núcleo con más impacto por esfuerzo

1. **Vaciar la cola IRC en SIGTERM** (esfuerzo bajo): cada deploy en Render descarta alertas y respuestas pendientes; es la peor del núcleo.
2. **Documentar GROQ_MODEL_FALLBACKS, añadir un tercer modelo y avisar a mods/en /status cuando se usa la reserva** (esfuerzo bajo): toda la IA depende de ello y hoy el único aviso es una línea de log.
3. **Tests del filtro anti-inyección con casos evasivos y de EventSub (HMAC, replay, dedupe)** (esfuerzo bajo-medio): son las dos piezas del núcleo de seguridad/continuidad sin red de pruebas suficiente; el filtro además tiene la lista de bloqueo evasible.

---

## Comparativa con otros bots (del análisis 2026-10-26)

Hecha de memoria sobre Nightbot, StreamElements, Fossabot y Streamer.bot, sin consultar sus docs actuales: verificar antes de usarla de cara al público. **Y** = ya lo tienen los otros · **D** = lo hace distinto/mejor · **X** = diferencial · **?** = dudoso.

| Área | Veredicto | Detalle |
|---|:-:|---|
| Comandos básicos (`!uptime`, `!estadisticas`, `!muertes`, `!boss`, `!brb`, `!silencio`, `!clip`, `!marker`, `!chiste`, `!comandos`, `!ayuda`) | Y | Los otros los traen y los hacen editables desde chat/panel; aquí la configuración es JSON y requiere redeploy. |
| `!lurk`, `!juego` (RAWG), `!so`, `!dios_fua` | D | Respuesta generada por IA / con datos extra, frente a plantillas. |
| Trivia por juego, dificultad adaptativa, ranking | X | No existe de serie en los otros. |
| Respuesta natural, cohost, hooks, comentario del juego, modos, warmup, resumen de fin de stream | X | Presencia proactiva y personalidad dinámica. |
| Memoria entre streams, hechos por usuario, conversación por usuario, narrativa, lore | X | Ningún competidor la trae de serie (`?` Streamer.bot con scripting propio). |
| Highlights, spam de emotes, caps rage | X | Los otros *moderan* emotes/caps; este los *narra*. |
| Subs, bits, follow, hitos, hype train | Y | Los otros tienen alertas; aquí con IA y contexto de usuario. |
| Raid, predicciones, encuestas, canjes, primer mensaje | D | Texto generado en lugar de plantilla. |
| Lurker que vuelve, logros por mensajes | ? | Equivalente a niveles de lealtad, sin puntos ni tienda. |
| Moderación | — | Solo el auto-ban de bots (en dry-run). Sin filtros de links/spam/palabras ni timeouts: los competidores van muy por delante. |

**No existe:** integración con Discord u OBS, overlays/alertas visuales, panel web, gestión de comandos desde el chat (`!addcom`), puntos de lealtad, sorteos, peticiones de canciones, citas, filtros de moderación, multicanal.

## Lo que de verdad es diferencial

La capa de comandos y alertas es la que ya tienen los demás. El valor está en la capa de contexto e IA, y en que está conectada entre sí:

1. **Memoria viva del canal**: sabe qué pasó en los últimos streams, quién es habitual y qué dijo cada usuario, y lo usa en cada respuesta.
2. **Narrador reactivo del chat**: detecta hype colectivo (palabras clave, emotes, caps), marca el VOD, lo narra y cambia su propia personalidad.
3. **Trivia por juego** con dificultad adaptativa, ranking y preguntas sobre el canal.
4. **Presencia proactiva**: habla cuando hay silencio, calienta al abrir, resume al cerrar.
5. **Personalidad con criterio**: no da la razón por sistema.

## Ideas de diferencial pendientes (del análisis)

- Clip automático en el highlight (`createClip()` ya existe): publicar el enlace con título IA.
- Capítulos de VOD / recap por stream (endpoint `/recap` o webhook de Discord al cerrar), reutilizando markers, sesión y resumen.
- Trivia: aceptar respuestas por letra/número de opción.
