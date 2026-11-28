# troy-advanced Architecture

`troy-advanced` is a terminal-native, EC2-ready, ASCII-rendered AI browser built on pure TypeScript and Node.js 22+ (zero native addons, zero Playwright/Electron runtime dependencies). It implements the Troy Agent Socket contract alongside native MCP, Streaming Pipe REPL, and Interactive ASCII TUI frontends, backed by dual headless browser engines (raw Chromium CDP and a zero-Chrome Lite engine).

---

## 1. High-Level System Architecture

```text
+------------------------------------------------------------------------------------------------+
|                                FRONTENDS & CLIENT INTERFACES                                   |
|                                                                                                |
|  +---------------+  +-------------------+  +---------------------+  +-----------------------+  |
|  | CLI           |  | Interactive TUI   |  | MCP Server (stdio)  |  | Streaming Pipe REPL   |  |
|  | src/cli.ts    |  | src/tui/          |  | src/mcp/server.ts   |  | src/pipe/repl.ts      |  |
|  | bin/troy-...  |  | raw-mode / tmux   |  | JSON-RPC 2.0        |  | ASCII cmds & NDJSON   |  |
|  +-------+-------+  +---------+---------+  +----------+----------+  +-----------+-----------+  |
|          |                    |                       |                         |              |
+----------+--------------------+-----------------------+-------------------------+--------------+
           |                    |                       |                         |
           | HTTP / SSE / WS    | in-process            | in-process              | in-process
           v                    v                       v                         v
+------------------------------------------------------------------------------------------------+
|                            BRIDGE & TRANSPORT LAYER (src/bridge/)                              |
|                                                                                                |
|  127.0.0.1 HTTP Agent Socket (agent-socket.ts)  |  SSE /stream (sse-stream.ts)                 |
|  WebSocket /ws (ws-bridge.ts)                   |  Health & /metrics (metrics.ts)              |
|  Guards: Host/DNS Rebinding (host-guard.ts) -> Timing-Safe Auth (auth.ts) -> Rate Limit        |
|  Discovery: Atomic 0o600 agent-endpoint.json (+ optional --compat-troy mirror) (endpoint.ts)   |
+-----------------------------------------------+------------------------------------------------+
                                                |
                                                v
+------------------------------------------------------------------------------------------------+
|                         CONTROL PLANE & SAFETY PIPELINE (src/engine/manager.ts)                |
|                                                                                                |
|  BrowserManager                                                                                |
|  +------------------------+  +--------------------------+  +--------------------------------+  |
|  | Session & Tab Isolation|  | Defense-in-Depth Guards  |  | Intelligence & State           |  |
|  | - sessions.ts          |  | - readonly.ts            |  | - elements.ts (e1..eN + recov) |  |
|  | - x-troy-session       |  | - policy-profile.ts      |  | - memory.ts & recall-bind.ts   |  |
|  | - ownedTabIds          |  | - policy.ts              |  | - delta.ts (--since diff)      |  |
|  | - origin scopes        |  | - ssrf.ts / omnibox.ts   |  | - find.ts / extract.ts         |  |
|  |                        |  | - loop-guard.ts          |  | - flow-runner.ts (macros)      |  |
|  |                        |  | - secret-redactor.ts     |  | - audit.ts (audit.jsonl)       |  |
|  |                        |  | - untrusted-markers.ts   |  |                                |  |
|  +------------------------+  +--------------------------+  +--------------------------------+  |
+---------------------+----------------------------------------------------+---------------------+
                      |                                                    |
                      v                                                    v
+---------------------------------------------------+  +-----------------------------------------+
|        DUAL BROWSER ENGINES (src/engine/)         |  |   ASCII VISUAL & LAYOUT (src/ascii/)    |
|                                                   |  |                                         |
|  BrowserEngine interface (src/engine/types.ts)    |  |  DOM -> Spatial 2D ASCII (layout.ts)    |
|  +---------------------+  +--------------------+  |  |  DOM -> Markdown [eN] (markdown.ts)     |
|  | ChromiumEngine      |  | LiteEngine         |  |  |  Delta -> +/-/~ ASCII (delta.ts)        |
|  | chromium.ts         |  | lite.ts            |  |  |  PNG -> Pure-Node decode (png-decoder)  |
|  | cdp-client.ts       |  | cookie-jar.ts      |  |  |  RGBA -> ASCII/Edge/Braille/Halfblock   |
|  | remote-cdp.ts       |  | response-cache.ts  |  |  |          + Set-of-Marks (pixels.ts)     |
|  | tracker-blocker.ts  |  | robots-retry.ts    |  |  |  Sanitizer (sanitize.ts) -> 7-bit ASCII |
|  | shadow-dom/frames   |  | structured/feed/doc|  |  |  Token Budget Trimmer (token-budget.ts) |
|  +---------------------+  +--------------------+  |  +-----------------------------------------+
+---------------------------------------------------+
                      |
                      v
+------------------------------------------------------------------------------------------------+
|                          CLOUD, DAEMON & PERSISTENCE LAYER (src/cloud/)                        |
|                                                                                                |
|  daemon.ts | memory-watchdog.ts | daemon-logs.ts | daemon-config.ts | profiles.ts              |
|  doctor.ts | imds.ts (IMDSv2)   | ec2-tunnel.ts  | docker-compose.ts| bench.ts | ci-workflow   |
|  Profile Dir: daemon.json, policy.json, cookies.json, memory.json, audit.jsonl, quarantine/    |
+------------------------------------------------------------------------------------------------+
```

