# Auditoría de parlusorum-bot (solo lectura)

Fecha: 2026-10-28 · Rama `main` · 91 commits (local = origin) · Ramas remotas: `main`, `dev`

No se ha modificado ningún fichero salvo la creación de este informe. No se muestra ningún valor secreto.

## 1. Seguridad

### 1.1 `.env` estuvo versionado (prioridad alta)
- El commit `cd72bf9` ("Initial commit", 2026-05-05) añadió `.env` al repositorio. Contiene `BOT_TOKEN` en la línea 3 (la auditoría no ha mirado el resto de claves). El commit `3d1909f` lo quitó del tracking, pero **sigue en el historial** y en `origin` (GitHub).
- Cualquiera con acceso de lectura al repo, y cualquier clon o fork anterior, puede recuperarlo con `git show cd72bf9:.env`.
- No he podido comprobar si esos valores siguen siendo válidos. La comparación contra el `.env` actual la bloqueó el sistema de permisos y no la he repetido.
- **Acción recomendada**: rotar todas las credenciales que estuvieran en ese `.env` (token del bot, `CLIENT_SECRET`, `GROQ_API_KEY`, claves de Supabase, `EVENTSUB_SECRET`, tokens del broadcaster). Reescribir el historial no basta si el repo ha sido público.
- Si el repo es público, asumir las credenciales como comprometidas.

### 1.2 Otros hallazgos en el historial
- `.claude/skills/parlusorum-deploy.md`, commit `a052e58`, líneas 19 y 24: coincide con el patrón de `oauth:...`. En la versión actual (líneas 46 y 51) son placeholders, así que probablemente es un falso positivo. Conviene confirmar que en `a052e58` no era un valor real.
- No hay claves `gsk_`, `sb_secret_` ni JWT en el código actual. `src/utils/logger.js` redacta tokens en los logs.
- `test/eventsub.test.js:1` usa un secreto de prueba obvio, sin riesgo.

### 1.3 Estado actual
- `.env` está en `.gitignore` y no está trackeado. Bien.
- `logs/` y `backups/` están ignorados. Los backups contienen `users.json`, `user_facts.json`, `stream_memory.json`, etc. (datos de usuarios del chat), bien fuera de git.
- `src/auth.js`: flujo OAuth correcto (state aleatorio con TTL, rate limit, validación de que el login coincide con el canal, cabeceras de seguridad).
- `/eventsub`: HMAC con `timingSafeEqual`, deduplicación y límite de tamaño de body.
- `npm audit --omit=dev`: 0 vulnerabilidades.
- `.claude/settings.json` (versionado) permite `Remove-Item` sobre una ruta concreta y `git pull *`. Es inocuo, pero no debería ir al repo; mejor moverlo a `settings.local.json`.

## 2. Ficheros de proyecto

| Fichero | Estado |
|---|---|
| `.gitignore` | Existe y cubre `.env`, `node_modules`, `logs`, `backups`. Contiene entradas obsoletas (`data/users.json`, `data/todo.json`) y tres líneas individuales para `INVENTARIO_FUNCIONES_v2/v3/v4.md`. |
| `.env.example` | **No existe.** |
| `README.md` | Existe pero está desactualizado (ver abajo). |
| `.node-version`, `render.yaml`, `package-lock.json` | Presentes. |

Faltas del README:
- Solo documenta 7 variables de entorno. Faltan las obligatorias `BROADCASTER_TOKEN` y `EVENTSUB_SECRET`: el bot hace `process.exit` sin ellas, así que seguir el README produce un arranque fallido.
- No menciona Supabase, EventSub, `PUBLIC_URL`, ni Render. Tampoco `/auth/broadcaster`.
- Cita `data/users.json` como "auto-generado" (la persistencia es ahora Supabase/npoint) y no menciona los scripts `npm test`, `backup`, `chatlog`, `check:eventsub`, `bot-token`.
- Faltan `.env.example` y la sección de migraciones de `supabase/migrations/`.

## 3. Estado del código

