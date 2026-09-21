# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Parlusorum Bot is a Twitch chatbot for the "parlusorum" channel. It handles chat commands, AI-powered responses via Groq, trivia, automated alerts (subs/raids/follows), recurring timer messages, and cross-stream AI memory. Deployed to Render (free tier); runs on Node.js 22+.

## Commands

```bash
npm start      # production
npm run dev    # development with --watch auto-reload
```

No build step — plain CommonJS JavaScript.

## Architecture

**Entry point**: `index.js` — validates env vars, wraps `client.say()` for IRC throttling, starts HTTP server (health + EventSub webhook), initializes tmi.js IRC client, runs self-ping every 10 min to keep Render alive, and wires up all handlers on connection.

**Handler modules**:

| Module | Path | Responsibility |
|--------|------|----------------|
| Commands | `src/commands/handler.js` | Dispatches `!prefix` commands, enforces cooldowns and permissions |
| AI | `src/ai/handler.js` | Groq SDK, `!dios_fua`, jokes, cohost, emote/caps detection, pattern matching, warmup mode, stream end summary |
| Games | `src/games/handler.js` | Trivia (`!trivia`) — dynamic via Groq by current game, or static bank fallback |
| Alerts | `src/alerts/handler.js` | Sub/bits/raid notifications, follower milestones, lurker detection, achievements, first-message AI welcome |
| Timers | `src/timers/handler.js` | Recurring messages, stream duration announcements (40 min), AI game commentary (25 min) |
| EventSub | `src/eventsub.js` | Twitch webhook receiver with HMAC-SHA256 signature verification; App Access Token management |
| Twitch API | `src/twitch/api.js` | Helix API calls (stream info, followers, clips, markers, RAWG games) with token caching and auto-refresh on 401 |
| Memory | `src/memory/handler.js` | Cross-stream AI summary generation and injection into prompts |
| Bot Detector | `src/moderation/bot-detector.js` | Auto-bans known bots via twitchbots.info; batches up to 100 user IDs with 5s delay |

**Utilities** (`src/utils/`):

- `storage.js` — Supabase-first persistence with npoint.io JSON fallback; auto-migrates on startup
- `supabase.js` — Supabase client, stream sessions, memory and highlight tables, token persistence
- `state.js` — Global mutable state (trivia active, silence mode, brb, raid active)
- `ratelimit.js` — Groq rate limiting (global + per-user by role)
- `irc-ratelimit.js` — IRC FIFO queue; wraps `client.say()` globally at startup (max 18 msg/30s sliding window, 1.1s min gap, max 50 queued)
- `filter.js` — Content sanitization and anti-prompt-injection before AI calls
- `metrics.js` — Chat activity tracking (messages/hour, peak viewers, top commands)
- `logger.js` — Console + file logging to `logs/bot.log` (auto-rotates at 5 MB)
- `groq-utils.js` — Shared Groq call wrapper with retry, `truncate()`, model constants

**Config** (`config/`):
- `commands.json` — Command responses (only `!comandos`), cooldowns, timer intervals
- `channel.json` — Static channel metadata (broadcaster_id, usernames, emotes, milestones)

## Message Flow

```
tmi.js 'message' event
  → block self-messages (self flag + username check + partial match)
  → deduplicate by tags['id'] (Set cleared every 60s) — prevents double-response on reconnect
  → checkNewUser(tags) — bot-detector batches user IDs, auto-bans via twitchbots.info
  → trackMessage() + addToHistory() + updateLastChatTime()
  → alerts.handleMessage() → checkFirstMessage (AI welcome or static) + trackLurker
  → if no !prefix:
      checkForHighlight()   — 4+ keyword msgs in 15s → stream marker + AI narration
      checkPatternMatch()   — @dios_fua mentions or natural-language triggers → AI reply
        if not handled: handleCohost() — random spontaneous comment (25% prob, 120s cooldown)
      checkEmoteSpam()      — 8+ unique users same emote in 20s → AI comment
      checkCapsRage()       — 5+ users 70%+ caps in 15s → AI comment
  → games.checkTriviaAnswer() (always, even without prefix)
  → if no !prefix: return
  → parse command → dispatch to games / ai / commands handler
  → client.say() → irc-ratelimit FIFO queue (max 18 msg/30s, min 1.1s gap)

Twitch EventSub → POST /eventsub
  → verify HMAC-SHA256 signature (timingSafeEqual)
  → deduplicate by Twitch-Eventsub-Message-Id (max 200 cached)
  → respond 204 immediately; process in setImmediate to meet Twitch's <10s deadline
  → stream.online: set streamIsLive=true, reset session counters, start Supabase session,
      60s warmup check (if < 5 viewers → AI warmup message)
  → stream.offline: set streamIsLive=false, wait for session-start to finish (race guard),
      generate AI stream memory, call postStreamEnd() → posts summary in chat
  → channel.follow: post follow message, check follower milestones
```

