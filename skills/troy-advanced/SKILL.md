---
name: troy-advanced
description: >-
  Terminal-native, EC2-ready, ASCII-rendered AI browser with headless Chromium
  CDP and zero-Chrome Lite engines, opaque [eN] element refs, Set-of-Marks ASCII
  screenshots, Troy Agent Socket, MCP stdio server, and streaming Pipe REPL. Use
  when browsing, inspecting, or automating web pages from SSH, tmux, Docker, or
  headless Linux/EC2 environments.
version: "0.1.0"
license: MIT
compatibility:
  - claude-code
  - dexter
  - codex
  - mcp
triggers:
  - "troy-advanced"
  - "ascii browser"
  - "headless browser"
  - "ec2 browser"
  - "browse in terminal"
  - "open url"
  - "inspect webpage"
  - "fill web form"
  - "screenshot ascii"
  - "troy mcp"
---

# troy-advanced

Drive any web page from a headless terminal, SSH session, Docker container, or AWS EC2 instance using **strict 7-bit ASCII viewports** with inline `[eN]` interactive element refs, **Set-of-Marks ASCII/Braille screenshots**, **deterministic safety refusals**, and native **MCP / Troy Agent Socket / Pipe REPL** protocols.

## Quick Decision Guide

| Situation | Recommended Mode |
|---|---|
| Agent already connected via MCP (Claude Code, Dexter, Codex, Cursor) | Call `troy_*` MCP tools directly (configured in `.mcp.json`) |
| Shell / CLI workflow or shared background session | Run `troy-advanced daemon start` and use CLI subcommands |
| One-shot page inspection without starting a daemon | `troy-advanced ascii <url>` or `troy-advanced markdown <url>` |
| Scripted multi-step stdin/stdout streaming | `troy-advanced pipe` (plain commands or `--json` NDJSON) |
| Interactive human/agent debugging in tmux/SSH | `troy-advanced browse [url] --ascii --split` |
| Ultra-low-RAM EC2 (`t4g.nano`) or no Chromium installed | Add `--engine lite` (pure-Node HTML/DOM + CookieJar + forms) |

## Core Workflow: Read -> Act -> Verify

Always inspect the current page before acting so `[eN]` refs are fresh for the current DOM epoch.

```bash
# 1. Start background daemon (writes 0o600 agent-endpoint.json; add --compat-troy for Troy compatibility)
troy-advanced daemon start --engine auto --compat-troy

# 2. Open a page and inspect strict 7-bit ASCII viewport with [eN] refs
troy-advanced open https://example.com --ascii

# 3. Search interactive elements or read compact/delta viewports to save tokens
troy-advanced find "sign in"
troy-advanced ascii --density compact --layout auto
troy-advanced read --since

# 4. Act on opaque [eN] refs (sensitive fields & unapproved submits are safely refused)
troy-advanced fill e3 "alice@example.com"
troy-advanced click e5 --allow-submit

# 5. Wait for SPA hydration or conditions, then verify via delta read
troy-advanced wait --text "Dashboard" --timeout 5000
troy-advanced ascii --since

# 6. Stop daemon when finished
troy-advanced daemon stop
```

## Key CLI Commands

- **Rendering & Export**
  - `troy-advanced ascii [--since] [--width N] [--height N] [--density compact|normal|wide] [--layout flow|spatial|auto] [--crop x,y,w,h] [--ref eN]`
  - `troy-advanced markdown [--frontmatter] [--no-refs] [--no-urls] [--media] [--ascii] [--crop x,y,w,h] [--ref eN]`
  - `troy-advanced visual [--mode ascii|edge|braille|halfblock] [--annotate] [--crop x,y,w,h] [--ref eN]`
- **Navigation & Interaction**
  - `troy-advanced open <url|query>`, `tabs`, `read`, `find <query>`, `click <ref> [--allow-submit]`, `fill <ref> <text> [--clear]`, `select <ref> <value>`, `press <key> [--ref eN]`, `scroll [up|down|top|bottom] [amount]`, `back`, `forward`, `reload`, `act <json-steps> [--allow-submit]`
  - `troy-advanced wait [ms] [--text <str>] [--selector <css>] [--url <pattern>] [--state visible|hidden|attached] [--timeout <ms>]`
- **Autonomy & Cross-Session Memory**
  - `troy-advanced grant <origin>` — extend session origin autonomy boundary
  - `troy-advanced recall <query>` / `forget [origin]` — query or clear persistent page memory