---

## 2. Design Principles & Core Invariants

1. **Zero Native Addons (Node.js 22+ Stdlib Only):** Uses Node 22's built-in `WebSocket`, `fetch`, `zlib`, `crypto`, and `http` modules. No native C++ compilation (`node-gyp`), making deployment identical on x86_64 and AWS Graviton ARM64 EC2 instances.
2. **Strict 7-Bit ASCII First:** Every page, delta, form, table, and screenshot can be rendered into pure printable 7-bit ASCII (`0x20..0x7E`, `\n`) via `src/ascii/sanitize.ts`, stripping ANSI escape injection, zero-width characters, and non-ASCII glyphs so even text-only models can inspect and drive web applications.
3. **Opaque, Ephemeral `eN` Element Refs:** Agents never need brittle CSS selectors. Every interactive element discovered in a snapshot receives a short opaque ref (`e1`, `e2`, ...) bound to a per-tab navigation epoch in `src/agent/elements.ts`, with deterministic stale-ref recovery when the DOM shifts within the same epoch.
4. **Deterministic Safety Refusals:** Dangerous URL schemes, private/IMDS network targets, password/payment inputs, unapproved form submissions, and read-only mutations fail deterministically with structured refusal codes before reaching the browser engine.
5. **Graceful Engine Selection (`auto`):** `BrowserManager` uses headless Chromium via raw CDP when available (or a remote `--cdp-url`), and falls back seamlessly to the zero-Chrome `LiteEngine` on minimal instances (`t4g.nano`) or offline test environments.
6. **Owner-Only Credentials:** `agent-endpoint.json`, `cookies.json`, and quarantined downloads are written atomically with `0o600` permissions.

---

## 3. Request & Tool Execution Pipeline

Every agent action—whether invoked over the HTTP Agent Socket, WebSocket `/ws`, MCP stdio, Pipe REPL, CLI, or TUI—flows through `BrowserManager` (`src/engine/manager.ts`) in a fixed, auditable sequence:

