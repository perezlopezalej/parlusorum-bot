# Skill: parlusorum-ai

Integración Groq del proyecto y mejores prácticas de seguridad y rendimiento.

## Configuración actual

```js
// src/ai/handler.js:11-16
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const TWITCH_MAX_LENGTH = 490;  // límite real de Twitch son 500 chars
```

**Modelo actual:** `llama-3.3-70b-versatile` — recomendado para este caso de uso. Si cambia a otro modelo, editar `GROQ_MODEL` en `.env`.

**Rate limits del free tier Groq (2026):**
- 30 RPM globales
- 6.000 TPM (tokens por minuto)  
- 1.000 RPD (requests por día)
- El proyecto implementa `AI_MAX_RPM=20` como límite interno para dejar margen

## Retry con backoff exponencial

`src/ai/handler.js:33-45`:
```js
async function groqWithRetry(params, maxRetries = 2) {
  params.model = GROQ_MODEL;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await groq.chat.completions.create(params); }
    catch (err) {
      if ((err.status === 429 || err.message?.includes('rate')) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
}
```
Delays: 2s → 4s. Siempre usar `groqWithRetry()` para llamadas a Groq, nunca `groq.chat.completions.create()` directamente.

## Rate limiting diferenciado por usuario

`src/utils/ratelimit.js`:
```
Usuario normal:  3 RPM  (AI_MAX_RPM_USER)
Moderador:       8 RPM  (AI_MAX_RPM_MOD)  
Creador (vlxj97): 15 RPM (AI_MAX_RPM_CREATOR)
Global:          20 RPM  (AI_MAX_RPM)
```

Antes de llamar a Groq, siempre verificar en este orden:
```js
if (!canMakeRequest()) { /* límite global */ return; }
const userType = getUserType(username);  // 'creator' | 'streamer' | 'normal'
if (!canUserMakeRequest(userId, userType)) { /* límite por usuario */ return; }
```

## Defensa contra prompt injection

`src/utils/filter.js` — `sanitizeForAI(text)` hace tres cosas:
1. Normaliza (quita acentos, pasa a minúsculas)
2. Busca patrones bloqueados: frases de jailbreak, contenido explícito, odio
3. Limita a 200 chars y elimina `< > { }`

Patrones de inyección bloqueados explícitamente:
```
'ignore previous', 'ignore all', 'forget your instructions',
'new instructions', 'system prompt', 'jailbreak', 'dan mode',
'pretend you are', 'act as if'
```

**Siempre** pasar input del chat por `sanitizeForAI()` antes de incluirlo en un prompt:
```js
const question = sanitizeForAI(rawQuestion);
if (!question) { client.say(channel, `@${username} esa pregunta no la puedo responder 🙅`); return; }
```

## Gestión del context window

El sistema usa tres niveles de contexto según el caso:

**Contexto completo** (`getFullContext()`) — para `!dios_fua`:
- Cache de 2 minutos para no llamar a la API en cada mensaje
- Incluye: canal, juego actual + datos RAWG, estado live/offline, memoria de streams pasados
- Se invalida con `invalidateContextCache()` cuando cambia el estado del stream

**Contexto mínimo** (`getMinimalContext()`) — para cohost y shoutouts:
- Sin llamadas a API, solo datos estáticos del `channel.json`
- Usar cuando velocidad > profundidad

**Historial de chat** (`getRecentHistory(n)`) — últimos n mensajes de los últimos 10 min:
```js
// src/ai/handler.js:137-143
function getRecentHistory(n = 6) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  return chatHistory
    .filter(m => m.ts > cutoff)
    .slice(-n)
    .map(m => `${m.username}: ${m.message}`)
    .join('\n');
}
```

## Memoria de conversación por usuario

```js
// src/ai/handler.js:147-172
// MAX_CONV_TURNS = 5, MAX_CONV_AGE = 1h, MAX_CONVERSATION_USERS = 200
getUserConversation(userId)       // devuelve turnos filtrados por sesión y TTL
addToUserConversation(userId, role, content)  // añade con purga automática
```

En `!dios_fua`, la conversación se inyecta entre system y el mensaje del usuario:
```js
messages: [
  { role: 'system', content: systemContent },
  ...userConv,                              // historial del usuario
  { role: 'user', content: `${username}: ${question}` }
]
```

## Búsqueda web Tavily (FIX #7)

Para preguntas factuales, el bot busca contexto real antes de responder:
```js
if (needsWebSearch(question)) {
  const webResult = await searchWeb(question);
  if (webResult) searchContext = `\n[Informacion web]: ${webResult}`;
}
```
`needsWebSearch()` detecta preguntas con palabras como "qué", "cuándo", "quién", "cómo", nombres propios, etc.

## Personalidad y roles (FIX #1)

Los roles están claramente separados en `channel.json`:
- `creator_username: "vlxj97"` — quien programó el bot
- `streamer_username: "parlusorum"` — host del canal

El bot trata a cada uno diferente. Nunca confundir ambos roles en el prompt.
Si alguien añade un nuevo tipo de usuario especial, añadirlo en `getUserType()` y `getPersonality()`.

## Funciones exportadas

```js
module.exports = {
  handleCohost,       // mensaje espontáneo basado en el chat reciente
  handleChiste,       // !chiste — banco de 169 chistes en data/chistes.json
  handleQuestion,     // !dios_fua — pregunta con contexto completo + web search
  handleShoutout,     // !so — shoutout con IA
  addToHistory,       // llamar en cada mensaje (index.js)
  updateLastChatTime, // actualiza timestamp de último mensaje del chat
  getRecentHistory,   // devuelve historial formateado
  checkChatHook,      // hook espontáneo si el chat lleva tiempo inactivo
  checkStreamStatus,  // detecta transición live/offline
  initStreamStatus,   // llamar al arrancar
  invalidateContextCache,
  checkForHighlight,  // detecta momentos épicos y crea markers automáticos
  getActiveUsers, resetActiveUsers
}
```

## Cómo añadir una nueva función IA

1. Crear función `async handleNuevaFuncion(client, channel, tags, args)` en `src/ai/handler.js`
2. Usar `groqWithRetry()` con `max_tokens` ajustado (70-80 para mensajes cortos, 150 para respuestas largas)
3. Aplicar `truncate()` al resultado antes de `client.say()`
4. Verificar `isSilenced()` si el bot puede no querer responder
5. Exportar la función
6. Si es un comando `!nuevo`, añadir dispatch en `index.js` o en `commands/handler.js`
