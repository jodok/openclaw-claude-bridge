# openclaw-claude-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-CLI-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)

[繁體中文](README.zh.md) | English

An OpenAI-compatible HTTP proxy that lets [OpenClaw](https://github.com/openclaw/openclaw) agents use Claude through [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — with tool calling, session memory, and extended thinking.

> **Fork note:** This is a maintained fork of [shinglokto/openclaw-claude-bridge](https://github.com/shinglokto/openclaw-claude-bridge) with stability and robustness improvements cherry-picked from multiple community forks.

---

## What's New in This Fork

Improvements integrated from community forks (Kyzcreig, Patinado, ymat19):

### Reliability & Stability
- **Channel serialization** — 1 request at a time per channel with a lock queue, preventing duplicate CLI sessions from parallel requests
- **SSE keepalive** — sends an empty-choices chunk every 15s to prevent OpenClaw idle timeout disconnects
- **Auto-compact prompt** — if a prompt exceeds 600K chars, it is automatically compacted before sending to Claude CLI
- **Session purge on error** — broken CLI sessions are purged instead of retrying on corrupted state, preventing cascading failures
- **Truncate on retry** — if even the compacted prompt is still too large, it is truncated to prevent infinite retry loops
- **Session title intercept** — OpenClaw's "generate a 1-2 word filename slug" prompts are intercepted before session routing, so they don't poison per-channel sessions and trap them in title-generation loops
- **Empty response rejection** — if Claude CLI exits with output_tokens=0 and empty text, the bridge rejects with a clear error instead of silently returning empty content
- **Persisted scrub maps** — `sessionAliasMap` and `sessionTokenMaps` are saved in `state.json` and restored on startup, so live Claude CLI sessions surviving a bridge restart can still have their scrubbed tokens (`[[<word>_<word>_<hex>]]`) mapped back to the originals
- **Orphan scrub tag strip** — defensive removal of `[[<word>_<word>_<hex>]]` tags that survive `restoreInbound`, preventing bridge-internal alias text (e.g. `[[sync_proc_9685]]`) from leaking into final responses to OpenClaw

### Tool Handling
- **Tool call filtering** — filters out hallucinated tool calls that don't exist in the available tools list, with warning logs
- **Tool profile filtering** — gateway-internal tools are filtered before reaching Claude
- **Suppress pre-tool text** — in streaming mode, partial assistant prose before tool_calls is suppressed to avoid spurious text during tool loops
- **Tool call JSON recovery** — re-escapes raw `\n` `\r` `\t` inside JSON string literals so multi-line tool_call payloads parse instead of being dropped

### Security
- **`--strict-mcp-config`** — blocks host MCP servers from leaking into the bridge session, preventing context pollution and reducing token usage
- **Bridge markup fail-closed** — if internal `<tool_call>`/`<tool_result>`/`<tool_thinking>`/`<previous_response>` tags survive parsing, the response is suppressed instead of leaking raw markup to the end user
- **Sensitive log redaction** — `sk-*` keys, `*_API_KEY=…`, `token=…`, `password=…` are masked in warning previews

### Reasoning
- **Reasoning streaming** — Claude's `thinking` blocks are streamed as `reasoning_content` SSE deltas in OpenAI-compatible format, so OpenClaw can surface reasoning previews in real time on Discord/Telegram
- **Per-model reasoning skip** — models that don't support extended thinking (e.g. Haiku) automatically skip the `reasoning_effort` override, preventing silent CLI errors

### Diagnostics
- **Stderr capture** — captures the last 20 stderr lines from Claude CLI for better diagnostics on exit code failures
- **Error classification** — separate statuses for `idle_timeout`, `hard_timeout`, `cli_exit`, and `oc_disconnect` instead of generic "error"
- **Usage availability flag** — log entries now indicate whether usage data was actually returned by CLI
- **Scrub pattern fix** — removed false positive scrubbing of `sessions_*` tool names

---

## Why This Exists

OpenClaw speaks the OpenAI API format. Claude Code CLI speaks its own format. This bridge sits in between and translates — so your OC agents can talk to Claude without either side needing to change.

```
  OpenClaw agent                  Bridge                     Claude CLI
  (Discord/Telegram)
        │                           │                              │
        │  POST /v1/chat/           │                              │
        │  completions              │  Translate messages           │
        ├──────────────────────────▶│  Inject tool protocol        │
        │                           │  Map thinking level          │
        │                           │                              │
        │                           │  stdin ──▶ claude --print    │
        │                           │  stdout ◀── stream-json      │
        │                           │                              │
        │  SSE stream               │  Parse response:             │
        ◀──────────────────────────│  ├─ text → clean output      │
        │                           │  └─ <tool_call> → OpenAI fmt │
        │                           │                              │
        │  tool_calls?              │                              │
        │  Yes → OC runs tools      │                              │
        │  No  → answer to user     │                              │
```

**Key principle:** The bridge never executes tools. It only translates. OpenClaw owns the tool loop.

---

## Quick Start

```bash
# 1. Clone and install (also builds the dashboard automatically)
git clone https://github.com/adfdev/openclaw-claude-bridge.git
cd openclaw-claude-bridge
npm install

# 2. Configure
cp .env.example .env
# Edit .env — review settings, change DASHBOARD_PASS

# 3. Make sure Claude CLI is installed and logged in
claude --version
claude auth status

# 4. Start
npm start

# 5. Health check
curl http://localhost:3456/health
```

---

## How It Works

### Request Flow

1. **OpenClaw** sends a standard OpenAI chat completion request (messages, tools, model)
2. **Bridge** translates the messages into Claude CLI's text format and injects tool-calling instructions into the system prompt
3. **Claude CLI** processes the request and streams back a response
4. **Bridge** parses the response — if Claude wants to call a tool, it converts the `<tool_call>` XML into OpenAI's `tool_calls` format; otherwise it returns clean text
5. **OpenClaw** either executes the requested tools and sends another request, or delivers the final answer to the user

### Session Memory

Each agent in each conversation gets its own persistent Claude CLI session. This means Claude remembers previous messages without the bridge needing to resend the full history every time.

```
Discord #general — two agents sharing the same channel:

  researcher (first message)  → new session created (session-aaa)
  helper-bot (first message)  → new session created (session-bbb)
  researcher (second message) → resumes session-aaa (only sends new messages)
  user runs /new in OC        → old session purged, fresh one created
```

The routing key is `channel + agent name`, so agents in the same channel never interfere with each other.

Session state survives restarts — mappings and request history are saved to `state.json` and restored on startup. Stale sessions (where the CLI session file no longer exists) are automatically pruned.

For more details on the three-tier session lookup and edge cases, see [docs/architecture.md](docs/architecture.md).

### Tool Calling

The bridge reads the `tools` array from OpenClaw's request and dynamically generates tool-calling instructions that get injected into Claude's system prompt. Claude outputs `<tool_call>` XML blocks, which the bridge converts into standard OpenAI `tool_calls`.

This means any new tools added in OpenClaw are automatically available to Claude — no bridge changes needed.

Claude's native tools (Bash, Read, Write, etc.) are disabled via `--tools ""` so it can only call tools through OpenClaw's gateway. Host MCP servers are blocked via `--strict-mcp-config` to prevent context pollution.

**Tool call validation:** If Claude hallucinates a tool that doesn't exist in the available tools list, the bridge filters it out and logs a warning instead of forwarding the invalid call.

### Channel Serialization

Requests for the same channel are serialized — only one request runs at a time per channel. This prevents race conditions where parallel requests could create duplicate CLI sessions. A lock queue ensures requests are processed in order.

### SSE Keepalive

During long-running requests, the bridge sends an empty-choices SSE chunk every 15 seconds. This prevents OpenClaw's idle timeout from killing the connection while Claude is still thinking.

### Extended Thinking

The bridge supports Claude's extended thinking via the `reasoning_effort` parameter:

| `reasoning_effort` | Claude CLI `--effort` | Behaviour |
|---|---|---|
| *(not set)* | *(default)* | Thinking OFF |
| `minimal` / `low` | `low` | Quick intuition |
| `medium` | `medium` | Moderate reasoning |
| `high` / `xhigh` | `high` | Deep step-by-step |

When `reasoning_effort` is not provided, thinking is disabled entirely (`MAX_THINKING_TOKENS=0`).

Models that don't support thinking (e.g. Haiku) automatically skip the reasoning effort override.

When thinking is active, the bridge streams Claude's `thinking` blocks as `reasoning_content` SSE deltas in OpenAI-compatible format — so OpenClaw can show reasoning previews in real time on channels like Discord and Telegram.

### Error Recovery

The bridge has multi-layer error handling:

- **Auto-compact on overflow:** If a prompt is too large for a new session (>600K chars), it is automatically compacted
- **Retry with compact refresh:** If a resumed CLI session fails, the bridge purges the broken session and retries with compacted history
- **Truncation safety net:** If even the compacted prompt is too large, it is truncated to prevent infinite loops
- **Error classification:** Different error types (`idle_timeout`, `hard_timeout`, `cli_exit`, `oc_disconnect`) are tracked separately for better diagnostics

---

## Dashboard

The bridge includes a React dashboard accessible at `http://<server-ip>:3458/`.

![Dashboard screenshot](docs/dashboard-screenshot.png)

**Header bar** — live metrics across the top: online/offline status, uptime, total requests, active requests, total cost, session count + disk size, error count, available tools, and a dark/light theme toggle.

**Agent sidebar** — lists all agents sorted by recency. Each shows an activity indicator (green if active in last 5 min, amber if 30 min, gray if idle), session count, request count, and cost. Selecting an agent filters all panels. On mobile, collapses to a horizontal pill bar.

**Live activity feed** — real-time event stream with emoji-coded messages: 🧠 thinking, 🔧 tool calls, 🔄 resume, ♻️ context refresh, ✅ done, ❌ error. Shows relative timestamps and agent/channel labels.

**Context cards** — per-session context window usage with progress bars. Color-coded: green (<40%), amber (40–65%), red (>65%). Each card shows session ID, agent, token counts, and cost.

**Request table** — 13-column table showing every request: time, channel, session (color-coded), resume method (emoji badges: 🔧 Tools, 💬 Chat, 🆕 New, ♻️ Refresh, etc.), prompt size, model, thinking level, input/output tokens, cost, cache hit rate, duration, and status. Rows expand to show activity logs and errors. Supports channel and resume method filtering, and pagination.

**Session cleanup** — one-click button to delete CLI sessions older than 24 hours.

**Password protection:** Set `DASHBOARD_PASS` in your environment to enable HTTP Basic Auth (user: `admin`). If not set, the dashboard is open.

For detailed architecture of the dashboard, see [docs/architecture.md](docs/architecture.md#dashboard).

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DASHBOARD_PASS` | No | — | Dashboard password (Basic Auth, user: `admin`) |
| `OPUS_MODEL` | No | `opus` | CLI model alias for Opus (use `opus[1m]` for 1M context) |
| `SONNET_MODEL` | No | `sonnet` | CLI model alias for Sonnet (use `sonnet[1m]` for 1M context) |
| `HAIKU_MODEL` | No | `haiku` | CLI model alias for Haiku |
| `IDLE_TIMEOUT_MS` | No | `120000` | Kill CLI subprocess after this many ms of no output |
| `OPENCLAW_BRIDGE_PORT` | No | `3456` | API server port |
| `OPENCLAW_BRIDGE_STATUS_PORT` | No | `3458` | Dashboard port |
| `CLAUDE_BIN` | No | `claude` | Path to Claude Code CLI binary |
| `MAX_GLOBAL` | No | `20` | Max concurrent requests globally |

> **Note:** `MAX_PER_CHANNEL` is no longer configurable — channels are serialized (1 request at a time) to prevent session duplication.

### Ports

| Port | Bind | Purpose |
|---|---|---|
| `3456` | `127.0.0.1` | OpenAI-compatible API (localhost only) |
| `3458` | `0.0.0.0` | Dashboard (LAN accessible) |

---

## OpenClaw Setup

Add this provider to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "models": {
    "providers": {
      "claude-bridge": {
        "baseUrl": "http://localhost:3456/v1",
        "apiKey": "not-needed",
        "api": "openai-completions",
        "models": [
          {
            "id": "claude-opus-latest",
            "name": "Claude Opus",
            "contextWindow": 1000000,
            "maxTokens": 128000,
            "reasoning": true
          },
          {
            "id": "claude-sonnet-latest",
            "name": "Claude Sonnet",
            "contextWindow": 1000000,
            "maxTokens": 64000,
            "reasoning": true
          }
        ]
      }
    }
  }
}
```

Then assign the model to your agent. The `apiKey` can be any non-empty string — the bridge doesn't check it.

---

## Service Setup (Auto-Start on Boot)

### macOS (launchd)

```bash
# Recommended: auto-detects paths, reads .env, generates plist
./service/install-mac.sh
```

Manual management:

```bash
# Status
launchctl list | grep openclaw-claude-bridge

# Restart (reload plist config)
launchctl bootout gui/$(id -u)/com.openclaw.claude-bridge
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-bridge.plist

# Logs
tail -f ~/openclaw-claude-bridge/bridge.log
```

### Linux (systemd)

```bash
cp service/openclaw-claude-bridge.service ~/.config/systemd/user/
# Edit the file if your project path differs from ~/openclaw-claude-bridge
systemctl --user daemon-reload
systemctl --user enable --now openclaw-claude-bridge
loginctl enable-linger $USER  # start at boot without login
```

```bash
systemctl --user status openclaw-claude-bridge
journalctl --user -u openclaw-claude-bridge -n 50
systemctl --user restart openclaw-claude-bridge
```

---

## API Reference

| Method | Path | Port | Description |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | 3456 | OpenAI-compatible chat completions (SSE or JSON) |
| `GET` | `/v1/models` | 3456 | Available model list |
| `GET` | `/health` | 3456 | Health check → `{"status":"ok"}` |
| `GET` | `/status` | 3458 | Runtime stats JSON (uptime, requests, sessions, activity) |
| `POST` | `/cleanup` | 3458 | Delete CLI sessions older than 24h |
| `GET` | `/` | 3458 | Dashboard (React SPA) |

---

## Project Structure

```
openclaw-claude-bridge/
├── src/
│   ├── index.ts         Entry point, HTTP servers, graceful shutdown
│   ├── server.ts        Request handling, session management, state persistence
│   ├── claude.ts        CLI subprocess, stream parsing, thinking/effort mapping
│   ├── tools.ts         Dynamic tool protocol builder + tool filtering
│   ├── convert.ts       OpenAI message format → Claude CLI text format
│   └── types.ts         Shared TypeScript type definitions
├── dashboard/           React/TypeScript/Tailwind dashboard (Vite)
│   ├── src/             Components, hooks, lib, types
│   ├── dist/            Production build (npm run build)
│   └── package.json
├── service/
│   ├── openclaw-claude-bridge.service     Linux systemd user service
│   ├── com.openclaw.claude-bridge.plist   macOS launchd agent (template)
│   └── install-mac.sh                    macOS one-line installer
├── docs/                Technical documentation
├── .env.example         Environment variable template
├── state.json           Runtime state (auto-generated, gitignored)
└── package.json
```

---

## Security

- **Port 3456** binds to localhost only — not reachable from outside the machine
- **Port 3458** is LAN-accessible, protected by HTTP Basic Auth when `DASHBOARD_PASS` is set
- **`--tools ""`** disables all Claude native tools — no host command execution
- **`--strict-mcp-config`** disables all MCP servers — no host MCP leak into the bridged session
- **`--dangerously-skip-permissions`** is required for headless operation (no terminal to prompt for confirmation; safe because native tools are disabled)
- **`.env`** contains secrets and is gitignored

---

## Documentation

- [Architecture Deep Dive](docs/architecture.md) — session lookup, token caching, state persistence
- [README 繁體中文](README.zh.md)

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | >= 18 | Runtime |
| Claude Code CLI | latest | Must be logged in (`claude auth login`) |
| OpenClaw | >= 2026.1 | Gateway on port 18789 |

**Platforms:** macOS (Apple Silicon / Intel), Linux (x64 / ARM)

---

## Credits

Based on [shinglokto/openclaw-claude-bridge](https://github.com/shinglokto/openclaw-claude-bridge). Community improvements from:
- [Kyzcreig](https://github.com/Kyzcreig/openclaw-claude-bridge) — tool call filtering, MCP isolation, scrub fixes, session-title intercept, JSON recovery, markup fail-closed
- [Patinado](https://github.com/Patinado/openclaw-claude-bridge) — channel serialization, SSE keepalive, error recovery
- [ymat19](https://github.com/shinglokto/openclaw-claude-bridge/pull/10) — `--strict-mcp-config` PR

---

## Disclaimer

This project is an independent, community-built tool and is not affiliated with or endorsed by Anthropic. Users are responsible for ensuring their usage complies with [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms).
