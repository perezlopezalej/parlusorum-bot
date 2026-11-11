# INVENTARIO_FUNCIONES v5 — parlusorum-bot

_Auditoría de solo lectura, 2026-10-31, rama `fix/cohost-mas-vivo`. Basada en el código y en los chatlogs `logs/chat-2026-10-28/29/30.txt`. No se ha ejecutado el bot ni se ha leído `.env`. Solo se ejecutó `npm test` (383 pasan, 0 fallan)._

## Aviso importante sobre la base de comparación

**No existe `INVENTARIO_FUNCIONES_v4.md` en el disco** (ni v2/v3; estaban ignorados por git y ya no están). La única versión recuperable es la primera, en git (`3991c4e`, 2026-10-27, 5.7/10). Por eso la columna "v1" de este informe sale de ese documento y **no son notas de v4**. Si tienes el v4 en otro sitio, hay que repetir la comparación contra él. Esta versión se evalúa además con los cambios hechos del 27 al 30 de octubre (2.756 líneas añadidas en 31 ficheros de `src/`, `config/` e `index.js`).

## Criterios y pesos

S = solidez (40 %), V = valor (30 %), D = diferenciación frente a Nightbot, StreamElements, Fossabot y Streamer.bot (30 %). Final = 0,4·S + 0,3·V + 0,3·D.
Pesos de importancia: **núcleo x3** (de lo que depende el carácter del bot o su funcionamiento), **importante x2**, **básico x1**. La clasificación de v1 no la traía, así que la he fijado yo y se aplica por igual a las dos columnas. Las "nuevas" no tienen nota de v1.

## Resultado

| | v1 (64 funcs.) | Ahora, mismas 64 | Ahora, 74 (con las 10 nuevas) |
|---|:-:|:-:|:-:|
| Media simple | 5.7 | 5.8 | **5.9** |
| Media ponderada (x3/x2/x1) | 6.0 | 6.2 | **6.2** |
| Media del núcleo (12 funcs. x3; 11 en v1) | 7.0 | 7.2 | **7.2** |

De las 64 comparables: 24 suben, 5 bajan, 35 igual. Bajan: co-host libre, comentario IA del juego (`timer_ia`), conversación por usuario, personalidad y respuesta natural (por lo que muestran los chatlogs, no por el código).

**Lectura**: el bot es más sólido (silencio completo, cola que se vacía, validación, tests, memoria persistente), pero la nota apenas se mueve porque lo que más pesa en cómo se vive en directo (co-host, menciones, comentarios automáticos) sigue siendo lo más flojo.

## Evidencia de los chatlogs

| Stream | Respuestas del bot | Observación |
|---|---|---|
| 28-oct (17:23-23:38) | 47 co-host, 36 timers, 27 menciones, 13 `timer_ia`, 9 trivia | Mucho ruido automático |
| 29-oct (15:19-23:30) | 30 co-host, 52 timers, 20 `timer_ia`, 13 menciones | Invenciones del juego ("Hard/Extreme", combos); predicción narrada dos veces |
| 30-oct (19:28-00:51) | 3 co-host, 13 timers, 3 `timer_ia`, 12 menciones | Mucho más callado; casi todo es comando o alerta |

Qué funcionó: `!tiempo`, `!brb`, `!muertes`, `!boss`, `!chiste` (la streamer se rió), lurker que vuelve, "ha vuelto después de 35 días", logro "Habladín", profecía de inicio y de cierre, resumen final en positivo con cifras correctas.
Qué falló: co-host con frases sin sentido ("sueco de la diversión", "Gangar está en gargarchao"; el chat: "Que dice este ahora...?"), respuestas vacías a ~20 menciones seguidas de espectador1 ("una buena cola siempre ayuda", "potaje"), `timer_ia` con invenciones residuales, ningún comentario de racha con 13 muertes por `!muertes +N`, y `!muertes + 3` con espacio solo devuelve el uso.
Límite: son 3 streams, el del 30-oct con un chat dominado por una sola persona (191 de ~400 mensajes), y se desconoce si el commit 4055da1 estaba desplegado en ese directo.

