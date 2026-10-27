# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Parlusorum Bot is a Twitch chatbot for the "parlusorum" channel: chat commands, AI responses via Groq, trivia, alerts (subs/raids/follows), recurring timers, and cross-stream AI memory. Deployed to Render (free tier); Node.js 22+.

## Reglas de trabajo

- Nunca leer en voz alta ni mostrar el contenido de `.env`, tokens o secrets.
- No hacer commit ni push salvo que se pida.
- Las tareas nuevas empiezan en solo lectura salvo que se indique lo contrario.
- Salidas largas a un fichero en `logs/` y resumen corto en el chat.

## Commands

```bash
npm start      # production
npm run dev    # development with --watch auto-reload
```

No build step — plain CommonJS JavaScript.

## Architecture

**Entry point**: `index.js` — validates env vars, wraps `client.say()` for IRC throttling, starts HTTP server (health + EventSub webhook + auth routes), initializes tmi.js, self-pings every 10 min, wires up handlers on connection.

| Module | Path | Responsibility |
|--------|------|----------------|
| Commands | `src/commands/handler.js` | Dispatches `!prefix` commands, cooldowns, permissions |
| AI | `src/ai/handler.js` | Groq, `!dios_fua`, jokes, cohost, emote/caps detection, pattern matching, warmup, stream end summary |
| Games | `src/games/handler.js` | Trivia — dynamic via Groq by current game, static bank fallback |
| Alerts | `src/alerts/handler.js` | Sub/bits/raid, follower milestones, lurkers, achievements, first-message welcome |
| Timers | `src/timers/handler.js` | Recurring messages, duration announcements (40 min), AI game commentary (25 min) |
| EventSub | `src/eventsub.js` | Webhook receiver (HMAC-SHA256), App Access Token management |
| Auth | `src/auth.js` | Broadcaster OAuth: `/auth/broadcaster` (start) and `/auth/callback`; scopes in `BROADCASTER_SCOPES` |
| Twitch API | `src/twitch/api.js` | Helix calls (stream, followers, clips, markers, RAWG) with token cache and refresh on 401 |
| Memory | `src/memory/handler.js` | Cross-stream summary generation and injection into prompts |
| Bot Detector | `src/moderation/bot-detector.js` | Auto-bans known bots via twitchbots.info (batches of up to 100 IDs, 5s delay) |

**Utilities** (`src/utils/`): `storage.js` (Supabase-first, npoint.io fallback, auto-migrates), `supabase.js` (sessions, memory, highlights, token persistence), `state.js` (global mutable state), `ratelimit.js` (Groq global + per-user), `irc-ratelimit.js` (FIFO queue wrapping `client.say()`: max 18 msg/30s, 1.1s gap, 50 queued), `filter.js` (sanitization / anti-prompt-injection), `metrics.js`, `logger.js` (`logs/bot.log`, rotates at 5 MB), `groq-utils.js` (`groqWithRetry()`, `truncate()`, model constants).

**Config** (`config/`): `commands.json` (only `!comandos`, cooldowns, timer intervals), `channel.json` (broadcaster_id, usernames, emotes, milestones, `bot_whitelist`, `bot_autoban_dry_run`), `messages.json` (chat texts).

- `bot_whitelist`: usernames never auto-banned (nightbot, streamelements, fossabot, moobot, dios_fua).
- `bot_autoban_dry_run` is `true` **on purpose**: the detector only logs would-be bans. Don't flip it without being asked.

## Message Flow

