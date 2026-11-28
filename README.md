# troy-advanced

**Terminal-native, EC2-ready, ASCII-rendered AI browser — deeply integrated with the Troy Agent Socket, MCP, and streaming pipes.**

`troy-advanced` brings [Troy](https://github.com/velofy/troy)'s agent-native browser contract (opaque `eN` element refs, deterministic safety refusals, delta reads, persistent page memory, and token-authenticated `agent-endpoint.json`) into **headless terminals, SSH sessions, Docker containers, and AWS EC2 instances** — with zero X11/Electron overhead and a native **ASCII visual rendering layer** so even text-only AI models can see and drive any page inside pure ASCII.

## Why troy-advanced?

| Capability | Classic GUI Browser | `troy-advanced` |
|---|---|---|
| Runs on bare EC2 / SSH / tmux (no display) | Needs Xvfb / Electron | Native headless CDP + zero-Chrome Lite fallback |
| AI can inspect pages in pure 7-bit ASCII | No | Spatial DOM-to-ASCII viewport with inline `[e1]`..`[eN]` ref badges |
| Text-only AI can "see" rendered pixels/charts | No (needs vision tokens) | Pure-Node PNG decoder -> ASCII / Braille / Half-Block + Set-of-Marks `[eN]` overlays |
| Troy Agent Socket compatibility | Desktop only | 100% compatible `agent-endpoint.json` (`--compat-troy`) |
| Native AI integration protocols | Wrapper needed | Troy HTTP Agent Socket + MCP stdio server + Streaming NDJSON/ASCII Pipe REPL |
| Zero native addon compilation on ARM64 EC2 | Often fails | Pure TypeScript + Node 22+ native `WebSocket` & `zlib` |

## Quickstart

```bash
npm install
npm run build

# Check your terminal / EC2 environment
node bin/troy-advanced.mjs doctor

# One-shot pure ASCII render of any page
node bin/troy-advanced.mjs ascii https://example.com

# One-shot visual screenshot rendered as ASCII art with Set-of-Marks [eN] overlays
node bin/troy-advanced.mjs visual https://example.com --annotate

# Interactive ASCII terminal browser (works over SSH / tmux)
node bin/troy-advanced.mjs browse https://example.com --ascii
```

## Daemon & Deep AI Integration

### 1. Troy-Compatible Background Daemon (works with Dexter's `troy` tool & `troy` CLI)

```bash
# Start headless daemon (writes agent-endpoint.json with 0o600 permissions)
node bin/troy-advanced.mjs daemon start --compat-troy

# Drive it from CLI or any agent
node bin/troy-advanced.mjs open https://news.ycombinator.com --ascii
node bin/troy-advanced.mjs find "login"
node bin/troy-advanced.mjs click e4
node bin/troy-advanced.mjs read --since
node bin/troy-advanced.mjs recall "search"
node bin/troy-advanced.mjs daemon stop
```

### 2. Native MCP Server (Claude Code, Dexter, Codex, Cursor)

```bash
node bin/troy-advanced.mjs mcp --engine auto
```

Exposes `troy_open`, `troy_tabs`, `troy_read_ascii`, `troy_screenshot_ascii`, `troy_find`, `troy_click`, `troy_fill`, `troy_act`, `troy_grant`, and `troy_recall` over JSON-RPC 2.0 stdio.

### 3. Streaming AI Pipe REPL (`stdin` -> `stdout`)

```bash
printf "open https://example.com\nascii 80\nfind more\nquit\n" | node bin/troy-advanced.mjs pipe
```

Supports both plain ASCII commands (`open`, `ascii`, `visual`, `click e3`, `fill e4 hello`) and structured NDJSON (`{"cmd":"read_ascii","width":90}`).

### 4. EC2 & Docker Deployment

```bash
# Bootstrap Chromium + Node on Ubuntu or Amazon Linux 2023 EC2
bash deploy/ec2-bootstrap.sh

# Or build and run via Docker
docker build -t troy-advanced .
docker run --rm -it troy-advanced ascii https://example.com
```

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architecture specification and ASCII system diagrams, and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the Agent Socket, SSE, WebSocket, MCP, and Pipe REPL wire protocol contracts.

- `src/engine/chromium.ts` + `src/engine/cdp-client.ts`: Zero-Playwright raw CDP WebSocket engine on Node 22+ native `WebSocket` with EC2-hardened Chrome flags and persistent profile directories.
- `src/engine/lite.ts`: Built-in pure-Node HTML/DOM + CookieJar + Form engine for ultra-minimal EC2 instances (`t4g.nano`) or offline tests without Chrome.
- `src/ascii/layout.ts`: Spatial DOM-to-ASCII & ANSI viewport renderer with inline `[eN]` badges.
- `src/ascii/png-decoder.ts` + `src/ascii/pixels.ts`: Pure-Node PNG decoder + ASCII luminance / Unicode Braille / ANSI half-block screenshot renderer with Set-of-Marks `[eN]` overlays.
- `src/agent/`: Troy's deterministic safety policy (`policy.ts`), scheme refusal & tracker stripping (`omnibox.ts`), opaque `eN` ref registry (`elements.ts`), persistent page memory (`memory.ts`), and `--since` structural diff (`delta.ts`).
- `src/bridge/`: Token-authenticated loopback HTTP Agent Socket (`agent-socket.ts`) + atomic `0o600` `agent-endpoint.json` (`endpoint.ts`) + SSE `/stream`.
- `src/mcp/server.ts`, `src/pipe/repl.ts`, `src/tui/terminal-browser.ts`: Deep terminal & AI agent frontends.
- `scripts/continue-cron.mjs`: 10-minute OS crontab autonomous iteration watchdog (runs at least 100 `continue` cycles).

## Development & Tests

```bash
npm run typecheck
npm run build
npm test
```

## License

MIT
