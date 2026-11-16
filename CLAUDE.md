# CLAUDE.md

Guía para Claude Code en este repo. Visión general y despliegue: `README.md`; detalle de la IA: `docs/arquitectura-ia.md`.
**Detalle completo (módulos, flujo de mensajes, variables de entorno, patrones, prompts, privacidad): [docs/claude-detalle.md](docs/claude-detalle.md).** Consultarlo antes de tocar esas áreas.

## Proyecto

Bot de Twitch del canal "parlusorum": comandos, IA con Groq, trivia, alertas, timers y memoria entre streams. Node.js 22+, CommonJS, sin build. Render (free tier), auto-deploy en cada push a `main`.

## Reglas de trabajo

- Nunca leer ni mostrar `.env`, tokens o secrets.
- No hacer commit ni push salvo que se pida.
- Las tareas nuevas empiezan en solo lectura salvo que se indique lo contrario.
- Salidas largas a un fichero en `logs/` y resumen corto en el chat.
- Tras cualquier cambio de código, ejecutar `npm test`, `npm run lint` y `npm run format:check` (si falla el formato, `npm run format`); no dar la tarea por terminada si algo falla.
- Si se añade una función pura nueva, añadirle su test en `test/`.
- Antes de desplegar cambios en prompts o filtros (`style.js`, `src/ai/quality/`, `factcheck.js`, `patterns.js`), ejecutar `npm run eval` (casos en `test/eval-cases.json`, informe en `logs/eval.txt`).
- Al terminar cada tarea, actualizar `PROGRESS.md` (Hecho / Pendiente de probar en directo / Ideas futuras).
- `docs/investigacion-buenas-practicas.md`: investigación sobre buenas prácticas de IA, chatbots, seguridad y privacidad (nov. 2026). Consultarla antes de cambiar prompts, el router de IA o el tratamiento de datos. Algunos datos legales y de límites deben verificarse; no es asesoramiento jurídico.

## Comandos

```bash
npm start | npm run dev      # producción | --watch
npm test                     # node --test sobre test/**/*.test.js
npm run lint | lint:fix      # ESLint 9 (también en la CI)
npm run format | format:check  # Prettier (comillas simples, 120 columnas; también en la CI)
npm run check:eventsub       # lista suscripciones EventSub y marca callbacks obsoletos
npm run eval                 # batería con la IA REAL (gasta Groq/IGDB; no va en npm test ni en la CI)
npm run backup | chatlog | forget -- <login> [--dry-run] | bot-token
```

## Decisiones que no se deducen del código

- `bot_autoban_dry_run` es `true` **a propósito**: solo registra. No cambiarlo sin que se pida. `bot_whitelist` (channel.json): nunca se auto-banean.
- Solo Groq (Gemini retirado: sus términos no permiten el nivel gratuito para usuarios del EEE). Todo sitio llama a `aiChat(tipo, params, { names })` sin elegir modelo; el router (`src/utils/ai-router.js`) reparte y salta de modelo. El texto generado pasa siempre por `src/ai/quality/`, el selector y el factcheck. Los nicks salen a Groq como `user1`, `user2`… (`ai-pseudonym.js`).
- Groq retira modelos a menudo: consultar `GET https://api.groq.com/openai/v1/models` antes de cambiar `GROQ_MODEL*`. Los gpt-oss necesitan `reasoning_effort: 'low'` (lo fija el router).
- Prompts (`src/ai/style.js`): todo en positivo y ninguna palabra o frase prohibida citada (las prohibiciones viven en `src/ai/quality/`); un reintento solo añade `<correccion>` en positivo.
- Dos tokens: App Access Token solo para EventSub y consultas públicas de `streams`; lo que actúa en nombre del canal usa el token del broadcaster (Supabase al arrancar, refresco en 401).
- IGDB es la única fuente de datos de juegos; `summary`, nunca `storyline`.
- Comandos retirados (responden "ese comando ya no existe"): `!moneda`, `!titulo`, `!loss`, `!metricas`.
- Controles en vivo (mods/streamer): `!fua_callate <min>` y `!fua_modo reactivo|normal`.

## Privacidad (reglas)

- Datos por usuario por `user_id` de Twitch (`tags['user-id']`), no por nick. Cualquier dato nuevo por usuario se añade a `privacy/forget.js` (con test en `test/forget.test.js`) y a `privacy/retention.js`.
- Nada personal entre streams: resúmenes sin nicks (`names.scrubNicks`); el registro de calidad sin nicks ni `user_id`.
- Lore aprendido: nada entra en los prompts sin `!lore aprobar`.
- Si cambian plazos o proveedores, actualizar `docs/aviso-privacidad.md` y `!privacidad` (`config/messages.json`).

## Convenciones

- **Estado mutable**: toda variable de estado compartida vive en `src/utils/state.js`; nunca en los handlers.
- **require()**: al inicio, agrupados core Node → npm → propios. Excepción: dependencias circulares conocidas (`eventsub` ↔ `ai`, `alerts` ↔ `ai`), lazy dentro de la función.
- **Caché in-memory**: `Map` con TTL (patrón `fullContextCache` / `userFactsCache`), sin dependencias externas, y `setInterval` de pruning justo después.
- **Mensajes al chat**: textos en español en `config/messages.json` (excepto errores internos y logs).
- **`truncate()` obligatorio** en todo `client.say()` con contenido dinámico o de `config/` (límite 500 de Twitch).
- **Cooldowns**: Maps `${command}-${userId}` (usuario) o `${command}` (global).
- **Permisos de mod**: `tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1'`.
- **Supabase**: clave secreta (service role), RLS activado en todas las tablas y sin políticas; nunca volver a la clave anon ni añadir políticas permisivas.
- **Variables de entorno**: obligatorias validadas en `index.js` (`BOT_USERNAME`, `BOT_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `CHANNEL`, `GROQ_API_KEY`, `BROADCASTER_TOKEN`, `EVENTSUB_SECRET` mín. 10 caracteres); las opcionales, en el detalle.