## Tablas por funcionalidad

### Comandos

| Funcionalidad | Peso | v1 | Ahora | S | V | D | Evidencia / cambio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| !lurk (despedida IA) | x1 | 6.5 | **= 6.5** | 8 | 5 | 6 | Sin cambios. |
| !uptime | x1 | 5.0 | **= 5.0** | 8 | 4 | 2 | Sin cambios. |
| !juego (RAWG) | x1 | 6.2 | **= 6.2** | 8 | 5 | 5 | Sin cambios; ahora con `game-match` para no aceptar juegos que no se parecen. |
| !estadisticas | x1 | 4.9 | **▲ 5.5** | 7 | 5 | 4 | `stats.js` nuevo con más datos propios. |
| !muertes (+N, reset, por juego) | x3 | 5.5 | **▲ 6.8** | 8 | 7 | 5 | Persistido, `+N`, total por juego. Chat 30-oct: `!muertes + 3` con espacio devuelve el uso (2 intentos fallidos de la streamer); el contador funcionó hasta la #13. |
| !boss / !score | x2 | 5.1 | **= 5.1** | 6 | 5 | 4 | Funciona en directo (4 bosses el 30-oct). Sin cambios en atomicidad. |
| !brb | x1 | 5.2 | **▲ 5.9** | 8 | 5 | 4 | Recordatorios a 5 y 10 min y "ha vuelto" funcionaron el 30-oct. |
| !silencio | x2 | 4.7 | **▲ 5.9** | 8 | 6 | 3 | Ahora lo comprueban timers, EventSub, alertas e IA (30 usos de `isSilenced`). |
| !so (shoutout IA) | x1 | 6.4 | **= 6.4** | 7 | 6 | 6 | Sin cambios. |
| !clip | x1 | 5.2 | **= 5.2** | 7 | 6 | 2 | Sin cambios. |
| !marker | x1 | 5.5 | **= 5.5** | 7 | 5 | 4 | Sin cambios. |
| !resumen | x1 | 3.8 | **= 3.8** | 5 | 3 | 3 | Sin cambios. |
| !comandos / !ayuda | x1 | 4.2 | **▲ 5.0** | 8 | 4 | 2 | Una sola fuente (`config/help.json`). |
| Comandos personalizados (config JSON) | x1 | 3.2 | **= 3.2** | 5 | 3 | 1 | Sin cambios; `commands.json` solo tiene timers. |
| !tiempo | x1 | — | **5.8 (nueva)** | 7 | 5 | 5 | Nueva. Funcionó ("te tengo fichado desde hace 5 meses y 25 días"). Cuenta desde el primer mensaje registrado, no desde el follow. |

### IA

