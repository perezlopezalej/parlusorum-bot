# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Parlusorum Bot is a Twitch chatbot for the "parlusorum" channel. It handles chat commands, AI-powered responses via Groq, trivia, automated alerts (subs/raids/follows), recurring timer messages, and cross-stream AI memory. Deployed to Railway; runs on Node.js 22+.

## Commands

```bash
npm start      # production
npm run dev    # development with --watch auto-reload
```

No build step — plain CommonJS JavaScript.

## Architecture

**Entry point**: `index.js` — loads env, wraps `client.say()` for IRC throttling, starts HTTP server (health + EventSub webhook), initializes tmi.js IRC client, and wires up all handlers on connection.

**Handler modules**:

| Module | Path | Responsibility |
|--------|------|----------------|
| Commands | `src/commands/handler.js` | Dispatches `!prefix` commands, enforces cooldowns and permissions |
| AI | `src/ai/handler.js` | Groq SDK, `!dios_fua`, jokes, cohost, emote/caps detection, pattern matching |
| Games | `src/games/handler.js` | Trivia (`!trivia`) |
| Alerts | `src/alerts/handler.js` | Sub/bits/raid notifications, follower milestones, lurker detection, achievements |
| Timers | `src/timers/handler.js` | Recurring messages and AI game commentary |
| EventSub | `src/eventsub.js` | Twitch webhook receiver with HMAC-SHA256 signature verification |
| Twitch API | `src/twitch/api.js` | Helix API calls (stream info, followers, clips, RAWG games) with token caching |
| Memory | `src/memory/handler.js` | Cross-stream AI summary generation and injection into prompts |

**Utilities** (`src/utils/`):

- `storage.js` — Supabase-first persistence with npoint.io JSON fallback; auto-migrates on startup
- `supabase.js` — Supabase client, stream sessions, memory and highlight tables
- `state.js` — Global mutable state (trivia active, silence mode, brb, raid active)
- `ratelimit.js` — Groq rate limiting (global + per-user by role)
- `irc-ratelimit.js` — IRC message throttling; wraps `client.say()` globally at startup (max 18 msg/30s)
- `filter.js` — Content sanitization and anti-prompt-injection before AI calls
- `metrics.js` — Chat activity tracking (messages/hour, peak viewers, top commands)
- `logger.js` — Console + file logging to `logs/bot.log` (auto-rotates at 5 MB)
- `search.js` — Tavily web search for factual AI context

**Config** (`config/`):
- `commands.json` — Command responses, cooldowns, timer intervals
- `channel.json` — Static channel metadata (broadcaster_id, usernames)

## Message Flow

```
tmi.js 'message' event
  → block self-messages (self flag + username check)
  → deduplicate by tags['id'] (Set cleared every 60s) — prevents double-response on reconnect
  → trackMessage() + addToHistory() + updateLastChatTime()
  → alerts.handleMessage() → checkFirstMessage + trackLurker
  → if no !prefix: checkForHighlight + checkEmoteSpam + checkCapsRage + checkPatternMatch + handleCohost
  → games.checkTriviaAnswer() (always, even without prefix)
  → if no !prefix: return
  → parse command → dispatch to games / ai / commands handler
  → client.say() → irc-ratelimit wrapper (max 18 msg/30s, min 1.1s gap)

Twitch EventSub → POST /eventsub
  → verify HMAC-SHA256 signature (timingSafeEqual)
  → deduplicate by Twitch-Eventsub-Message-Id
  → stream.online: reset session counters, start Supabase session, warmup mode check
  → stream.offline: end session, generate AI stream memory, post summary
  → channel.follow: post follow message, check follower milestones
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
EVENTSUB_SECRET         Webhook signature secret (required in production)
PUBLIC_URL              Railway service URL for EventSub webhook registration
SUPABASE_URL            Supabase project URL
SUPABASE_KEY            Supabase anon/service key
NPOINT_BIN_ID           Fallback JSON storage bin ID
PREFIX                  Command prefix (default: !)
PORT                    HTTP server port (default: 3000)
GROQ_MODEL              LLM model (default: llama-3.3-70b-versatile)
NODE_ENV                production | development
TAVILY_API_KEY          Tavily web search API key (factual context for !dios_fua)
RAWG_API_KEY            RAWG game database API key (game info for !juego)
WATCHDOG_TIMEOUT_MS     Reconnect if no chat during live stream (default: 1800000)
AI_TIMER_INTERVAL_MS    AI game commentary timer interval (default: 1500000 = 25 min)
COHOST_PROBABILITY      Probability of spontaneous chat comment 0–1 (default: 0.25)
COHOST_COOLDOWN_MS      Minimum gap between cohost messages (default: 120000)
QUESTION_COOLDOWN_MS    Global cooldown for !dios_fua in ms (default: 10000)
AI_MAX_RPM              Global Groq rate limit requests/min (default: 20)
```

## Deployment

Deployed on Railway. Railway usa `npm start` automáticamente. Las variables de entorno se configuran desde el dashboard (Variables tab del servicio). Railway asigna `PORT` dinámicamente — el HTTP server ya lo lee de `process.env.PORT`.

`PUBLIC_URL` debe ser la URL del servicio en Railway (ej. `https://parlusorum-bot-production.up.railway.app`) para que EventSub registre el webhook al arrancar. Sin ella, EventSub no funciona.

## Key Patterns

- **Cooldowns**: per-command Maps keyed `${command}-${userId}` (per-user) or `${command}` (global); cleaned every 30 min
- **Permissions**: mod-only commands check `tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1'`
- **IRC throttle**: `irc-ratelimit.js` wraps `client.say()` once at startup — all modules are throttled automatically without code changes
- **Token refresh**: broadcaster token validated on startup; App Access Token auto-refreshed every 23h in `src/eventsub.js`
- **Storage fallback**: if `SUPABASE_URL`/`SUPABASE_KEY` are absent, `storage.js` falls back to npoint.io with automatic migration when Supabase is later configured
- **Cross-stream memory**: on `stream.offline`, Groq generates a stream summary stored in Supabase; last 5 summaries are injected into the AI system prompt
