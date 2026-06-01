# Parlusorum Code Review

Code review especializado para el bot de Twitch **parlusorum**. Antes de revisar, lee los archivos relevantes del cambio. Aplica los criterios en orden de severidad.

## Severidades

- 🔴 **CRÍTICO** — puede tirar el bot o banearlo de Twitch
- 🟡 **IMPORTANTE** — degradación de calidad o seguridad
- 🟢 **MEJORA** — deuda técnica o consistencia

---

## 1. TWITCH IRC — CRÍTICO

**Rate limit IRC**: 20 mensajes/30 s para cuentas normales, 100/30 s si el bot es mod.  
Superar el límite causa baneo silencioso de 30 minutos.

Verificar:
- Todos los `client.say()` pasan por un contador global de mensajes enviados (ver `src/utils/ratelimit.js` o equivalente).
- No hay rutas de código que puedan llamar `client.say()` en bucle sin throttling (p. ej. respuestas a eventos de chat de alta frecuencia).
- Los handlers de EventSub que disparan `client.say()` también están contados.
- Si se añade un nuevo punto de salida de mensajes, debe integrarse con el contador antes de hacer merge.

**Mensajes duplicados**: Twitch dropea silenciosamente mensajes idénticos enviados en menos de 30 s desde la misma cuenta. Si una respuesta repetida no aparece en el chat, esta es la causa.

Verificar:
- Respuestas que pueden repetirse (timers, alertas) añaden variación o un sufijo de tiempo para evitar deduplicación por Twitch.

---

## 2. SEGURIDAD LLM

**Sanitización de input**: Todo texto proveniente del chat debe pasar por `sanitizeForAI()` (en `src/utils/filter.js`) antes de llegar a Groq. Sin esto, usuarios pueden inyectar instrucciones al LLM.

Verificar:
- Cada llamada a Groq que incluye contenido del usuario usa `sanitizeForAI(userMessage)`.
- El `content` del rol `user` en el array de mensajes nunca es `message` crudo sin filtrar.

**Prompt injection**: El system prompt define la personalidad y restricciones del bot. No debe ser modificable ni revelable desde el chat.

Verificar:
- El system prompt está en el código fuente o en `config/`, nunca construido con interpolación de variables controladas por el usuario.
- No hay comandos que lean o expongan el system prompt a la respuesta del chat.
- El contenido del chat nunca se concatena directamente al system prompt.

**Llama Prompt Guard 2**: Groq ofrece `llama-guard-3-8b` como modelo de guardia para clasificar inputs de alto riesgo. Para flujos donde el bot ejecuta acciones (crear clip, crear marker, cambiar estado), evaluar si el input debe pasar primero por el modelo guardia antes de la llamada principal.

**Truncado de respuestas**: Los mensajes de Twitch tienen límite de 500 caracteres. Las respuestas de Groq no deben postearse sin truncado.

Verificar:
- Toda respuesta de Groq pasa por `truncate()` o equivalente antes de `client.say()`.
- El truncado no corta en medio de una secuencia de escape o emoji.

---

## 3. MEMORY LEAKS (proceso 24/7)

El bot corre indefinidamente. Maps y closures que acumulan datos sin límite terminan en OOM.

**Maps de usuarios**: Todo `Map` indexado por username, userId o messageId debe tener limpieza periódica.

Verificar:
- Existe un `setInterval` que hace `.clear()` o elimina entradas antiguas.
- El `intervalId` devuelto por `setInterval` se guarda en una variable para poder hacer `clearInterval` en cleanup o tests.
- El intervalo de limpieza es proporcional al TTL esperado de los datos (p. ej. cooldowns de 30 s → limpiar cada 60 s).

**Closures en timers**: Closures dentro de `setTimeout`/`setInterval` no deben capturar referencias a objetos grandes (arrays de historial, buffers de mensajes).

Verificar:
- Los handlers de timer solo capturan primitivos o referencias mínimas necesarias.
- Si capturan un array/objeto, éste tiene tamaño acotado.

**Event listeners**: Listeners añadidos con `client.on()` u otros emitters deben tener su `removeListener` o `off()` cuando el componente se destruye.