| Funcionalidad | Peso | v1 | Ahora | S | V | D | Evidencia / cambio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| !dios_fua (Q&A + buscar_juego) | x3 | 8.2 | **▲ 8.6** | 8 | 9 | 9 | Solo datos de RAWG, descarta resultados dudosos. Sigue siendo lo mejor. Tono a veces verboso. |
| Personalidad / modos / tono | x3 | 7.3 | **▼ 7.0** | 7 | 7 | 7 | Voz de España y sin género para ParLusorum. En chat: muletilla "FUA" repetida; el 29-oct llamó "tía" a ParLusorum (corregido después). |
| Respuesta natural (@dios_fua / menciones) | x3 | 7.3 | **▼ 7.0** | 7 | 7 | 7 | Redirige preguntas del juego a `!dios_fua`. El 30-oct espectador1 le habló ~20 veces en 5 min: contestó a casi todas, varias sin sentido ("una buena cola siempre ayuda", "potaje"). |
| Co-host espontáneo (libre por reloj) | x3 | 6.6 | **▼ 5.9** | 5 | 5 | 8 | Baja. 47 (28-oct), 30 (29-oct) y 3 (30-oct) comentarios. Varios sin sentido ("sueco de la diversión", "Gangar está en gargarchao") y el chat lo notó: "Que dice este ahora...?". |
| Co-host por eventos (muerte, boss, racha, sub, raid) | x2 | — | **6.2 (nueva)** | 5 | 6 | 8 | Nueva. El 30-oct solo se vio 1 (boss). Con 13 muertes y `!muertes +N` no hubo comentario de racha ni récord; puede que el commit 4055da1 no estuviera desplegado. |
| Hooks de silencio | x2 | 5.4 | **= 5.4** | 6 | 5 | 5 | Voz de Dios Fua y datos reales (RAWG). "Cuantas muertes creeis que habra hoy?" encaja. |
| Comentario IA del juego (timer_ia) | x2 | 5.7 | **▼ 4.7** | 5 | 4 | 5 | Antes 20 por stream, ahora 3, validado. Siguen colándose invenciones ("energía de Ragnarok y sekiro") y la fórmula "Phantom Blade Zero ... FUA". |
| Detección de highlights + marker | x2 | 7.2 | **= 7.2** | 6 | 8 | 8 | Sin cambios ni evidencia en los chatlogs. |
| Spam de emotes | x1 | 6.4 | **= 6.4** | 7 | 5 | 7 | Sin cambios. |
| CAPS rage | x1 | 5.7 | **= 5.7** | 6 | 4 | 7 | Sin cambios. |
| !chiste (banco) | x1 | 5.3 | **= 5.3** | 8 | 4 | 3 | Funciona; la streamer se rió (`!chiste` el 30-oct). |
| Warmup al empezar | x2 | 7.0 | **= 7.0** | 7 | 6 | 8 | Pregunta de arranque razonable ("Qué arma ...?"). |
| Inicio / fin de stream + resumen IA | x3 | 6.4 | **▲ 7.4** | 8 | 7 | 7 | Resumen final en positivo y con cifras correctas (5 h 23, 13 muertes, 4 jefes). El aviso de inicio es texto fijo. |
| Filtro anti-inyección / contenido | x2 | 5.7 | **▲ 6.1** | 7 | 6 | 5 | Más tests; sigue siendo lista de bloqueo. |
| Infra Groq (retry, rate limit, reserva de modelos) | x2 | 5.5 | **▲ 5.9** | 8 | 6 | 3 | Cadena `GROQ_MODEL_FALLBACKS` y contadores de 429/reserva. En `bot.log` aparece el aviso de modelo retirado (404) y el cambio. |
| Validación de respuestas (`quality.js`) | x3 | — | **7.0 (nueva)** | 7 | 7 | 7 | Nueva. Frena muertes que no cuadran, nombres, emotes, género. No impide del todo frases sin sentido (ver cohost). |
| Factcheck SÍ/NO selectivo (`factcheck.js`) | x2 | — | **6.3 (nueva)** | 6 | 6 | 7 | Nuevo. Descarta lo que afirma del juego sin respaldo; si falla, calla. Cupo propio. |
| Profecía de muertes | x2 | — | **7.3 (nueva)** | 7 | 7 | 8 | Nueva. Usa media histórica y "hoy". El 30-oct: "caerá 12 veces, superando sus 8 y 15 anteriores" y el cierre "12 profecías y 13 carnicerías" encajó. |
| !quemeperdi | x1 | — | **6.9 (nueva)** | 6 | 7 | 8 | Nuevo. Cifras de tiempo y muertes bien; mete invenciones ("ha derribado 11 enemigos"). |

### Memoria