## Commands Reference

| Command | Who | Description |
|---------|-----|-------------|
| `!dios_fua [q]` | All | AI question/answer (Groq, web search if factual, per-user conv memory) |
| `!chiste` | All | Random joke from 169-joke bank (30s per-user cooldown) |
| `!trivia` | All | Trivia — Groq generates game-specific question with hints, falls back to static bank |
| `!lurk` | All | AI farewell for lurk mode |
| `!juego` | All | Current game with RAWG info |
| `!estadisticas` | All | Live viewer count, game, followers, uptime |
| `!uptime` | All | Stream uptime (via EventSub) or bot uptime if offline |
| `!score` | All | Session bosses + deaths, all-time boss count from Supabase |
| `!muertes [+1\|reset]` | All/Mods | Death counter |
| `!boss` | Mods | Increment boss-kill counter for current session |
| `!brb` | Mods | Toggle BRB mode (sends reminder every 5 min) |
| `!silencio` | Mods | Toggle all automatic bot messages |
| `!so @user` | Mods | AI-powered shoutout using target's last game |
| `!clip` | Mods | Create a Twitch clip |
| `!marker [desc]` | Mods | Create a VOD stream marker |
| `!resumen` | Mods | Two-message stream summary (uptime, msgs/h, game, peak viewers, deaths) |
| `!comandos` | All | Full command list |
| `!ayuda [cmd]` | All | Help for a specific command |

**Removed commands** (respond with "ese comando ya no existe"): `!moneda`, `!titulo`, `!loss`, `!metricas`.

## Environment Variables

Required at startup (validated in `index.js`):

```
BOT_USERNAME              Twitch bot account username
BOT_TOKEN                 Twitch OAuth token (oauth:...)
CLIENT_ID                 Twitch app client ID
CLIENT_SECRET             Twitch app client secret
CHANNEL                   Target channel name (e.g. parlusorum)
GROQ_API_KEY              Groq LLM API key
BROADCASTER_TOKEN         Streamer's OAuth token for Helix API calls
EVENTSUB_SECRET           Webhook HMAC secret (min 10 chars)
```

Optional:
```
BROADCASTER_REFRESH_TOKEN  OAuth refresh token — auto-refreshes BROADCASTER_TOKEN on 401;
                           loaded from / saved to Supabase for persistence across restarts
PUBLIC_URL                 Overrides the EventSub callback base URL — only needed with a
                           custom domain or ngrok; otherwise RENDER_EXTERNAL_URL is used
RENDER_EXTERNAL_URL        Injected automatically by Render — used by self-ping and as the
                           EventSub callback base when PUBLIC_URL is absent
SUPABASE_URL               Supabase project URL
SUPABASE_KEY               Supabase anon/service key
NPOINT_BIN_ID              Fallback JSON storage bin ID (used if Supabase not configured)
PREFIX                     Command prefix (default: !)
PORT                       HTTP server port (default: 3000; Render injects this)
GROQ_MODEL                 LLM model (default: llama-3.3-70b-versatile)
GROQ_MODEL_FAST            Fast model for short calls (default: llama-3.1-8b-instant)
GROQ_MODEL_COMPOUND        Model with built-in web search (default: groq/compound)
NODE_ENV                   production | development
RAWG_API_KEY               RAWG game database API key (game info for !juego, timers, hooks)
WATCHDOG_TIMEOUT_MS        Reconnect if no chat during live stream (default: 1800000)
AI_TIMER_INTERVAL_MS       AI game commentary timer interval (default: 1500000 = 25 min)
COHOST_PROBABILITY         Probability of spontaneous chat comment 0–1 (default: 0.25)
COHOST_COOLDOWN_MS         Minimum gap between cohost messages (default: 120000)
QUESTION_COOLDOWN_MS       Global cooldown for !dios_fua in ms (default: 10000)
AI_MAX_RPM                 Global Groq rate limit requests/min (default: 20)
HOOK_INTERVAL_MS           Min gap between AI chat hooks (default: 600000 = 10 min)
HOOK_SILENCE_MS            Chat must be silent this long before a hook fires (default: 300000)
LURKER_THRESHOLD_MS        Silence time before a returning lurker is greeted (default: 900000)
```

## Deployment

Deployed on **Render** (free tier). Render uses `npm start` automatically. Variables are set from the Render dashboard (Environment tab of the service). Render assigns `PORT` dynamically — the HTTP server reads it from `process.env.PORT`. Render injects `RENDER_EXTERNAL_URL` automatically.

The repo ships a `render.yaml` blueprint (free plan, Frankfurt, `npm ci` / `npm start`, health check on `/health`). EventSub registers its webhook on startup against `PUBLIC_URL || RENDER_EXTERNAL_URL`, so `PUBLIC_URL` is only needed with a custom domain or ngrok. `npm run check:eventsub` lists the live subscriptions and flags any callback pointing at a stale URL.

