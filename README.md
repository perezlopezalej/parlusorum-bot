# 🤖 Parlusorum Bot

Bot de Twitch para el canal de Parlusorum. Desarrollado con Node.js, tmi.js y Groq AI.

## 🚀 Arrancar el bot

```bash
npm install
npm start
```

## ⚙️ Configuración

Crea un archivo `.env` en la raíz con estas variables:

```env
BOT_USERNAME=nombre_cuenta_bot
BOT_TOKEN=oauth:tu_token_aqui
CLIENT_ID=tu_client_id
CLIENT_SECRET=tu_client_secret
CHANNEL=parlusorum
GROQ_API_KEY=tu_groq_api_key
PREFIX=!
NODE_ENV=production
```

## 💬 Comandos

| Comando | Quién | Descripción |
|---|---|---|
| `!dios_fua [pregunta]` | Todos | Pregunta a la IA |
| `!chiste` | Todos | Chiste aleatorio |
| `!trivia` | Todos | Pregunta de trivia |
| `!lurk` | Todos | Despedida de lurker |
| `!juego` | Todos | Juego actual con info de RAWG |
| `!estadisticas` | Todos | Viewers, juego, followers y uptime |
| `!uptime` | Todos | Tiempo en directo (o del bot si está offline) |
| `!score` | Todos | Bosses y muertes de la sesión |
| `!muertes` | Todos / Mods (`+1`, `reset`) | Contador de muertes |
| `!comandos` | Todos | Lista de comandos |
| `!ayuda [cmd]` | Todos | Ayuda de un comando |
| `!so @user` | Mods | Shoutout con IA |
| `!boss` | Mods | Suma un boss a la sesión |
| `!brb` | Mods | Activa/desactiva modo BRB |
| `!silencio` | Mods | Activa/desactiva mensajes automáticos |
| `!clip` | Mods | Crea un clip |
| `!marker [desc]` | Mods | Crea un marker en el VOD |
| `!resumen` | Mods | Resumen del stream |

## 📁 Estructura

```
parlusorum-bot/
├── src/
│   ├── ai/handler.js       # IA con Groq
│   ├── alerts/handler.js   # Alertas y logros
│   ├── commands/handler.js # Comandos generales
│   ├── games/handler.js    # Juegos
│   └── timers/handler.js   # Timers automáticos
├── config/commands.json    # Configuración de comandos y timers
├── data/users.json         # Datos de usuarios (auto-generado)
├── index.js                # Punto de entrada
└── .env                    # Credenciales (no subir a Git)
```

## 🏅 Logros automáticos

- **Conversador** 🏅 — 10 mensajes en el canal
- **Habladín** 🥈 — 100 mensajes en el canal  
- **Leyenda del chat** 🥇 — 500 mensajes en el canal