| Funcionalidad | Peso | v1 | Ahora | S | V | D | Evidencia / cambio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Memoria entre streams | x3 | 7.9 | **▲ 8.3** | 8 | 8 | 9 | Alimenta resumen, profecía y lore aprendido. |
| Lore manual + aprendido, `!lore` | x2 | — | **7.3 (nueva)** | 7 | 7 | 8 | Nueva. Sabe que el canal es de Manu y Pao y que vlxj97 es el creador del bot. |
| Hechos por usuario (user_facts) | x2 | 5.6 | **▲ 6.3** | 6 | 5 | 8 | `recurring_joke` y contadores ya se usan (sub-context). El chat no muestra bromas propias de un usuario recordadas. |
| Conversación por usuario | x2 | 6.7 | **▼ 6.0** | 6 | 6 | 6 | En el chat de espectador1 no se aprecia hilo: "Qué decepción dios fua" -> "la jugada no fue lo que esperabas". |
| Narrativa del stream (eventos) | x2 | 6.3 | **▲ 7.0** | 7 | 6 | 8 | `narrative.js` nuevo; las muertes por `+N` cuentan. |
| Sesiones, highlights y métricas en Supabase | x1 | 5.1 | **▲ 5.4** | 6 | 6 | 4 | Ahora hay `!muertes <juego>` y `!tiempo` que las leen. |
| Registro del chat (`chat_log`, origen del bot) | x2 | — | **6.2 (nueva)** | 8 | 5 | 5 | Nuevo. Es lo que permite esta auditoría. |

### Moderación

| Funcionalidad | Peso | v1 | Ahora | S | V | D | Evidencia / cambio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Detector de bots (twitchbots.info) | x2 | 5.7 | **= 5.7** | 6 | 6 | 5 | Sigue en dry-run a propósito. |

### Alertas

| Funcionalidad | Peso | v1 | Ahora | S | V | D | Evidencia / cambio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Subs | x3 | 7.1 | **▲ 7.4** | 8 | 7 | 7 | Contexto de usuario (`sub-context`). Sin subs en los chatlogs. |
| Bits | x1 | 4.6 | **= 4.6** | 7 | 4 | 2 | Sin cambios. |
| Raid + modo raid | x2 | 6.4 | **= 6.4** | 7 | 6 | 6 | Sin cambios. |
| Nuevo seguidor | x1 | 5.2 | **= 5.2** | 7 | 5 | 3 | Respeta `!silencio`; sigue sin agrupar ráfagas. |
| Hitos de seguidores | x1 | 4.8 | **= 4.8** | 6 | 4 | 4 | Sin cambios. |
| Bienvenida primer mensaje | x2 | 6.0 | **= 6.0** | 6 | 6 | 6 | Sin cambios. |
| Regreso tras 7+ días | x1 | 5.1 | **▲ 5.4** | 6 | 5 | 5 | Funcionó: "ha vuelto despues de 35 dias". |
| Lurker que vuelve | x1 | 4.8 | **▲ 5.4** | 6 | 5 | 5 | Funciona y salta a menudo (3 veces el 29-oct, 2 el 30-oct), con la misma plantilla. |
| Logros por mensajes | x1 | 5.2 | **= 5.2** | 7 | 4 | 4 | Funcionó ("Habladín", 100 mensajes). |
| Aniversario de primer mensaje | x1 | 4.1 | **= 4.1** | 5 | 3 | 4 | Sin cambios. |
| Hype train | x1 | 5.5 | **= 5.5** | 7 | 5 | 4 | Sin cambios. |
| Predicciones (IA) | x2 | 6.4 | **▲ 6.7** | 7 | 6 | 7 | Una sola narración por evento (el 29-oct había duplicados). |
| Encuestas (IA) | x2 | 6.1 | **▲ 6.4** | 7 | 5 | 7 | Igual, sin duplicados. |
| Canjes de puntos | x1 | 6.3 | **= 6.3** | 6 | 6 | 7 | Sin cambios. |
| Timers (fijos + duración) | x2 | 4.9 | **▲ 5.2** | 7 | 5 | 3 | De 52 mensajes por stream (29-oct) a 13 en 5 h (30-oct); siguen siendo texto fijo ("Cómo lo estáis pasando?"). |

### Trivia