- **Tests**: `npm test` → 260 pasan, 0 fallan.
- **Documentos duplicados en la raíz**: `ANALISIS_FUNCIONALIDADES.md`, `INVENTARIO_FUNCIONES.md` (versionados) y `INVENTARIO_FUNCIONES_v2/v3/v4.md` (ignorados, locales). Son versiones sucesivas de lo mismo; consolidar en uno o mover a `docs/`.
- **`logs/`** (ignorado) acumula ficheros sueltos de pruebas: `test-*.log`, `test-out.txt`, `test-output.txt`, `plan-nucleo.md`, `seguridad.md`, `eventsub_old_app.txt`, etc. Limpiar.
- **`parlusorum-bot.code-workspace`**: está ignorado pero se ve en la raíz; sin importancia.
- **`scripts/`**: `backup.js`, `chatlog.js` y `check-eventsub.js` tienen permisos ejecutables y `get-bot-token.js` no; irrelevante en Windows.
- **Código muerto**: no pude hacer un análisis fiable de exports sin uso (el script que intenté fallaba por escapado y no lo he dado por bueno). Se detectaron referencias a `BOT_REFRESH_TOKEN` y a otras variables no documentadas en `render.yaml` ni en el README (ver §4). El único `TODO`/`FIXME` literal que buscaba no aparece en el código.
- Encontré 315 llamadas a `console.log`/TODO/FIXME combinadas en `src` e `index.js` (sin desglosar). Si no pasan por `logger`, no se rotan ni se redactan.
- **Rama `origin/dev`** existe; no he comprobado si está al día o abandonada.
- Convenciones de CLAUDE.md (estado en `state.js`, `truncate()`, mensajes en `messages.json`) no se han auditado una a una.

## 4. Qué hace falta para desplegar

El despliegue está bien preparado (`render.yaml` con blueprint, health check `/health`, `npm ci`/`npm start`, Node 22, autoDeploy desde `main`).

Pendiente:
1. **Rotar credenciales** (§1.1) antes de nada y actualizarlas en el dashboard de Render.
2. Crear el servicio desde Blueprint y rellenar las variables `sync: false`: `BOT_USERNAME`, `BOT_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `CHANNEL`, `GROQ_API_KEY`, `BROADCASTER_TOKEN`, `EVENTSUB_SECRET` (obligatorias) más `BROADCASTER_REFRESH_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`, `RAWG_API_KEY`.
3. **Supabase**: aplicar las 4 migraciones de `supabase/migrations/` (RLS, `channel_lore`, narrativa de sesiones, `chat_log`) y usar la clave service role.
4. Si se usa `BOT_REFRESH_TOKEN` (aparece en `src/twitch/api.js`), añadirlo a `render.yaml` y documentarlo; ahora no está.
5. Registrar `https://<servicio>.onrender.com/auth/callback` como redirect URI en la app de Twitch, y autorizar en `/auth/broadcaster`. Tras desplegar, ejecutar `npm run check:eventsub`.
6. Plan free de Render: el servicio duerme sin tráfico. El self-ping cada 10 min lo evita, pero depende de `RENDER_EXTERNAL_URL`/`PUBLIC_URL`. Considerar un monitor externo sobre `/health`.
7. `bot_autoban_dry_run` sigue en `true` a propósito; no cambiar sin pedirlo.

## Resumen de prioridades

1. Rotar credenciales: `.env` con `BOT_TOKEN` (y posiblemente más) está en el historial de git/GitHub (commit `cd72bf9`).
2. Crear `.env.example` y actualizar el README (faltan `BROADCASTER_TOKEN`, `EVENTSUB_SECRET`, Supabase, Render).
3. Documentar o eliminar `BOT_REFRESH_TOKEN` en `render.yaml`/README.
4. Limpiar `.gitignore`, los `INVENTARIO_*`/`ANALISIS_*` duplicados y los ficheros de prueba de `logs/`.
5. Sacar `.claude/settings.json` del repo (permisos personales) y revisar la rama `dev`.
