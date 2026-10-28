# Parlusorum Bot

Chatbot de Twitch con IA para el canal "parlusorum": responde preguntas, recuerda lo ocurrido en streams anteriores y reacciona en directo a las alertas y al ambiente del chat.

## Demo

[GIF/VÍDEO AQUÍ]

## Funcionalidades principales

- **Asistente con IA (`!dios_fua`)**: responde preguntas a través de Groq, mantiene una conversación corta por usuario y puede consultar datos de videojuegos en RAWG mediante una herramienta (*tool calling*).
- **Memoria entre streams**: al terminar el directo, la IA resume lo ocurrido y lo guarda en Supabase; los últimos resúmenes se inyectan en el contexto de las respuestas siguientes. También guarda hechos por usuario y un "lore" del canal (chistes internos, temas a evitar) que se aprende y se puede aprobar o borrar con `!lore`.
- **Presencia proactiva**: un co-host que comenta de forma espontánea (con probabilidad, cooldown y tope por hora), mensajes cuando el chat lleva rato en silencio, respuestas a menciones o frases naturales, y un tono que cambia según lo que pasa en el stream (racha de muertes, raid, victoria, BRB).
- **Reacción al chat**: detecta picos de palabras clave, spam de emotes y mayúsculas colectivas; en el primer caso crea un marker en el VOD y narra el momento.
- **Trivia**: preguntas generadas por IA según el juego actual, con pistas, coincidencia difusa de respuestas, dificultad adaptativa y ranking. Si Groq falla, usa un banco estático.
- **Alertas en tiempo real vía EventSub**: subs, bits, raids, follows, hype train, predicciones, encuestas y canjes, con mensajes generados por IA.
- **Comandos de stream**: `!muertes`, `!boss`, `!score`, `!clip`, `!marker`, `!so`, `!brb`, `!silencio`, `!quemeperdi`, `!juego`, `!uptime`, etc. (lista completa en [docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md)).

## Tecnologías utilizadas