| Funcionalidad | Peso | v1 | Ahora | S | V | D | Evidencia / cambio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Trivia dinámica (Groq + RAWG + preguntas del canal) | x3 | 7.3 | **▲ 7.7** | 8 | 7 | 8 | Preguntas del canal (`channel-questions`). El 30-oct nadie lanzó `!trivia` pese al hook. |
| Banco estático | x1 | 5.2 | **= 5.2** | 7 | 4 | 4 | Sin cambios. |
| Pistas + coincidencia difusa | x1 | 6.2 | **= 6.2** | 8 | 5 | 5 | Sin cambios. |
| Dificultad adaptativa | x1 | 6.0 | **= 6.0** | 6 | 4 | 8 | Sin cambios. |
| Ranking `!top` / trivia_wins | x1 | — | **6.4 (nueva)** | 7 | 6 | 6 | Nuevo (resuelve el hueco "el ganador se olvida"). |

### Infra

| Funcionalidad | Peso | v1 | Ahora | S | V | D | Evidencia / cambio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Receptor EventSub | x3 | 6.8 | **= 6.8** | 8 | 8 | 4 | 12 suscripciones, una por tipo; dedupe por tipo+id. |
| Gestión de tokens (OAuth) | x2 | 6.8 | **= 6.8** | 8 | 8 | 4 | Sin cambios. |
| Conexión IRC (watchdog) | x3 | 6.2 | **= 6.2** | 8 | 8 | 2 | Sin cambios. |
| Cola IRC anti-throttle | x2 | 5.5 | **▲ 5.9** | 8 | 7 | 2 | Ahora vacía la cola en SIGTERM (máx. 5 s). |
| Cola de alertas (throttleSay) | x1 | 5.2 | **= 5.2** | 7 | 5 | 3 | Sin cambios. |
| Almacenamiento Supabase / npoint | x2 | 4.8 | **▲ 5.5** | 7 | 6 | 3 | Migraciones 000-004 y esquema base. El `bot.log` local usa npoint (fallback). |
| Cooldowns persistentes | x1 | 4.3 | **= 4.3** | 7 | 3 | 2 | Sin cambios. |
| /health y self-ping | x1 | 4.9 | **= 4.9** | 7 | 6 | 1 | Sin cambios. |
| Logger con rotación | x1 | 4.3 | **= 4.3** | 7 | 4 | 1 | Sin cambios. |
| Métricas / contadores de descartes | x1 | 3.5 | **▲ 4.2** | 6 | 4 | 2 | Contadores de cohost, descartes y 429 en el resumen de fin de stream del log. |
| Scripts (check-eventsub, backup, chatlog, bot-token) | x1 | 4.9 | **▲ 5.2** | 7 | 6 | 2 | `backup` y `chatlog` nuevos. |
| CI y tests (383, GitHub Actions) | x1 | — | **5.3 (nueva)** | 8 | 5 | 2 | Nuevo. `npm test`: 383 pasan, 0 fallan. |

## Vida del bot

Nota del 1 al 10 con evidencia de los chatlogs (28, 29 y 30 de octubre). **Nota media: 4.8/10.**