- **Debugging, Emulation & EC2 Session Transfer**
  - `troy-advanced network [--body <reqId>] [--failed] [--blocked] [--method <M>] [--url-filter <str>]`
  - `troy-advanced console` / `eval <expr>`
  - `troy-advanced downloads [--blocked] [--mode quarantine|deny|allow] [--remove <id>]`
  - `troy-advanced dialogs [--type alert|confirm|prompt|beforeunload] [--mode dismiss|accept] [--next accept|dismiss]`
  - `troy-advanced emulate [desktop|mobile|terminal|WxH] [--user-agent <ua>] [--header "K: V"]`
  - `troy-advanced cookies export|import|clear` & `storage inspect|export|import|clear` (supports AES-256-GCM `--encrypt` for EC2 transfer)
  - `troy-advanced doctor [--json]` & `ec2 setup`

## MCP Server Integration

Start the native JSON-RPC 2.0 stdio MCP server (auto-detects both `Content-Length` framed and NDJSON line-delimited clients):

```bash
troy-advanced mcp --framing auto --engine auto
```

Bundled configuration files in this skill directory:
- `.mcp.json` — ready-to-use MCP server declaration (`npx -y @anishfyi/troy-advanced mcp --engine auto`)
- `.claude-plugin/plugin.json` — Claude Code plugin manifest

### MCP Tools

| Tool | Purpose |
|---|---|
| `troy_open` | Open a new browser tab at a URL or search query |
| `troy_tabs` | List open browser tabs and active tab ID |
| `troy_read_ascii` | Render active/target tab as strict 7-bit ASCII (`density`, `layout`, `crop`, `ref`, `showMediaSummary`, `since`) |
| `troy_read_markdown` | Export tab as CommonMark/GFM Markdown with inline `[eN]` refs |
| `troy_screenshot_ascii` | Capture Chromium PNG screenshot as `ascii`, `edge` (Sobel wireframe), `braille`, or `halfblock` with optional `[eN]` overlays |
| `troy_find` | Find interactive elements matching a query and return `eN` refs |
| `troy_click` | Click an element ref (`allowSubmit: true` required for submit/commit actions) |
| `troy_fill` | Fill an input ref (`clear: true` to replace existing text) |
| `troy_wait` | Wait for `text`, CSS `selector` (`visible`/`hidden`/`attached`), `url`, SPA `settle`, or `ms` |
| `troy_act` | Execute an ordered batch of actions (`click`/`fill`/`select`/`press`/`scroll`/`wait`/`read_ascii`) |
| `troy_grant` | Grant an `http(s)` origin to the session autonomy boundary |
| `troy_recall` | Search persistent cross-session page memory |
| `troy_emulate` | Inspect or set viewport presets (`desktop`, `mobile`, `terminal`, `WxH`), User-Agent, and custom headers |
| `troy_downloads` | Inspect intercepted/quarantined/blocked downloads or update download policy |
| `troy_dialogs` | Inspect captured JS dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) or configure auto-handling |
| `troy_network` | List captured HTTP requests (`req-N`) or inspect headers and body for a specific `requestId` |

### MCP Resources & Prompts

- **Resources**
  - `troy://tabs` (`application/json`) — open tabs, active tab ID, and engine metadata
  - `troy://active/ascii` (`text/plain`) — live strict 7-bit ASCII viewport of the active tab
  - `troy://memory/stats` (`application/json`) — persistent page memory counts and status
- **Resource Templates**
  - `troy://tabs/{tabId}/ascii` (`text/plain`) — ASCII viewport for a specific numeric tab ID
- **Prompts**
  - `browse_and_extract` (`url`, optional `goal`, `density`) — navigate, render in ASCII, and extract structured facts
  - `fill_form_safely` (`url`, optional `fields`, `allowSubmit`) — inspect form refs, fill non-sensitive fields, and pause before submit

## Streaming Pipe REPL

```bash
printf "open https://example.com\nascii 80\nfind more\nquit\n" | troy-advanced pipe
```

Use `--json` for structured NDJSON commands such as `{"cmd":"read_ascii","width":90}`.

## Safety & Token-Budget Guardrails

1. **Read before acting**: Always call `troy_read_ascii` or `troy_find` before `troy_click`/`troy_fill` so refs match the active page epoch.
2. **Use delta reads**: Pass `since: true` (`--since`) after interactions to receive only `+`/`-`/`~` structural changes and minimize context tokens.
3. **Use compact density on large pages**: Pass `density: "compact"` or `crop` / `ref` zoom when inspecting dense pages or charts.
4. **Respect deterministic refusals**:
   - Never attempt to bypass sensitive-field refusals (passwords, OTPs, payment inputs).
   - Only pass `allowSubmit: true` / `--allow-submit` when the user has explicitly authorized submitting or committing the action.
   - Use `troy_grant` only for trusted `http(s)` origins required by the task.
5. **Prefer remote CDP or Lite when appropriate**: Pass `--cdp-url ws://...` to attach to an existing Chrome instance over SSH, or `--engine lite` when Chromium is unavailable.