```text
  Client (CLI / Dexter / Claude / MCP / Pipe / TUI)
    |
    v
  [1. Transport Guards] (when remote via Agent Socket / WS)
    |-- Host header check (src/bridge/host-guard.ts) -> blocks DNS rebinding
    |-- Auth check (src/bridge/auth.ts)              -> crypto.timingSafeEqual(x-troy-agent)
    |-- Rate limiter & body-size cap (src/bridge/rate-limit.ts)
    v
  [2. Session & Scope Resolution] (src/agent/sessions.ts)
    |-- Resolve x-troy-session (optional multi-agent isolation)
    |-- Verify tab ownership & per-session origin scope
    v
  [3. Safety & Policy Pipeline]
    |-- ReadonlyObserverGuard (src/agent/readonly.ts)      -> blocks mutations if --readonly
    |-- PolicyProfileGuard (src/agent/policy-profile.ts)   -> strict | standard | permissive
    |-- authorizeAction (src/agent/policy.ts)              -> origin, sensitive fields, submit
    |-- resolveInput (src/agent/omnibox.ts)                -> scheme allowlist & tracker strip
    |-- SsrfGuard (src/agent/ssrf.ts)                      -> optional --block-private-net / IMDS
    |-- AgentLoopGuard (src/agent/loop-guard.ts)           -> detects repeated failing loops
    v
  [4. Engine Execution] (ChromiumEngine or LiteEngine via BrowserEngine)
    |-- Navigate / Click / Fill / Select / Press / Wait / Settle / Eval / Screenshot
    |-- Capture PageSnapshot (blocks, elements, frames, viewport, console, network)
    v
  [5. State Indexing & Rendering]
    |-- ElementRegistry (src/agent/elements.ts)            -> assign e1..eN + epoch + signatures
    |-- PageMemory (src/agent/memory.ts)                   -> record durable element signatures
    |-- DeltaTracker (src/agent/delta.ts)                  -> compute --since diff
    |-- SecretRedactorGuard (src/agent/secret-redactor.ts) -> mask JWT/AWS/CC when enabled
    |-- UntrustedContentGuard (src/agent/untrusted-markers.ts) -> wrap untrusted page delimiters
    |-- ASCII / Markdown / Pixel Renderer (src/ascii/*)    -> layout, SoM, sanitize, budget
    v
  [6. Observability & Broadcast]
    |-- AuditLogger (src/agent/audit.ts)                     -> append JSONL to audit.jsonl
    |-- MetricsCollector (src/bridge/metrics.ts)             -> latency histograms & counters
    |-- SseBroadcaster (src/bridge/sse-stream.ts)            -> push live ASCII frame to /stream
    v
  Structured JSON / ASCII Response -> Client
```

---

## 4. Layer-by-Layer Deep Dive

### 4.1 Frontends & Protocols

| Frontend | Entrypoint | Transport / Mode | Primary Use Case |
|---|---|---|---|
| **CLI** | `bin/troy-advanced.mjs` -> `src/cli.ts` | One-shot or HTTP client to daemon | Scripting, ops (`doctor`, `bench`, `daemon`, `profile`, `ec2 tunnel`, `run`) |
| **Agent Socket** | `src/bridge/agent-socket.ts` | Loopback HTTP `127.0.0.1` + SSE `/stream` + WS `/ws` | Troy-compatible daemon for Dexter, scripts, multi-agent control |
| **MCP Server** | `src/mcp/server.ts`, `src/mcp/transport.ts` | JSON-RPC 2.0 over stdio (NDJSON & `Content-Length`) | Claude Code, Dexter, Codex, Cursor (tools, `troy://` resources, prompts) |
| **Pipe REPL** | `src/pipe/repl.ts` | `stdin` -> `stdout` line stream | Shell pipelines, text-only agents, NDJSON batching |
| **Interactive TUI** | `src/tui/terminal-browser.ts` | Raw-mode TTY (with non-TTY fallback) | Human & hybrid human+AI browsing over SSH / tmux |
| **Tool Schemas** | `src/mcp/schema.ts` | CLI export (`schema --format ...`) | OpenAI, Anthropic, Gemini, and MCP tool definitions |