| Aspecto | Nota | Evidencia | Qué le falta |
|---|:-:|---|---|
| Reacciona al momento | 5 | Alerta de lurker que vuelve, "sale de las sombras", boss comentado el 30-oct. Pero con 13 muertes en el 30-oct solo habló en las del comando `!muertes`, sin comentario propio; el co-host libre dijo cosas fuera de lugar ("vendris sueco"). | Comentar picos reales (rachas, muertes seguidas) y callar cuando no entiende el chat. |
| Carácter y opinión | 5 | Voz de Dios Fua reconocible (FUA, "Respira, que es un directo"). Pero la muletilla "FUA" aparece en casi todo y las reglas anti-invención le quitan opinión sobre el juego. | Opiniones claras sobre lo que sí ve (muertes, chat, ritmo), con menos muletilla. |
| Chistes internos y continuidad | 4 | Acertó con "Recalculo en marcha" al chiste del retraso de espectador1 y la profecía cita las muertes de streams anteriores (8 y 15). No retoma bromas del canal (el retraso de Manu) ni las repite en otro stream. | Guardar y reutilizar bromas del chat entre streams (`recurring_joke` existe pero casi no se ve). |
| Trato personal a cada usuario | 5 | `!tiempo` con meses y días, "ha vuelto después de 35 días", saludo al volver del modo fantasma. Pero a espectador1 le respondió igual que a cualquiera ("Anda, desahógate") y el 29-oct trató a ParLusorum de "tía". | Usar lo que sabe de cada persona (juego favorito, apodo, cómo habla) al responder, no solo en alertas. |
| Seguirle el juego al chat | 4 | espectador1 le habló ~20 veces en 5 min: contestó a casi todo, sin hilo y con frases que no vienen al caso ("potaje", "una buena cola"). No distinguió cuándo era broma ("Qué decepción dios fua") ni cuándo callar. | Memoria corta de la conversación en curso y capacidad de seguir un juego (retruécano, ironía) en vez de responder cada mensaje por separado. |
| Rituales del canal | 6 | Predicción de muertes al inicio y cierre, "Llevamos Xm de stream", recordatorio de follow, aviso de fin con cifras, `!brb` con recordatorios, `!muertes`/`!boss`. | Rituales que cambien (no el mismo texto cada 20 min) y alguno propio del chat, como un cierre fijo. |
| Sorpresa y variedad | 4 | Los 13 timers del 30-oct son 3 textos fijos; el `timer_ia` repite "Phantom Blade Zero ... FUA"; el lurker usa siempre la misma plantilla. Lo que sorprendió fue la profecía de cierre ("12 profecías y 13 carnicerías"). | Plantillas rotativas, comentarios que dependan de lo que acaba de pasar y alguna sorpresa ocasional (premio, rareza, cambio de rol). |
| Capacidad de aprender de cada stream | 5 | Resumen a Supabase, lore aprendido, media de muertes por juego, `!tiempo`. No aprende de cómo reacciona el chat (está en "Ideas futuras" de PROGRESS.md) ni se ve que cambie de comportamiento tras un mal comentario. | Medir la respuesta del chat a cada intervención (risas, silencio, "qué dice este") y ajustar frecuencia y tono. |

**Los tres más flojos**: seguirle el juego al chat (4), sorpresa y variedad (4), chistes internos y continuidad (4).

## Mejoras con más impacto (por orden)

1. **Callar antes que decir tonterías en co-host y menciones**: descartar el comentario si no cita algo del chat (palabra o usuario real) y limitar a una respuesta por usuario cada X segundos. Ataca "seguirle el juego" y "reacciona al momento".
2. **Aprender de la reacción del chat** (mensajes en los 30-60 s siguientes a cada intervención): si el chat se ríe, repetir ese tipo; si pregunta "qué dice este", bajar la frecuencia. Es lo más barato que ya se puede medir con `chat_log`.
3. **Bromas internas persistentes y variedad**: guardar frases/bromas recurrentes del canal (el retraso de Manu) y reutilizarlas en menciones, timers y cierre; rotar plantillas de timers y lurker.

Para confirmar el efecto de 1 y 2 hace falta otro directo con el cohost activo: los cambios del 30-oct no se pudieron ver (3 comentarios en 5 h).

## Huecos y riesgos que siguen abiertos

- `!muertes + N` (con espacio) solo muestra el uso; la propia streamer se equivocó 2 veces el 30-oct.
- Posible fallo de despliegue: hay cambios sin commitear en `src/ai/handler.js`, `factcheck.js`, `quality.js`, `eventsub.js`, `state.js` y `test/cohost-vivo.test.js`; si no están en Render, el directo no los ejercita.
- Sigue sin haber moderación de enlaces/spam y el detector de bots está en dry-run (a propósito).
- `bot.log` local usa npoint como almacenamiento (fallback), no Supabase: el comportamiento en local no es el de producción.
