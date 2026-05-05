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

| Comando | Descripción |
|---|---|
| `!discord` | Enlace al Discord |
| `!redes` | Redes sociales |
| `!comandos` | Lista de comandos |
| `!uptime` | Tiempo activo del bot |
| `!ruleta` | Juego de ruleta |
| `!trivia` | Pregunta de trivia |
| `!moneda` | Cara o cruz |
| `!pregunta [texto]` | Pregunta a la IA |
| `!cita` | Frase épica |
| `!chiste` | Chiste gaming |
| `!consejo` | Consejo random |
| `!meme` | Meme en texto |

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