Verificar:
- Handlers de eventos registrados en `connected` no se registran otra vez en reconexiones sin limpiar los anteriores.
- La lógica del flag `timersStarted` (en `index.js`) evita registrar timers duplicados.

---

## 4. NODE.JS PRODUCCIÓN

**CVE-2025-59465**: Node.js 22+ tiene vulnerabilidades conocidas en el stack HTTP/2. Verificar la versión exacta en Railway (`process.version` o `engines` en `package.json`) y si aplica el CVE al modo de uso del bot (HTTP/1.1 para EventSub webhook es menos afectado que HTTP/2 puro).

**Async handlers sin try/catch**: En `EventEmitter`, una excepción lanzada dentro de un handler `async` no se propaga como `unhandledRejection` en todas las versiones de Node — puede silenciarse.

Verificar:
- Todo `client.on('message', async (...) => { ... })` tiene `try/catch` envolviendo el cuerpo.
- Todo handler de EventSub (`eventsub.js`) tiene `try/catch` en el procesamiento del body.
- No hay `await` sueltos sin captura de errores en handlers de eventos.

**Variables globales mutables**: El estado compartido entre streams (`isLive`, `triviaActive`, `silenceMode`, etc.) vive en `src/utils/state.js`. Son un riesgo si dos eventos concurrentes lo modifican.

Verificar:
- Nuevas features no añaden variables globales mutables fuera de `state.js`.
- Si se añade estado nuevo a `state.js`, documentar en comentario si es seguro para acceso concurrente.
- Al inicio de cada stream (evento `stream.online`), el estado se resetea explícitamente a valores conocidos.

---

## 5. GROQ / TOKENS

**Rate limiting propio**: El bot tiene `canMakeRequest()` en `src/utils/ratelimit.js` para no exceder el límite de Groq.

Verificar:
- Toda llamada a la API de Groq está precedida por `if (!canMakeRequest()) return`.
- No hay rutas que llamen a Groq directamente sin pasar por el rate limiter.

**Retry con backoff**: `groqWithRetry()` ya lee `err.headers?.['retry-after']` y usa backoff exponencial con jitter si el header no está. Al añadir un nuevo caller de Groq, verificar que usa `groqWithRetry()` y no `groq.chat.completions.create()` directamente.

**Estimación de llamadas por hora**: Con todos los sistemas activos simultáneamente, estimar el peor caso:

| Sistema | Frecuencia máxima |
|---------|-------------------|
| Pattern matcher | 1 llamada por mensaje relevante |
| Emote spam detector | 1 llamada por spike de emote |
| Caps rage detector | 1 llamada por spike de caps |
| Timer AI (game commentary) | 1 cada 25 min |
| Cohost | 1 por trigger |
| `!dios_fua` / `!chiste` | A demanda |

Si el total proyectado supera el tier de Groq, señalarlo como 🔴.

---

## 6. CONSISTENCIA DEL PROYECTO

**Cooldowns**: Usar `Date.now()` (ms desde epoch). No usar `performance.now()` (ms desde inicio del proceso) porque no es comparable entre reinicios.

**Logging**: Usar `logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug()` de `src/utils/logger.js`. Nunca `console.log()` en código de producción.

**Firma de handlers**: Los handlers nuevos deben seguir `handle(client, channel, tags, message)` para ser intercambiables y testables.

**Strings hardcodeados**: Los mensajes de respuesta al chat en español deben ir en `config/commands.json` u otro archivo de `config/`, no inline en el código. Excepción: mensajes de error internos o logs que nunca llegan al chat.

---

## Flujo de revisión

1. Leer los archivos modificados en el diff.
2. Para cada archivo, aplicar los criterios relevantes según el área (IRC, LLM, memory, Node.js, Groq, consistencia).
3. Reportar hallazgos agrupados por severidad (🔴 primero).
4. Para cada hallazgo: archivo, línea aproximada, descripción del problema, y sugerencia concreta de fix.
5. Si no hay hallazgos en una categoría, omitirla del reporte (no listar "sin problemas encontrados" por cada sección).