**Self-ping**: `index.js` pings `GET /health` every 10 minutes using `RENDER_EXTERNAL_URL || PUBLIC_URL` to prevent the Render free-tier service from sleeping.

**Auto-deploy**: configured in Render to deploy on every push to GitHub `main`.

## Key Patterns

- **Cooldowns**: per-command Maps keyed `${command}-${userId}` (per-user) or `${command}` (global); cleaned every 30 min via `setInterval`
- **Permissions**: mod-only commands check `tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1'`
- **IRC throttle**: `irc-ratelimit.js` wraps `client.say()` once at startup with a FIFO queue — all modules are throttled automatically without code changes; messages sent to a disconnected client are discarded with a warning
- **Token refresh**: broadcaster token loaded from Supabase on startup (overrides .env if fresher); auto-refreshed on any 401 via `refreshBroadcasterToken()` in `api.js`; new tokens persisted back to Supabase; App Access Token (for EventSub) cached 23 h
- **Storage fallback**: if `SUPABASE_URL`/`SUPABASE_KEY` absent, `storage.js` falls back to npoint.io with automatic migration when Supabase is later configured
- **Cross-stream memory**: on `stream.offline`, Groq generates a stream summary stored in Supabase; last 5 summaries are injected into the AI system prompt (10-min cache)
- **Bot detection**: `checkNewUser()` called on every new chat message; user IDs batched (up to 100, 5s delay) and checked against twitchbots.info; confirmed bots are banned via Helix; verified IDs cached in-process
- **Auto-highlights**: `checkForHighlight()` tracks keyword messages (clip/fua/epico/wtf…); if 4+ trigger messages arrive within 15 s, creates a stream marker via Helix and posts AI narration in chat; result saved to Supabase highlights table
- **Emote spam**: 8+ unique users use the same emote token within 20 s → AI comment narrating the collective reaction
- **CAPS rage**: 5+ unique users send 70%+ caps messages within 15 s → AI comment
- **Pattern matcher**: responds without `!` prefix — direct @dios_fua mentions (8s global / 10s per-user cooldown) and natural-language triggers like "qué juego es" or "eres un bot" (45s global / 30s per-user)
- **Per-user conversation memory**: `handleQuestion` and `checkPatternMatch` keep up to 5 turns per user (1 h TTL, max 200 users in-memory) so multi-turn exchanges feel coherent
- **Warmup mode**: 60 s after `stream.online`, if viewer count < 5, posts an AI warm-up message asking the chat about the current game
- **Stream end summary**: `postStreamEnd()` posts the AI-generated stream summary in chat; `streamEndPostedByEventSub` flag prevents the generic "fin del stream" fallback from firing too
- **EventSub race guard**: `_sessionStarting` promise ensures the `stream.offline` handler waits for `stream.online` async I/O to complete before generating the end-of-stream memory

## Conventions

- **State mutable**: toda variable de estado compartida entre funciones vive en `src/utils/state.js`. Nunca declarar estado mutable en los handlers (`ai/handler.js`, `commands/handler.js`, etc.).
- **require() al inicio**: todos los `require()` van al inicio del archivo, agrupados: core Node → npm → módulos propios. Excepción permitida: dependencias circulares conocidas (`eventsub` ↔ `ai`, `alerts` ↔ `ai`) que deben permanecer lazy dentro del cuerpo de la función.
- **Caché in-memory**: para evitar queries repetidas a Supabase usar `Map` con TTL — mismo patrón que `fullContextCache` en `ai/handler.js` (`userFactsCache`, TTL 5 min). Sin dependencias externas.
- **Mensajes al chat**: los textos en español que llegan al chat van en `config/messages.json` (fallbacks, warmup strings, etc.). Excepción: mensajes de error internos o logs que nunca llegan al chat.
- **truncate() obligatorio**: todo `client.say()` con contenido dinámico o procedente de `config/` debe pasar por `truncate()` antes de enviarse. Sin excepción — protege contra el límite de 500 caracteres de Twitch y futuros cambios de config.
- **Map con TTL → setInterval de pruning**: todo `Map` indexado por usuario o ID con un TTL definido debe declarar su `setInterval` de limpieza inmediatamente después. Ver patrón en `chisteCooldowns`, `questionCooldowns`, `userFactsCache` en `ai/handler.js`.

## Known limitations

- **`is_regular` sin umbral**: `onStreamEnd` en `memory/handler.js` marca como `is_regular` a todos los usuarios activos del stream sin mínimo de mensajes, porque `getActiveUsers()` devuelve un `Set` de usernames sin conteo por usuario. Para añadir umbral se necesitaría un Map `username → messageCount` en `ai/handler.js` alimentado desde `addToHistory()`.
