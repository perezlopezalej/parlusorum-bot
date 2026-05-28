# Skill: parlusorum-comandos

Sistema de comandos del proyecto y patrones para extenderlo correctamente.

## Dos tipos de comandos

### 1. Comandos de config JSON (`config/commands.json`)

Respuesta fija + cooldown. Se añaden sin tocar código:
```json
{
  "commands": {
    "micomando": {
      "response": "Texto de respuesta aquí 📢",
      "cooldown": 30
    }
  }
}
```
El handler los procesa en `src/commands/handler.js:57-68`:
```js
if (config.commands[command]) {
  const cmd = config.commands[command];
  const key = `${command}-${userId}`;  // cooldown por usuario
  const now = Date.now();
  if (cooldowns.has(key) && now < cooldowns.get(key)) {
    client.say(channel, `@${username} espera ${Math.ceil((cooldowns.get(key) - now) / 1000)}s.`);
    return;
  }
  cooldowns.set(key, now + cmd.cooldown * 1000);
  client.say(channel, cmd.response);
  return;
}
```

### 2. Comandos con lógica propia (`switch` en handler.js:70-96)

Para comandos que hacen llamadas a API, usan estado, o requieren permisos:
```js
switch (command) {
  case 'micomando': return await handleMiComando(client, channel, tags, args);
}
```

## Patrón para añadir un comando nuevo con lógica

```js
// En src/commands/handler.js, dentro del switch:
case 'micomando': return await handleMiComando(client, channel, tags, args);

// Función handler:
async function handleMiComando(client, channel, tags, args) {
  const username = tags['display-name'];
  const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';

  // Si es solo para mods:
  if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }

  // Lógica aquí...
  client.say(channel, `@${username} resultado aquí`);
}
```

## Cooldowns

`src/commands/handler.js:14-15` — Map global con limpieza automática cada 30 min:
```js
const cooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of cooldowns) if (now > v) cooldowns.delete(k);
}, 30 * 60 * 1000);
```

**Clave de cooldown:** `${command}-${userId}` = cooldown por usuario.  
Para cooldown global del comando (todos comparten): usar `${command}` como clave.

## Verificación de permisos

```js
const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';
```
- `tags.mod` = true para moderadores
- `tags['user-type'] === 'mod'` = alternativa por si acaso
- `tags.badges?.broadcaster === '1'` = el streamer (broadcaster siempre tiene permisos de mod)

**No existe** un campo `tags.admin` — los VIPs no son mods automáticamente.

## Comandos que existen actualmente

| Comando | Tipo | Permisos | Descripción |
|---------|------|----------|-------------|
| `!comandos` | config.json | público | Lista de comandos |
| `!uptime` | switch | público | Tiempo activo del bot |
| `!juego` | switch | público | Juego actual + info RAWG |
| `!estadisticas` | switch | público | Stats del stream en tiempo real |
| `!titulo` | switch | público | Título del usuario según mensajes |
| `!muertes` | switch | público/mod | Contador de muertes |
| `!brb` | switch | mod | Toggle modo ausencia |
| `!silencio` | switch | mod | Toggle modo silencio del bot |
| `!so` | switch→ai | mod | Shoutout con IA |
| `!clip` | switch | mod | Crear clip |
| `!marker` | switch | mod | Marcar momento en VOD |
| `!resumen` | switch | mod | Resumen del stream |
| `!metricas` | switch | mod | Métricas de actividad |
| `!ayuda` | switch | público | Ayuda de comandos |
| `!dios_fua` | ai handler | público | Pregunta a la IA |
| `!chiste` | ai handler | público | Chiste del banco de datos |
| `!trivia` | games | público | Trivia |
| `!moneda` | games | público | Cara o cruz |

## Dispatch en index.js

El dispatch ocurre en `index.js:178-182`. Si añades un comando nuevo que no es trivia/moneda/dios_fua/chiste, **no hace falta tocar index.js** — el switch en `commands/handler.js` lo captura automáticamente.

Si el nuevo comando necesita ser procesado ANTES que `commands.handle()` (como trivia que captura respuestas sin prefix), añadirlo en index.js antes de la línea de dispatch.

## Timers (config/commands.json → timers array)

```json
{
  "timers": [
    { "message": "Texto del timer 🔔", "interval": 20 }
  ]
}
```
`interval` = minutos entre mensajes. Los timers solo se envían si el bot no está en modo silencio. Se inician una sola vez en el evento `'connected'` con el flag `timersStarted`.

## Helptext

Al añadir un comando, actualizar también el objeto `helpTexts` en `src/commands/handler.js:28-46` y la respuesta del `!ayuda` / `!comandos` en `config/commands.json`.