- Node.js 22+ (JavaScript CommonJS, sin paso de compilación)
- [tmi.js](https://github.com/tmijs/tmi.js) para el chat IRC de Twitch
- Twitch Helix API y EventSub (webhooks)
- [Groq](https://groq.com) (`groq-sdk`) con modelos `openai/gpt-oss`
- Supabase (PostgreSQL) con `@supabase/supabase-js`; npoint.io como almacenamiento alternativo
- RAWG API para datos de videojuegos
- `node:test` para los tests
- Render (plan gratuito) para el despliegue

## Aspectos técnicos destacados

- **OAuth de Twitch**: el token del streamer se obtiene con el flujo de autorización de código en `/auth/broadcaster` → `/auth/callback`, con parámetro `state` aleatorio de un solo uso y con caducidad contra CSRF. Se guarda en Supabase, se renueva automáticamente al recibir un 401 y se reutiliza al reiniciar. Hay dos tokens con usos separados: el *App Access Token* solo gestiona las suscripciones de EventSub y el token del streamer hace las llamadas en nombre del canal.
- **EventSub con verificación HMAC**: el endpoint `POST /eventsub` valida la firma HMAC-SHA256 con `crypto.timingSafeEqual`, rechaza mensajes con más de 10 minutos de antigüedad (anti-replay), deduplica por ID de mensaje, responde 204 de inmediato y procesa el evento después para cumplir el plazo de Twitch.
- **Supabase**: tablas con Row Level Security activado y **sin políticas**; el bot accede con la clave de servicio (`service_role`) y nunca con la anónima. Esquema versionado en `supabase/migrations/`. Si no hay Supabase configurado, `storage.js` usa npoint.io y migra los datos cuando se configura después.
- **Control de ritmo del IRC**: una cola FIFO envuelve `client.say()` (máx. 18 mensajes/30 s, 1,1 s entre mensajes) para no ser limitado por Twitch, y se vacía de forma ordenada al recibir SIGTERM durante un deploy. Un watchdog reconecta el chat si se cae.
- **Resiliencia con Groq**: reintentos, límite global y por usuario de peticiones por minuto, y cadena de modelos de reserva cuando un modelo se retira (404). Gestiona los modelos de razonamiento (`reasoning_effort`) para que no agoten los tokens sin devolver texto.
- **Seguridad frente a *prompt injection***: el texto del chat se sanea antes de llegar al modelo, y los datos de usuario que entran en los prompts pasan por listas blancas y temas vetados.
- **Diseño testeable**: la lógica de decisión (detección de patrones, modos de personalidad, narrativa, coincidencia de juegos, rate limit, sub-contexto) está en funciones puras con tests.
- **Tests**: 260 tests en 49 suites con `node:test`, todos pasando (`npm test`). Cubren la memoria y el lore, la narrativa y los modos, los patrones de respuesta natural, el filtro, el rate limit, el fallback de modelos de Groq, la trivia y la verificación de EventSub. Los flujos con entrada/salida (por ejemplo, el co-host) no tienen test.
- **Despliegue declarativo**: `render.yaml` describe el servicio; un self-ping a `/health` cada 10 minutos evita que el plan gratuito lo duerma, y `npm run check:eventsub` detecta suscripciones apuntando a una URL antigua.

## Instalación y ejecución en local

Requisitos: Node.js 22 o superior, una cuenta de Twitch para el bot, una aplicación registrada en la consola de desarrolladores de Twitch y una clave de Groq. Supabase y RAWG son opcionales.

1. Clona el repositorio e instala las dependencias:
   ```bash
   git clone https://github.com/perezlopezalej/parlusorum-bot
   cd parlusorum-bot
   npm install
   ```
2. Copia la plantilla de variables y rellénala (nunca subas `.env` al repositorio):
   ```bash
   cp .env.example .env
   ```
   Obligatorias: `BOT_USERNAME`, `BOT_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `CHANNEL`, `GROQ_API_KEY`, `BROADCASTER_TOKEN`, `EVENTSUB_SECRET` (mínimo 10 caracteres). El resto está documentado en `.env.example`.
3. (Opcional) Genera el token del bot con `npm run bot-token`. El token del streamer se puede obtener visitando `/auth/broadcaster` con el bot en marcha.
4. (Opcional, recomendado) Crea un proyecto en Supabase, define `SUPABASE_URL` y `SUPABASE_KEY` (clave de servicio) y ejecuta en el SQL Editor los ficheros de `supabase/migrations/` en orden (`000` a `004`; `000` crea el esquema base y debe ir primero). Sin Supabase, el bot usa `NPOINT_BIN_ID` como alternativa.
5. Para recibir alertas de EventSub en local, expón el puerto con un túnel (por ejemplo ngrok) y define `PUBLIC_URL` con su URL HTTPS.
6. Arranca el bot:
   ```bash
   npm start      # producción
   npm run dev    # desarrollo con recarga automática
   ```
7. Ejecuta los tests:
   ```bash
   npm test
   ```

## Despliegue en Render

1. En Render: **New → Blueprint** y selecciona el repositorio; se lee `render.yaml` (plan gratuito, región Frankfurt, `npm ci` / `npm start`, health check en `/health`).
2. Rellena en el formulario las variables marcadas como secretas (las mismas de `.env.example`). `RENDER_EXTERNAL_URL` la inyecta Render y se usa como base del callback de EventSub.
3. Cada push a `main` despliega automáticamente. Tras desplegar, comprueba las suscripciones con `npm run check:eventsub`.

## Retos y aprendizajes

**Evitar que la IA se invente cosas.** Al principio, el bot respondía con datos falsos sobre
videojuegos (fechas, estudios, títulos que no existían). Lo resolví dándole a la IA una
herramienta, `buscar_juego`, que consulta la API de RAWG, y añadiendo una comprobación de
similitud para descartar coincidencias falsas. Aprendí que con un LLM no basta con mejorar el
prompt: hay que darle fuentes de datos reales.

**No depender de un único modelo de IA.** Groq retira modelos cada cierto tiempo, y si el
modelo que usaba el bot desaparecía, toda la IA dejaba de funcionar. Implementé una cadena de
modelos de reserva configurable (`GROQ_MODEL_FALLBACKS`): si un modelo devuelve "no
encontrado" o "retirado", el bot pasa al siguiente y deja un aviso en el log.

**Que el bot participe sin saturar el chat.** El modo cohost, la trivia, las alertas y las
respuestas automáticas podían pisarse entre sí. Diseñé un sistema de disparadores con límites
por hora, turnos entre comportamientos y reacciones a los silencios del chat, para que el bot
parezca un participante más y no un spammer.

**Seguridad y despliegue.** Llegué a subir credenciales al repositorio, así que tuve que
rotarlas todas. También protegí Supabase con RLS y acceso solo desde el servidor, y corregí
un fallo del watchdog que creaba conexiones IRC duplicadas en Render. Ahora los secretos van
siempre en variables de entorno, con un `.env.example` documentado.

Ideas sugeridas a partir del código:
- Coordinar varios comportamientos automáticos (co-host, hooks de silencio, respuestas a menciones) para que el bot no sature ni se pise con el chat, usando cooldowns, topes por hora y turnos por pausa.
- Mantener la IA estable cuando el proveedor cambia: Groq retiró modelos y obligó a añadir modelos de reserva y a manejar los modelos de razonamiento.
- Operar en un plan gratuito: evitar que el servicio se duerma, no perder mensajes pendientes en cada deploy y mantener fresco el token de OAuth sin intervención manual.

## Autor

**Alejandro Pérez López**

- GitHub: [perezlopezalej](https://github.com/perezlopezalej)
- LinkedIn: [Alejandro Pérez López](https://www.linkedin.com/in/alejandro-alejandro-perez-dev/)

## Licencia

© 2026 Alejandro Pérez López. Todos los derechos reservados. El código es público solo para consulta; para usarlo o adaptarlo, contacta con el autor.