#### Interactive TUI Sub-Modules (`src/tui/`)
The TUI is decomposed into focused, headless-testable modules driven by `src/tui/pty-simulator.ts`:
- `terminal-browser.ts`: Main event loop, raw-mode keypress routing (`j/k`, `g/G`, `/`, `:`, `Tab`, `Enter`), viewport scroll, and status bar.
- `inspector.ts`: Split-pane right drawer displaying live Console, Network, Refs, and Agent Activity.
- `link-hints.ts`: Vimium-style `f`-key link-hint jump overlay (`[e1]`..`[e99]`).
- `form-modal.ts`: Inline modal prompt for filling `<input>` and `<select>` elements.
- `command-palette.ts`: Fuzzy `Ctrl+P` command palette.
- `sidebar.ts`: Bookmarks (`b`) and History (`H`) panel.
- `pixel-preview.ts`: Live view-mode cycling (`v`: Layout ASCII -> Pixel ASCII -> Braille -> Halfblock).
- `page-export.ts`: `:save <file>` exporter to `.txt`, `.md`, or `.json`.
- `help-overlay.ts`: `?` modal keybinding reference.
- `resize.ts` & `tty-fallback.ts`: `SIGWINCH` live reflow and safe non-TTY fallback.

---

### 4.2 Bridge & Discovery (`src/bridge/`)

- **Atomic Endpoint Discovery (`src/bridge/endpoint.ts`):**
  When the daemon starts on an ephemeral or configured `127.0.0.1` port, it writes `agent-endpoint.json` atomically (`tmp` + `rename`, mode `0o600`) containing `{ agentPort, agentToken, pid, startedAt, engine, compat }`. With `--compat-troy`, it mirrors the file to Troy's standard desktop path so existing `troy` clients discover it automatically. `readLiveEndpoint()` validates `pidAlive(pid)` to ignore stale files.
- **HTTP Endpoints (`src/bridge/agent-socket.ts`):**
  - Unauthenticated probes (when enabled): `GET /healthz`, `GET /livez`, `GET /readyz`, `GET /metrics` (Prometheus text format via `src/bridge/metrics.ts`).
  - Authenticated control & inspection (`x-troy-agent` header): `GET /health`, `GET /watchdog`, `GET /policy`, `GET /origins`, `GET /sessions`, `GET /stream` (SSE), `Upgrade /ws` (WebSocket bridge via `src/bridge/ws-bridge.ts`), and `POST` routes `/tabs`, `/open`, `/activate`, `/close`, `/grant-origin`, `/ascii`, `/markdown`, `/extract`, `/tool`, `/recall`, `/forget`, `/memory`, `/cookies/*`, `/storage/*`, `/emulation`, `/downloads`, `/dialogs`, `/audit`, `/loop-guard`.
- **Host & Rate Guards (`src/bridge/host-guard.ts`, `src/bridge/rate-limit.ts`, `src/bridge/auth.ts`):**
  Rejects non-loopback `Host` headers (preventing DNS rebinding), validates bearer tokens in constant time (`crypto.timingSafeEqual`), enforces sliding-window rate limits, and caps request body sizes (with a higher cap for `/cookies/import` and `/storage/import`).

---

### 4.3 Dual Browser Engines (`src/engine/`)

Both engines implement the common `BrowserEngine` contract in `src/engine/types.ts`:

```text
                           +---------------------------+
                           |   BrowserEngine Interface |
                           |    (src/engine/types.ts)  |
                           +-------------+-------------+
                                         |
                     +-------------------+-------------------+
                     |                                       |
                     v                                       v
    +---------------------------------+     +---------------------------------+
    |        ChromiumEngine           |     |           LiteEngine            |
    |     (src/engine/chromium.ts)    |     |       (src/engine/lite.ts)      |
    +---------------------------------+     +---------------------------------+
    | - Raw CDP over Node 22 WS       |     | - Zero Chrome; pure Node fetch  |
    |   (cdp-client.ts, remote-cdp.ts)|     | - HTML5 entity & DOM parser     |
    | - EC2-hardened headless flags   |     |   (html-entities.ts)            |
    | - Shadow DOM traversal          |     | - Multipart & hidden CSRF forms |
    |   (shadow-dom.ts)               |     |   (form-encoding.ts)            |
    | - Cross-frame iframe flattening |     | - File-backed CookieJar (0o600) |
    |   (frames.ts)                   |     |   (cookie-jar.ts)               |
    | - Keyboard chords & VK codes    |     | - ETag / If-None-Match cache    |
    |   (keyboard.ts)                 |     |   (response-cache.ts)           |
    | - Tracker blocking via CDP      |     | - Robots & 429/503 exp backoff  |
    |   (tracker-blocker.ts)          |     |   (robots-retry.ts)             |
    | - Dialog auto-capture/dismiss   |     | - JSON/XML tree view            |
    |   (dialogs.ts)                  |     |   (structured-view.ts)          |
    | - Crash detection & relaunch    |     | - RSS/Atom feed reader          |
    |   (crash-recovery.ts)           |     |   (feed-reader.ts)              |
    | - Network body capture          |     | - Plain/MD/CSV renderer         |
    |   (network.ts)                  |     |   (document-view.ts)            |
    | - Shared: wait.ts, settle.ts, cookies.ts, storage.ts, emulation.ts,     |
    |           downloads.ts (quarantine), proxy.ts (HTTP/HTTPS/SOCKS5)       |
    +---------------------------------+     +---------------------------------+
```

