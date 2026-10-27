# INVENTARIO_FUNCIONES — parlusorum-bot

_Auditoría de solo lectura del código actual (2026-10-27). Basada en lectura de index.js, src/** y config/**; no se ha ejecutado el bot ni se ha leído .env._

**Funcionalidades inventariadas:** 64 · **Nota media:** 5.7/10

**Criterios:** S = solidez (40 %), V = valor para streamer/comunidad (30 %), D = diferenciación frente a Nightbot, StreamElements, Fossabot y Streamer.bot (30 %). Final = 0,4·S + 0,3·V + 0,3·D. Lo que no tengo claro de la competencia va marcado "dudoso". La diferenciación asume los productos base (comandos, timers, filtros, puntos de lealtad, canciones), no sus integraciones de terceros.

## Comandos

| Funcionalidad | S | V | D | Final | Notas (solidez / competencia) |
|---|:-:|:-:|:-:|:-:|---|
| !lurk (despedida IA) | 8 | 5 | 6 | **6.5** | Fallback fijo si Groq falla. Nightbot/SE solo texto fijo. |
| !uptime | 8 | 4 | 2 | **5.0** | Estándar en todos los bots. |
| !juego (RAWG) | 8 | 5 | 5 | **6.2** | Género/año/nota RAWG; cache 24 h. Otros bots solo leen el juego de Twitch (dudoso). |
| !estadisticas | 7 | 4 | 3 | **4.9** | Viewers vía app token. Equivalente existe en otros bots. |
| !muertes (+1/reset) | 7 | 6 | 3 | **5.5** | Contador solo en RAM: se pierde al reiniciar y se pone a 0 en cada stream.online. Counters existen en Nightbot/SE. |
| !boss / !score | 6 | 5 | 4 | **5.1** | Racha de boss en RAM; total histórico en Supabase con lectura-modificación-escritura sin atomicidad; campo total_losses huérfano. |
| !brb | 7 | 5 | 3 | **5.2** | No se limpia al acabar el stream; recordatorio no pasa por truncate (texto fijo, sin riesgo). |
| !silencio | 5 | 6 | 3 | **4.7** | Solo silencia IA/hooks/trivia; NO silencia timers, follows, hype train, alertas de subs, raid, bienvenidas ni BRB (la doc dice "todos los automáticos"). |
| !so (shoutout IA) | 7 | 6 | 6 | **6.4** | Pide ultimo juego del target; manda un "Preparando shoutout…" extra innecesario. Twitch ya tiene /shoutout nativo. |
| !clip | 7 | 6 | 2 | **5.2** | Requiere scope; error claro. Común en Nightbot/SE. |
| !marker | 7 | 5 | 4 | **5.5** | Streamer.bot puede; Nightbot/SE no (dudoso). |
| !resumen | 5 | 3 | 3 | **3.8** | Muestra "uptime" de sesión del bot si no hay EventSub y msgs/h: casi duplicado de !estadisticas. |
| !comandos / !ayuda | 6 | 4 | 2 | **4.2** | Lista duplicada en 3 sitios (commands.json, helpTexts, handleAyuda) y textos desfasados (!uptime, "169 chistes"). |
| Comandos personalizados (config JSON) | 5 | 3 | 1 | **3.2** | Solo existe !comandos; añadir uno exige editar JSON y desplegar. Nightbot/SE/Fossabot los gestionan desde chat/panel. |

## IA

| Funcionalidad | S | V | D | Final | Notas (solidez / competencia) |
|---|:-:|:-:|:-:|:-:|---|
| !dios_fua (Q&A + tool buscar_juego) | 7 | 9 | 9 | **8.2** | Tool RAWG real, una sola ronda, sin búsqueda web. Límite por usuario nunca usa tipo "mod" (getUserType no lo devuelve), streamer limitado a 3 rpm. |
| Personalidad / modos / tono | 7 | 7 | 8 | **7.3** | Modos hype/focus/chill/victory, refuerzo cada 50 msgs, detección de tono y "trampa de confirmación". Prompt enorme en código (no en config). |
| Respuesta natural (@dios_fua y patrones) | 7 | 7 | 8 | **7.3** | Cooldowns separados; patrones amplios ("qué juego") pueden saltar sin que hablen al bot. |
| Co-host espontáneo | 6 | 6 | 8 | **6.6** | Probabilidad 25 %, anti-repetición por similitud de palabras; no truncate-safe en caso raro de texto largo (sí usa truncate). Riesgo de ser intrusivo. |
| Hooks de silencio | 6 | 5 | 5 | **5.4** | Mensajes genéricos fijos si falla IA; hook de raid con texto fijo sin truncate; mide viewers con app token. |
| Comentario IA del juego (25 min) | 6 | 5 | 6 | **5.7** | Sin datos acotados salvo RAWG genérico: puede inventar detalles; respeta silencio. |
| Detección de highlights + marker + narración | 6 | 8 | 8 | **7.2** | Umbral 4 msgs/15 s pero NO exige usuarios distintos (un usuario puede dispararlo) y keywords como "gg"/"fua"/"clip" dan falsos positivos; guarda en Supabase. |
| Detección de spam de emotes | 7 | 5 | 7 | **6.4** | 8 usuarios distintos/20 s; fallback BTTV/FFZ por regex (puede fallar con emotes de 3 letras). |
| Detección de CAPS rage | 6 | 4 | 7 | **5.7** | Solo comenta y activa modo hype; no modera. Umbral 5 usuarios. |
| !chiste (banco 168 chistes) | 8 | 4 | 3 | **5.3** | Estático, sin IA ni categorías; cooldown persistido. |
| Warmup al empezar el stream | 7 | 6 | 8 | **7.0** | Se dispara solo con <5 viewers a los 60 s; fallback fijo. |
| Inicio / fin de stream (+ resumen IA) | 7 | 6 | 6 | **6.4** | Inicio por sondeo cada 60 s con texto fijo; fin con resumen IA vía EventSub; dos vías con bandera para no duplicar. |
| Filtro anti-inyección / contenido | 6 | 6 | 5 | **5.7** | Lista de bloqueo: evasible (leet, espacios) y con falsos positivos ("simulate", "coger" aislado). Ayuda, pero no es una defensa robusta. |
| Infra Groq (retry, rate limit, reasoning) | 7 | 6 | 3 | **5.5** | Maneja 429/retry-after y gpt-oss; sin fallback de modelo cuando Groq lo retira (404), solo env var. |

## Memoria

| Funcionalidad | S | V | D | Final | Notas (solidez / competencia) |
|---|:-:|:-:|:-:|:-:|---|
| Memoria entre streams | 7 | 8 | 9 | **7.9** | 5 últimos resúmenes inyectados; ordena por stream_date (dos streams el mismo día quedan sin orden definido); fallback sin IA. |
| Hechos por usuario (user_facts) | 5 | 4 | 8 | **5.6** | recurring_joke se guarda pero se filtra al construir el prompt: dato muerto. Solo is_regular y último juego (caduca a 30 d). |
| Conversación por usuario | 7 | 6 | 7 | **6.7** | 5 turnos, TTL 1 h, máx 200 usuarios, solo RAM (se pierde al reiniciar). |
| Narrativa del stream (eventos) | 6 | 5 | 8 | **6.3** | Máx 5 eventos; "death" solo si un mod usa !muertes +1; "victory" solo por highlight. |
| Sesiones, highlights y métricas en Supabase | 6 | 5 | 4 | **5.1** | Se escriben pero no hay ningún comando/panel para consultarlos. |

## Moderación

| Funcionalidad | S | V | D | Final | Notas (solidez / competencia) |
|---|:-:|:-:|:-:|:-:|---|
| Detector de bots (twitchbots.info) | 6 | 6 | 5 | **5.7** | Lotes de 100, whitelist, caché; en dry-run por diseño: no banea nada aún. Nightbot/Fossabot no lo traen; Streamer.bot lo puede montar (dudoso). |

## Alertas

| Funcionalidad | S | V | D | Final | Notas (solidez / competencia) |
|---|:-:|:-:|:-:|:-:|---|
| Subs (sub, resub, gift, mystery, Prime, upgrade) | 8 | 7 | 6 | **7.1** | Dedupe de lotes por origin-id, cola descartable con resumen de desbordamiento, IA con fallback fijo. Overlay de SE lo cubre en pantalla, no en chat. |
| Bits | 7 | 4 | 2 | **4.6** | Tres textos fijos por tramo; sin IA ni acumulado. |
| Raid + modo raid | 7 | 6 | 6 | **6.4** | Mensaje fijo + IA con juego del raider; activa modo raid 5 min (hype, hook de bienvenida). |
| Nuevo seguidor (EventSub) | 7 | 5 | 3 | **5.2** | Mensajes fijos, no respeta !silencio, sin agrupar si llegan muchos seguidores seguidos (spam). |
| Hitos de seguidores | 6 | 4 | 4 | **4.8** | Sondeo cada 5 min; hitos fijos [50…1000] sin continuación más allá. |
| Bienvenida primer mensaje (IA) | 6 | 6 | 6 | **6.0** | Detecta "nuevo" comparando contra loadUsers() (select * sin paginar: Supabase corta en 1000 filas por defecto, riesgo de falsos "primer mensaje" al crecer la comunidad). |
| Regreso tras 7+ días | 6 | 4 | 5 | **5.1** | Depende de last_seen en el mismo store (mismo límite de 1000 filas). |
| Lurker que vuelve | 6 | 4 | 4 | **4.8** | Mapa en RAM, se limpia cada stream.online; la umbral configurable. |
| Logros por mensajes | 7 | 4 | 4 | **5.2** | 3 logros fijos (10/100/500). Equivalentes a "loyalty/rank" de SE (dudoso). |
| Aniversario de primer mensaje | 5 | 3 | 4 | **4.1** | Solo salta si el mismo día y mes coinciden y el usuario escribe ese día. |
| Hype train | 7 | 5 | 4 | **5.5** | Begin/end anunciados; progress solo a log; texto fijo. |
| Predicciones (IA) | 7 | 5 | 7 | **6.4** | begin/lock/end con IA y fallback fijo. Estado activo en RAM. |
| Encuestas (IA) | 7 | 4 | 7 | **6.1** | begin/end con IA y fallback; ganador por reduce simple. |
| Canjes de puntos (IA / pregunta al bot) | 6 | 6 | 7 | **6.3** | Pregunta al bot si el título contiene "bot/pregunta/dios" (frágil); user-id = nombre en el rate limit. |
| Timers (2 fijos + duración 40 min) | 7 | 5 | 2 | **4.9** | No comprueban !silencio ni actividad del chat (Nightbot exige mínimo de líneas); textos fijos en JSON. |

## Trivia

| Funcionalidad | S | V | D | Final | Notas (solidez / competencia) |
|---|:-:|:-:|:-:|:-:|---|
| Trivia dinámica (Groq + datos RAWG) | 7 | 7 | 8 | **7.3** | Solo genera con datos reales (RAWG detail); valida que la respuesta no esté en la pregunta; cae al banco estático. |
| Banco estático (30 preguntas) | 7 | 4 | 4 | **5.2** | Pocas preguntas, algunas con respuesta ambigua ("un grito", titulo largo TLOU). |
| Pistas + coincidencia difusa | 8 | 5 | 5 | **6.2** | Pistas calculadas en código (sin filtrar la respuesta), Levenshtein ≥0.85 solo en respuestas no numéricas. |
| Dificultad adaptativa | 6 | 4 | 8 | **6.0** | Racha ±3 en RAM; se reinicia cada stream. |

## Infraestructura

| Funcionalidad | S | V | D | Final | Notas (solidez / competencia) |
|---|:-:|:-:|:-:|:-:|---|
| Receptor EventSub (HMAC, anti-replay, dedupe) | 8 | 8 | 4 | **6.8** | HMAC timingSafeEqual, ventana 10 min, 204 inmediato, limpieza de subs stale. Limitación documentada: si falla el procesamiento Twitch no reintenta. |
| Gestión de tokens (bot + broadcaster, OAuth) | 8 | 8 | 4 | **6.8** | Refresco automático + persistencia Supabase; callback valida login y rate limit; tras reautorizar hay que reiniciar para re-registrar subs. |
| Conexión IRC (watchdog + backoff) | 8 | 8 | 2 | **6.2** | Guarda anti-doble socket, refresco de token en fallo de login. |
| Cola IRC anti-throttle | 7 | 7 | 2 | **5.5** | 18 msgs/30 s, 1,1 s, cola 50; SIGTERM descarta lo pendiente (pérdida de mensajes en deploy). |
| Cola de alertas (throttleSay) | 7 | 5 | 3 | **5.2** | Segunda cola encima de la IRC (1,6 s): doble throttling y estado duplicado. |
| Almacenamiento Supabase / npoint | 6 | 6 | 2 | **4.8** | Supabase con clave de servicio y RLS; users sin paginar; fallback npoint con un solo bin. |
| Cooldowns persistentes | 7 | 3 | 2 | **4.3** | Solo cubren !dios_fua, !chiste y !lurk. |
| /health, /status y self-ping | 7 | 6 | 1 | **4.9** | Mínimo, sin datos sensibles; el self-ping es un apaño del plan gratuito. |
| Logger con rotación | 7 | 4 | 1 | **4.3** | Rotación a 5 MB y redacción de secretos (según CLAUDE.md; logger.js no auditado línea a línea). |
| Métricas del bot | 5 | 3 | 2 | **3.5** | Contadores en RAM; !metricas fue eliminado, así que solo alimentan !resumen y la memoria. |
| Scripts (check-eventsub, get-bot-token) | 7 | 5 | 2 | **4.9** | No auditados línea a línea; se confía en su descripción en CLAUDE.md. |

## Funcionalidades con nota final < 6 — qué les falta (38)

- **Comandos personalizados (config JSON)** (3.2): Comandos editables en vivo por mods (!addcom/!editcom) persistidos en Supabase, con variables.
- **Métricas del bot** (3.5): Persistir y mostrar (panel / comando de mods).
- **!resumen** (3.8): Resumen real (muertes, bosses, trivia, pico, momentos destacados).
- **Aniversario de primer mensaje** (4.1): Comprobar a nivel de stream y no depender de que escriba ese día; bajo valor.
- **!comandos / !ayuda** (4.2): Generar lista y ayuda desde una única fuente.
- **Logger con rotación** (4.3): Niveles configurables y volcado de errores a un canal de aviso.
- **Cooldowns persistentes** (4.3): Cubrir cooldowns de comandos de config y limpiar filas caducadas en BD.
- **Bits** (4.6): Agradecimiento IA/acumulado del stream y meta de bits.
- **!silencio** (4.7): Comprobar isSilenced() en timers, EventSub, alertas y bienvenidas (o centralizarlo en el wrapper de say).
- **Almacenamiento Supabase / npoint** (4.8): Paginación o consultas por usuario; migración versionada del esquema.
- **Lurker que vuelve** (4.8): Persistir y distinguir !lurk explícito de silencio normal.
- **Hitos de seguidores** (4.8): Hitos dinámicos (cada N) y avisar vía el evento follow, sin sondeo.
- **Scripts (check-eventsub, get-bot-token)** (4.9): Integrarlos en un único comando de diagnóstico y documentar su uso.
- **/health, /status y self-ping** (4.9): Estado de Groq/Supabase/EventSub en /status y alerta si falla.
- **Timers (2 fijos + duración 40 min)** (4.9): Respetar silencio, exigir actividad mínima de chat y mover el texto de duración a messages.json.
- **!estadisticas** (4.9): Más datos propios (pico, mensajes, top chatter) para diferenciarse; solapa con !resumen.
- **!uptime** (5.0): Aporta poco: fusionar con !estadisticas o añadir "último directo" cuando está offline.
- **Regreso tras 7+ días** (5.1): Paginar/consultar por usuario en lugar de cargar la tabla entera.
- **Sesiones, highlights y métricas en Supabase** (5.1): Exponer lectura (comando o página) y estadísticas históricas.
- **!boss / !score** (5.1): Incremento atómico, sin campos huérfanos, y !score por juego.
- **Cola de alertas (throttleSay)** (5.2): Unificar con irc-ratelimit y dejar un único mecanismo de prioridad/descarte.
- **Banco estático (30 preguntas)** (5.2): Ampliar y verificar el banco, por categorías/dificultad.
- **Logros por mensajes** (5.2): Más logros (rachas, subs, trivia) y comando !logros.
- **Nuevo seguidor (EventSub)** (5.2): Agrupar ráfagas, respetar !silencio y usar IA.
- **!clip** (5.2): Devolver título/duración y usar el clip para el resumen de fin de stream.
- **!brb** (5.2): Auto-apagado en stream.offline y mensaje configurable en messages.json.
- **!chiste (banco 168 chistes)** (5.3): Chistes generados/contextuales al juego o al chat, con deduplicación histórica.
- **Hooks de silencio** (5.4): Más variedad/IA contextual y desactivar si el streamer está en BRB.
- **Cola IRC anti-throttle** (5.5): Vaciar cola (o priorizar) antes de salir; prioridades por tipo.
- **Hype train** (5.5): Anunciar hitos de nivel y resumen IA al terminar.
- **Infra Groq (retry, rate limit, reasoning)** (5.5): Cadena de modelos de reserva automática ante 404 model_not_found.
- **!marker** (5.5): Que el marcador se guarde también en stream_highlights.
- **!muertes (+1/reset)** (5.5): Persistir el contador (Supabase) y permitir -1 / valor por juego.
- **Hechos por usuario (user_facts)** (5.6): Hechos útiles (apodo, juegos favoritos, ya saludado) y que lo guardado realmente se use.
- **Detector de bots (twitchbots.info)** (5.7): Revisar logs dry-run, apagar dry-run y añadir ban reversible/aviso al mod.
- **Filtro anti-inyección / contenido** (5.7): Defensa en capas: delimitar entrada de usuario en el prompt, filtrar salida, y reducir falsos positivos.
- **Detección de CAPS rage** (5.7): Decidir si es solo humor (valor bajo) o enlazarlo a moderación real.
- **Comentario IA del juego (25 min)** (5.7): Anclar el comentario a datos reales (RAWG detail / narrativa del stream) y variar el tipo.

## Resumen

- Mejor puntuadas: !dios_fua (Q&A + tool buscar_juego) (8.2); Memoria entre streams (7.9); Personalidad / modos / tono (7.3).
- Peor puntuadas: Comandos personalizados (config JSON) (3.2); Métricas del bot (3.5); !resumen (3.8).

## Huecos detectados (no puntuados)

- Trivia sin ranking/puntos persistentes: el ganador se olvida.
- Sin moderación de chat (links, spam, caps): solo el detector de bots, y en dry-run.
- Sin canciones, sorteos ni puntos de lealtad propios (sí en StreamElements; Nightbot tiene canciones).
- Riesgos latentes: users sin paginar (límite 1000 filas), SIGTERM descarta la cola IRC, !silencio incompleto.