```
tmi.js 'message'
  → block self-messages; dedupe by tags['id'] (Set cleared every 60s)
  → checkNewUser(tags) (bot detector) → trackMessage/addToHistory/updateLastChatTime
  → alerts.handleMessage() → checkFirstMessage + trackLurker
  → if no !prefix:
      checkForHighlight()  — 4+ keyword msgs in 15s → stream marker + AI narration (saved to Supabase)
      checkPatternMatch()  — @dios_fua mentions (8s global/10s user cd) or natural-language
                             triggers (45s/30s) → AI reply; if unhandled: handleCohost() (25%, 120s cd)
      checkEmoteSpam()     — 8+ users, same emote, 20s → AI comment
      checkCapsRage()      — 5+ users, 70%+ caps, 15s → AI comment
  → games.checkTriviaAnswer() (always)
  → no !prefix: return; else dispatch to games / ai / commands
  → client.say() → irc-ratelimit queue

Twitch EventSub → POST /eventsub
  → verify HMAC (timingSafeEqual); dedupe by Twitch-Eventsub-Message-Id (max 200)
  → 204 immediately; process in setImmediate (Twitch <10s deadline)
  → stream.online: streamIsLive=true, reset counters, start Supabase session,
      60s later if < 5 viewers → AI warmup message
  → stream.offline: streamIsLive=false, await _sessionStarting (race guard), generate AI memory,
      postStreamEnd() (streamEndPostedByEventSub suppresses the generic "fin del stream")
  → channel.follow: follow message + milestones
```

## Commands Reference

| Command | Who | Description |
|---------|-----|-------------|
| `!dios_fua [q]` | All | AI Q&A (per-user conv memory; no web search) |
| `!chiste` | All | Random joke from 169-joke bank (30s per-user cd) |
| `!trivia` | All | Groq game-specific question with hints, static fallback |
| `!lurk` | All | AI lurk farewell |
| `!juego` | All | Current game with RAWG info |
| `!estadisticas` | All | Viewers, game, followers, uptime |
| `!uptime` | All | Stream uptime (EventSub) or bot uptime if offline |
| `!score` | All | Session bosses + deaths, all-time bosses from Supabase |
| `!muertes [+1\|reset]` | All/Mods | Death counter |
| `!boss` | Mods | Increment session boss kills |
| `!brb` | Mods | Toggle BRB mode (reminder every 5 min) |
| `!silencio` | Mods | Toggle all automatic bot messages |
| `!so @user` | Mods | AI shoutout using target's last game |
| `!clip` | Mods | Create a clip |
| `!marker [desc]` | Mods | Create a VOD marker |
| `!resumen` | Mods | One-message stream summary |
| `!comandos` | All | Command list |
| `!ayuda [cmd]` | All | Help for a command |

**Removed commands** (reply "ese comando ya no existe"): `!moneda`, `!titulo`, `!loss`, `!metricas`.

## Environment Variables