#### Shared Engine Capabilities
- **Waiting & Settling (`wait.ts`, `settle.ts`):** Wait for text, CSS selector, URL pattern, or element visibility (`visible|hidden|attached`) with timeout; network-idle + DOM mutation settle detection for SPAs.
- **Session Portability (`cookies.ts`, `storage.ts`):** Export/import cookies, `localStorage`, and `sessionStorage` to hydrate signed-in sessions on remote EC2 instances.
- **Emulation & Proxy (`emulation.ts`, `proxy.ts`):** Viewport presets (`desktop`, `mobile`, `terminal`, custom `WxH`), custom User-Agent/headers, and `http://`/`https://`/`socks5://` proxy routing (respecting `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`).
- **Download Quarantine (`downloads.ts`):** Intercepts auto-downloads into `<profileDir>/quarantine` with opaque filenames and `0o600` non-executable permissions (`quarantine`, `deny`, or `allow` modes).

---

### 4.4 ASCII Visual & Layout Rendering Pipeline (`src/ascii/`)

`troy-advanced` provides two complementary rendering paths—**Structural DOM-to-ASCII** and **Pixel Screenshot-to-ASCII**—both terminating in strict sanitization and optional token-budget fitting:

```text
  PATH A: Structural DOM Pipeline
  -------------------------------
  PageSnapshot (blocks, elements, viewport, frames)
    |
    +--> layout.ts (renderPageAscii)
    |      - 2D spatial grid using element bounding boxes (multi-column & sidebars)
    |      - Auto-aligned ASCII tables (+---+---+ headers)
    |      - Inline [eN: link text] paragraph wrapping
    |      - Form grouping boxes (+-- Form: Login --+)
    |      - Right-edge scrollbar gutter (# thumb on | track)
    |      - Density profiles: compact | normal | wide
    |      - Media & <canvas> ASCII previews (media.ts)
    |
    +--> markdown.ts (renderPageMarkdown)  -> Markdown preserving inline [eN] refs
    +--> delta.ts (renderDeltaAscii)       -> +/-/~ structural diff for --since
    |
    v
  sanitize.ts (strict 7-bit ASCII, ANSI stripping, CJK/emoji/RTL normalization)
    |
    v
  token-budget.ts (--max-tokens N estimator & priority auto-trimmer)


  PATH B: Pixel / Canvas Visual Pipeline
  --------------------------------------
  PNG Buffer (from CDP Page.captureScreenshot or <canvas> data URL)
    |
    v
  png-decoder.ts (pure-Node PNG decoder: zlib inflate, filter un-apply,
                  1/2/4/8/16-bit depths, palette + tRNS transparency -> RGBA)
    |
    v
  pixels.ts (renderRgbaToAscii)
    |-- Optional region crop (--crop x,y,w,h or --ref eN bounding box)
    |-- Mode 1: 'ascii'     (7-bit luminance ramp)
    |-- Mode 2: 'edge'      (Sobel gradient edge wireframe: / \ - |)
    |-- Mode 3: 'braille'   (2x4 Unicode Braille subpixel dots)
    |-- Mode 4: 'halfblock' (ANSI 24-bit fg/bg upper-half-block)
    |-- Set-of-Marks overlay: draws +--[eN]--+ wireframes around clickable boxes
    v
  sanitize.ts (when strict ASCII mode is active)
```

