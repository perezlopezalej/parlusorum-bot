# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Parlusorum Bot is a Twitch chatbot for the "parlusorum" channel. It handles chat commands, AI-powered responses via Groq, games, automated alerts (subs/raids/follows), and recurring timer messages. Deployed to Railway; runs on Node.js 22+.

## Commands

```bash
npm start      # production
npm run dev    # development with --watch auto-reload
```

No build step — plain CommonJS JavaScript.

## Architecture

**Entry point**: `index.js` — loads env, starts the HTTP server (health + EventSub webhook), initializes tmi.js IRC client, and wires up all handlers on connection.

**Handler modules** (each exports `handle(client, channel, userstate, message)` or similar):

| Module | Path | Responsibility |
|--------|------|----------------|
| Commands | `src/commands/handler.js` | Dispatches `!prefix` commands, enforces cooldowns and permissions |
| AI | `src/ai/handler.js` | Groq SDK integration, `!dios_fua`, jokes, chat highlights |
| Games | `src/games/handler.js` | Trivia (`!trivia`) and coin flip (`!moneda`) |
| Alerts | `src/alerts/handler.js` | Sub/bits/raid notifications, follower milestones, welcome messages |
| Timers | `src/timers/handler.js` | Recurring automated messages |
| EventSub | `src/eventsub.js` | Twitch webhook receiver with HMAC-SHA256 signature verification |
| Twitch API | `src/twitch/api.js` | Helix API calls (stream info, followers, clips, games) with token caching |

**Utilities** (`src/utils/`):

- `storage.js` — Supabase-first persistence with npoint.io JSON fallback; auto-migrates on startup
- `state.js` — Global mutable state (trivia active, silence mode, live status, etc.)
- `ratelimit.js` — Groq rate limiting
- `filter.js` — Content sanitization before AI prompts
- `metrics.js` — Chat activity tracking
- `logger.js` — Console + file logging to `logs/bot.log`
- `search.js` — Web search for AI context

**Config** (`config/`):
- `commands.json` — Command responses, cooldowns, timer intervals
- `channel.json` — Static channel metadata (broadcaster_id, usernames)

## Message Flow

```
Twitch Chat → tmi.js → message event
  → deduplicate by message ID
  → add to AI memory / alert tracking / game answer check
  → if !prefix → commands or games handler
  → respond via client.say()

Twitch EventSub → POST /eventsub
  → verify HMAC-SHA256 signature
  → update bot state (isLive, followers)
  → trigger alerts
```

## Environment Variables

Required at startup (validated in `index.js`):

```
BOT_USERNAME        Twitch bot account username
BOT_TOKEN           Twitch OAuth token (oauth:...)
CLIENT_ID           Twitch app client ID
CLIENT_SECRET       Twitch app client secret
CHANNEL             Target channel name (e.g. parlusorum)
GROQ_API_KEY        Groq LLM API key
BROADCASTER_TOKEN   Streamer's OAuth token for API calls
```

Optional:
```
EVENTSUB_SECRET     Webhook signature secret
SUPABASE_URL        Supabase project URL
SUPABASE_KEY        Supabase anon/service key
NPOINT_BIN_ID       Fallback JSON storage bin ID
PREFIX              Command prefix (default: !)
PORT                HTTP server port (default: 3000)
GROQ_MODEL          LLM model (default: llama-3.3-70b-versatile)
NODE_ENV            production | development
```

## Deployment

Deployed on Railway. Railway usa `npm start` automáticamente. Las variables de entorno se configuran desde el dashboard (Variables tab del servicio). Railway asigna `PORT` dinámicamente — el HTTP server ya lo lee de `process.env.PORT`.

## Key Patterns

- **Cooldowns**: per-command Maps tracking last-used timestamps per user or globally
- **Permissions**: mod-only commands check `userstate.mod || userstate.badges?.broadcaster`
- **Token refresh**: broadcaster token validated on connection; refresh handled in `src/twitch/api.js`
- **Storage fallback**: if `SUPABASE_URL`/`SUPABASE_KEY` are absent, `storage.js` falls back to npoint.io with automatic migration when Supabase is later configured
