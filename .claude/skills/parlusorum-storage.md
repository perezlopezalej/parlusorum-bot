# Skill: parlusorum-storage

Sistema de persistencia del proyecto y mejores prácticas con Supabase.

## Abstracción actual (src/utils/storage.js)

```js
// Detección automática al arrancar:
const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);

// API pública unificada:
loadUsers()     // → objeto { [userId]: { username, firstSeen, lastSeen, messageCount, achievements } }
saveUsers(data) // → guarda el objeto completo
```

Si `SUPABASE_URL` y `SUPABASE_KEY` están configurados → usa Supabase.  
Si no → usa npoint.io como fallback (requiere `NPOINT_BIN_ID`).

## Esquema de Supabase

### Tabla `users`
```sql
user_id       TEXT PRIMARY KEY
username      TEXT
first_seen    TIMESTAMPTZ
last_seen     TIMESTAMPTZ
message_count INTEGER DEFAULT 0
achievements  JSONB DEFAULT '[]'
```

### Tabla `stream_sessions`
```sql
id               SERIAL PRIMARY KEY
started_at       TIMESTAMPTZ
ended_at         TIMESTAMPTZ
duration_minutes INTEGER
game             TEXT
peak_viewers     INTEGER
total_messages   INTEGER
death_count      INTEGER
top_commands     JSONB
```

### Tabla `stream_memory`
```sql
id                SERIAL PRIMARY KEY
session_id        INTEGER REFERENCES stream_sessions(id)
stream_date       DATE
game              TEXT
summary           TEXT
highlights        JSONB DEFAULT '[]'
recurring_phrases JSONB DEFAULT '[]'
active_users      JSONB DEFAULT '[]'
```

### Tabla `stream_highlights`
```sql
id               SERIAL PRIMARY KEY
session_id       INTEGER REFERENCES stream_sessions(id)
trigger_messages JSONB
marker_id        TEXT
description      TEXT
```

## Patrón de debounce en saveUser (src/utils/supabase.js:66-91)

Para no saturar Supabase con un upsert por cada mensaje del chat:
```js
const pendingSaves = new Map();

async function saveUser(userId, userData) {
  if (usersCache) usersCache[userId] = userData;  // actualizar cache inmediatamente

  if (pendingSaves.has(userId)) clearTimeout(pendingSaves.get(userId));
  pendingSaves.set(userId, setTimeout(async () => {
    // Upsert real a Supabase 3 segundos después del último cambio
    await db.from('users').upsert({ user_id: userId, ... }, { onConflict: 'user_id' });
  }, 3000));
}
```

## Cache de usuarios (src/utils/supabase.js:29-61)

```js
let usersCache = null;
let cacheLastLoaded = 0;
const CACHE_TTL = 5 * 60 * 1000;  // 5 minutos

async function loadUsers() {
  if (usersCache && Date.now() - cacheLastLoaded < CACHE_TTL) return usersCache;
  // Si la cache ha expirado, recarga desde Supabase
}
```

No llamar a `loadUsers()` en cada mensaje — la cache garantiza que no haya queries por cada evento de chat.

## Migración automática npoint → Supabase

`migrateFromNpoint()` en `src/utils/supabase.js:221-271` se ejecuta al arrancar si ambos están configurados:
- Comprueba si `users` en Supabase ya tiene registros
- Si está vacío, importa todos los usuarios de npoint.io
- Es idempotente — no duplica si ya migró

Se llama en `index.js:103-105`:
```js
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  await migrateFromNpoint().catch(e => logger.warn(`Migración: ${e.message}`));
}
```

## Connection Pooler de Supabase

**Importante (2025):** Supabase deprecó Session Mode en puerto 6543. Para Node.js en Railway:

- Usar **Transaction Mode** (puerto 6543 post-feb-2025, o puerto 5432 para Session)
- El SDK `@supabase/supabase-js` gestiona conexiones internamente — **no** usar la URL directa de postgres, usar siempre la URL HTTPS de la API de Supabase
- La URL correcta es la que empieza por `https://xxxx.supabase.co`, no la de postgres

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=eyJ...  (anon key o service_role key)
```

## Sesiones de stream

Ciclo de vida gestionado automáticamente por EventSub:
```
stream.online → startStreamSession(game)   → currentSessionId
stream.offline → endStreamSession(stats)   → cierra sesión con métricas
              → onStreamEnd(data, chatSample) → guarda stream_memory
```

`getCurrentSessionId()` devuelve el ID de la sesión activa o `null` si el canal está offline.

## Añadir una nueva columna/tabla

1. Añadir la columna en el dashboard de Supabase
2. Actualizar la función de `upsert`/`insert` en `src/utils/supabase.js`
3. Si es un nuevo campo en `users`, también actualizar `loadUsers()` para mapear el campo nuevo al objeto en memoria

## Fallback npoint.io

`src/utils/storage.js:26-65` — usa cache en memoria (`nCache`) con escritura en background con debounce de 5 segundos. Solo guarda/carga el objeto `users` completo.

Para proyectos nuevos: configurar Supabase desde el principio. npoint.io es un bin JSON público con límites de tamaño.

## Errores comunes

| Error | Causa | Solución |
|-------|-------|----------|
| `relation "users" does not exist` | Tablas no creadas en Supabase | Ejecutar el SQL de creación de tablas |
| `JWT expired` | SUPABASE_KEY caducada | Regenerar en Supabase dashboard → Settings → API |
| `too many connections` | Usando URL directa de postgres | Usar URL HTTPS de la API, no la de postgres directo |
| Storage cae a npoint.io inesperadamente | SUPABASE_URL o SUPABASE_KEY vacíos en Railway | Verificar Variables tab en Railway |