---

### 4.5 Security & Defense-in-Depth Architecture (`src/agent/`, `src/bridge/`)

Security is enforced in concentric rings so no single bypass compromises the host or leaks credentials:

```text
  +------------------------------------------------------------------------+
  | Ring 1: Network & Transport                                            |
  |   - Loopback-only 127.0.0.1 bind (SSH tunnel for remote EC2 access)    |
  |   - Strict Host header validation (host-guard.ts)                      |
  |   - Timing-safe x-troy-agent token check (auth.ts)                     |
  |   - Sliding-window rate limiter & body caps (rate-limit.ts)            |
  +------------------------------------------------------------------------+
  | Ring 2: Policy & Navigation                                            |
  |   - Policy profiles: strict | standard | permissive (policy-profile.ts)|
  |   - Read-only observer mode (--readonly, readonly.ts)                  |
  |   - Origin allowlist/denylist (--allow-origin / --deny-origin)         |
  |   - Scheme allowlist & tracker stripping (omnibox.ts)                  |
  |   - SSRF & AWS IMDS 169.254.169.254 blocking (--block-private-net)     |
  +------------------------------------------------------------------------+
  | Ring 3: Interaction & Refusal Guards                                   |
  |   - Origin authorization grant required for mutations (policy.ts)      |
  |   - Sensitive field blocking (password, credit card, OTP, SSN)         |
  |   - Form submit confirmation guard                                     |
  |   - Agent loop guard preventing runaway retry loops (loop-guard.ts)    |
  |   - Download quarantine / executable blocking (downloads.ts)           |
  +------------------------------------------------------------------------+
  | Ring 4: Output & Audit Safety                                          |
  |   - Secret redaction: JWT, AWS AKIA..., CC numbers (secret-redactor.ts)|
  |   - Untrusted content delimiters for prompt-injection defense          |
  |     (--untrusted-markers, untrusted-markers.ts)                        |
  |   - Append-only JSONL audit log (audit.jsonl, audit.ts)                |
  +------------------------------------------------------------------------+
```

---

### 4.6 Agent Memory, Refs & Intelligence (`src/agent/`)

- **Element Registry (`src/agent/elements.ts`):** Maps opaque `e1..eN` refs to live `ElementDescriptor` entries scoped to `(tabId, epoch)`. When a ref goes stale on the same epoch due to minor DOM mutations, `recoverElementMatch()` attempts deterministic unique recovery in order: `id` -> `ariaLabel` -> `name+tag` -> `role+ariaLabel`.
- **Smart Find (`src/agent/find.ts`):** Scores elements using fuzzy token matching, UI synonyms (e.g., `sign in` <-> `login`), and ARIA role filters (`button`, `input`, `link`).
- **Page Memory & Auto-Binding (`src/agent/memory.ts`, `src/agent/recall-bind.ts`):** Persists element signatures per host in `<profileDir>/memory.json`. On subsequent visits, `page_recall` verifies recalled selectors against the live DOM and immediately binds fresh `eN` refs.
- **Structured Extraction (`src/agent/extract.ts`):** Extracts normalized tables, forms, links, headings, OpenGraph, and JSON-LD metadata in one call.
- **Flow Runner (`src/agent/flow-runner.ts`):** Executes replayable JSON workflow scripts (`troy-advanced run <flow.json>`) with assertions and automatic ASCII failure dumps.

---

### 4.7 Daemon, Cloud Ops & Storage Layout (`src/cloud/`, `deploy/`)

#### Profile & Configuration Storage Layout

```text
~/.config/troy-advanced/                       (or $XDG_CONFIG_HOME / macOS App Support)
  +-- agent-endpoint.json                      (0o600 atomic discovery file)

~/.config/Troy/                                (only when --compat-troy is enabled)
  +-- agent-endpoint.json                      (0o600 mirrored discovery file)

<profileDir>/                                  (default or named via `profile create`)
  +-- daemon.json                              (persisted origin allow/deny rules & settings)
  +-- policy.json                              (optional policy profile overrides)
  +-- cookies.json                             (0o600 LiteEngine CookieJar)
  +-- memory.json                              (persistent per-host PageMemory store)
  +-- audit.jsonl                              (append-only tool call & refusal audit log)
  +-- daemon.log / daemon.log.1..N             (size-rotated daemon logs)
  +-- quarantine/                              (0o600 non-executable intercepted downloads)
  +-- chrome-data/                             (persistent Chromium user-data-dir)
```