Required (validated in `index.js`): `BOT_USERNAME`, `BOT_TOKEN` (oauth:...), `CLIENT_ID`, `CLIENT_SECRET`, `CHANNEL`, `GROQ_API_KEY`, `BROADCASTER_TOKEN` (streamer's token for Helix), `EVENTSUB_SECRET` (min 10 chars).

Optional:
```
BROADCASTER_REFRESH_TOKEN  Auto-refreshes BROADCASTER_TOKEN on 401; persisted in Supabase
PUBLIC_URL                 EventSub callback base override (custom domain/ngrok); else RENDER_EXTERNAL_URL
RENDER_EXTERNAL_URL        Injected by Render; self-ping and EventSub callback base
SUPABASE_URL / SUPABASE_KEY  Supabase project; NPOINT_BIN_ID = fallback storage if absent
PREFIX                     Command prefix (default: !)
PORT                       HTTP port (default 3000; Render injects)
GROQ_MODEL                 default openai/gpt-oss-120b
GROQ_MODEL_FAST            default openai/gpt-oss-20b
GROQ_MODEL_COMPOUND        !dios_fua model (default = GROQ_MODEL; groq/compound withdrawn)
NODE_ENV                   production | development
RAWG_API_KEY               Game info for !juego, timers, hooks
AI_TIMER_INTERVAL_MS       AI game commentary interval (default 1500000)
COHOST_PROBABILITY         0–1 (default 0.25)
COHOST_COOLDOWN_MS         default 120000
QUESTION_COOLDOWN_MS       Global !dios_fua cooldown (default 10000)
AI_MAX_RPM                 Global Groq requests/min (default 20)
HOOK_INTERVAL_MS           Min gap between AI hooks (default 600000)
HOOK_SILENCE_MS            Chat silence required before a hook (default 300000)
TRIVIA_DURATION_MS         Trivia total duration, hints spread evenly (default 30000, min 10000)
LURKER_THRESHOLD_MS        Silence before greeting a returning lurker (default 900000)
```

## Deployment

**Render** free tier: `npm start`, variables set in the dashboard, auto-deploys on every push to GitHub `main`. `render.yaml` blueprint (Frankfurt, `npm ci` / `npm start`, health check `/health`). Self-ping hits `/health` every 10 min (`RENDER_EXTERNAL_URL || PUBLIC_URL`) to avoid sleep. `npm run check:eventsub` lists live subscriptions and flags callbacks pointing at a stale URL.

## Key Patterns

- **Cooldowns**: Maps keyed `${command}-${userId}` (per-user) or `${command}` (global); pruned every 30 min via `setInterval`.
- **Permissions**: mod-only commands check `tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1'`.
- **IRC throttle**: `irc-ratelimit.js` wraps `client.say()` once at startup; messages to a disconnected client are discarded with a warning.
- **Watchdog IRC**: cada 5 min, en directo o no, si `chatStatus.connected` es false llama a `connectChat()` (ignora la inactividad del chat); `connectChat()` tiene guarda `chatConnecting` y no abre otro socket si `client.readyState()` es OPEN/CONNECTING.
- **Tokens**: broadcaster token loaded from Supabase on startup (overrides .env if fresher), refreshed on 401 via `refreshBroadcasterToken()` and persisted back. `/auth/broadcaster` → `/auth/callback` re-authorizes it manually. **Two tokens, two uses**: the App Access Token (cached 23 h) is used *only* to create/list/delete EventSub webhook subscriptions (and read-only public `streams` checks in `eventsub.js`); every Helix call acting on behalf of the channel (clips, markers, bans, followers — anything in `BROADCASTER_SCOPES`) uses the broadcaster token.
- **Storage fallback**: without Supabase env vars, `storage.js` uses npoint.io and migrates when Supabase is configured later.
- **Cross-stream memory**: on `stream.offline`, Groq summarizes the stream into Supabase; last 5 summaries go into the AI system prompt (10-min cache).
- **Bot detection**: `checkNewUser()` on each new chatter; IDs checked against twitchbots.info; confirmed bots banned via Helix (except while dry run is on, and never whitelisted ones); verified IDs cached in-process.
- **Per-user conversation memory**: `handleQuestion` and `checkPatternMatch` keep up to 5 turns per user (1 h TTL, max 200 users).
- **Groq models**: Groq decommissions models often (all `llama-3.x`/`llama-4` and `groq/compound` return 404 `model_not_found` since sep/2026). Check `GET https://api.groq.com/openai/v1/models` before changing `GROQ_MODEL*`. gpt-oss are reasoning models: without `reasoning_effort: 'low'` they exhaust `max_tokens` and return empty `content` (`finish_reason: 'length'`) — `groqWithRetry()` sets it and adds 64 tokens of headroom.

## Conventions

- **State mutable**: toda variable de estado compartida entre funciones vive en `src/utils/state.js`. Nunca declarar estado mutable en los handlers.
- **require() al inicio**: agrupados core Node → npm → módulos propios. Excepción: dependencias circulares conocidas (`eventsub` ↔ `ai`, `alerts` ↔ `ai`), lazy dentro de la función.
- **Caché in-memory**: para evitar queries repetidas a Supabase usar `Map` con TTL (patrón `fullContextCache` / `userFactsCache`, TTL 5 min en `ai/handler.js`). Sin dependencias externas.
- **Mensajes al chat**: los textos en español que llegan al chat van en `config/messages.json`. Excepción: errores internos y logs.
- **truncate() obligatorio**: todo `client.say()` con contenido dinámico o de `config/` pasa por `truncate()` (límite 500 caracteres de Twitch). Sin excepción.
- **Map con TTL → setInterval de pruning**: todo `Map` indexado por usuario/ID con TTL declara su `setInterval` de limpieza justo después (ver `chisteCooldowns`, `questionCooldowns`, `userFactsCache`).
- **Supabase**: el bot usa la clave secreta (service role) y todas las tablas tienen RLS activado sin políticas; nunca volver a la clave anon ni añadir políticas permisivas.