#### Cloud & Operations Modules (`src/cloud/`)
- `daemon.ts`: Manages daemon lifecycle, signal handling (`SIGTERM`/`SIGINT`), endpoint file lifecycle, and graceful shutdown.
- `memory-watchdog.ts`: Monitors process RSS against `--max-rss-mb`, issuing GC hints and evicting idle background tabs before OOM kills occur on small EC2 instances.
- `daemon-logs.ts`: Rotating file logger and `daemon logs --tail/--follow` reader.
- `profiles.ts`: Multi-profile CRUD and portable `.json` export/import (with options to exclude `chrome-data/` or `audit.jsonl`).
- `imds.ts` & `doctor.ts`: AWS IMDSv2 metadata probe (instance type, region, AZ with graceful non-EC2 fallback) and environment readiness diagnostics.
- `ec2-tunnel.ts`: Generates and optionally launches secure SSH loopback forwarding (`ssh -L ...`) to remote EC2 daemons.
- `bench.ts`: Measures startup latency, ASCII layout throughput, and CDP snapshot latency.
- `docker-compose.ts` & `ci-workflow.ts`: Generators/validators for `docker-compose.yml` and `.github/workflows/ci.yml`.
- `src/demo/server.ts` + `scripts/demo-site.mjs`: Self-contained local demo server showcasing forms, tables, dynamic JS, and `<canvas>` art rendered in ASCII.

---

## 5. Module Directory Reference

| Directory | Responsibility |
|---|---|
| `bin/` | Executable CLI shim (`bin/troy-advanced.mjs`) |
| `src/agent/` | Safety policy, SSRF, readonly, redaction, untrusted markers, `eN` refs, find, memory, recall-bind, delta, extract, flow-runner, sessions, loop-guard, audit |
| `src/ascii/` | 2D spatial layout, Markdown export, delta diff, PNG decoder, pixel/Braille/edge/halfblock + SoM renderer, strict 7-bit sanitizer, token budget, benchmarks |
| `src/bridge/` | Loopback HTTP Agent Socket, atomic `agent-endpoint.json`, timing-safe auth, host guard, rate limiter, Prometheus `/metrics`, SSE `/stream`, WebSocket `/ws` |
| `src/cloud/` | Background daemon, memory watchdog, log rotation, daemon config, profiles, doctor, IMDSv2, SSH tunnel helper, bench, Docker Compose & CI helpers |
| `src/demo/` | Interactive local demo server (`src/demo/server.ts`) |
| `src/engine/` | `BrowserManager`, `ChromiumEngine`, raw `CdpClient`, `RemoteCdp`, `LiteEngine`, cookies, storage, frames, shadow DOM, keyboard, wait/settle, proxy, dialogs, downloads |
| `src/mcp/` | MCP JSON-RPC 2.0 server, NDJSON/`Content-Length` framing transport, OpenAI/Anthropic/Gemini/MCP tool schema generator |
| `src/pipe/` | Streaming `stdin`/`stdout` ASCII & NDJSON REPL |
| `src/tui/` | Raw-mode terminal browser, split-pane inspector, link hints, form modal, command palette, sidebar, pixel preview, export, help overlay, PTY test simulator |
| `deploy/` | `deploy/ec2-bootstrap.sh`, `deploy/troy-advanced.service` (systemd), `deploy/.env.example` |
| `skills/` | Ready-to-use agent skill & plugin manifest (`skills/troy-advanced/SKILL.md`, `.claude-plugin/plugin.json`, `.mcp.json`) |
| `scripts/` | `scripts/bench-ascii.mjs`, `scripts/demo-site.mjs`, `scripts/continue-cron.mjs` |
