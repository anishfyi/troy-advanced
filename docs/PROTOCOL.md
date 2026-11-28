# troy-advanced Protocol Specification

This document specifies the wire contracts for all machine-to-machine interfaces exposed by `troy-advanced`:

1. **HTTP Agent Socket** (`127.0.0.1` loopback, 100% compatible with `velofy/troy` and Dexter's `troy` tool)
2. **Server-Sent Events (`GET /stream`)** live ASCII frame & event streaming
3. **WebSocket Bridge (`GET /ws`, `troy-ws-v1`)** bidirectional pipelined control
4. **Model Context Protocol (MCP)** JSON-RPC 2.0 over stdio (`ndjson` and `Content-Length` framing)
5. **Streaming Pipe REPL (`troy-advanced pipe`)** plain-ASCII and NDJSON stdin/stdout protocol

For subsystem architecture and internal module layout, see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Transport Overview & Discovery

```text
+------------------------------------------------------------------------------------------------+
|                              troy-advanced PROTOCOL SURFACES                                   |
|                                                                                                |
|  [HTTP Agent Socket]        [SSE /stream]        [WebSocket /ws]      [MCP stdio]  [Pipe REPL] |
|  127.0.0.1:<port>           text/event-stream    RFC 6455             JSON-RPC 2.0 stdin/stdout|
|  x-troy-agent auth          ascii_frame + ev     troy-ws-v1           ndjson / CL  ASCII/NDJSON|
|  src/bridge/agent-socket.ts src/bridge/sse-...   src/bridge/ws-...    src/mcp/     src/pipe/   |
+-------------------+-----------------+-------------------+-----------------+--------------+-----+
                    |                 |                   |                 |              |
                    +-----------------+-------------------+-----------------+--------------+
                                                          |
                                                          v
                                          BrowserManager (src/engine/manager.ts)
                                          Policy -> Engine -> Refs -> ASCII / JSON
```

### 1.1 Endpoint Discovery (`agent-endpoint.json`)

When the daemon starts (`src/bridge/endpoint.ts`), it atomically writes an owner-only (`0o600`) JSON descriptor via temp-file rename. Clients discover the live daemon in this precedence order:

1. Explicit `--endpoint <file>` CLI argument (if provided)
2. `TROY_ADVANCED_ENDPOINT_FILE` environment variable
3. `TROY_ENDPOINT_FILE` environment variable
4. Platform default path:
   - **Linux:** `${XDG_CONFIG_HOME:-$HOME/.config}/troy-advanced/agent-endpoint.json`
   - **macOS:** `$HOME/Library/Application Support/troy-advanced/agent-endpoint.json`
   - **Windows:** `%APPDATA%\troy-advanced\agent-endpoint.json`
5. Compatibility fallback path (when `--compat-troy` mirroring is enabled):
   - **Linux:** `${XDG_CONFIG_HOME:-$HOME/.config}/Troy/agent-endpoint.json`
   - **macOS:** `$HOME/Library/Application Support/Troy/agent-endpoint.json`
   - **Windows:** `%APPDATA%\Troy\agent-endpoint.json`

Clients MUST verify process liveness (`process.kill(pid, 0)`) and skip stale endpoint files whose PID is no longer running.

#### `EndpointDescriptor` Schema (`src/types.ts`)

```json
{
  "port": 9222,
  "httpEndpoint": "http://127.0.0.1:49152",
  "webSocketDebuggerUrlHint": "http://127.0.0.1:9222/json/version",
  "remoteCdpUrl": "ws://127.0.0.1:9222/devtools/browser/...",
  "pid": 48120,
  "version": "0.1.0",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "engine": "chromium",
  "agentPort": 49152,
  "agentToken": "<48-hex-char-random-secret>",
  "agentWsEndpoint": "ws://127.0.0.1:49152/ws",
  "profileDir": "/home/ec2-user/.local/share/troy-advanced/default"
}
```

---

## 2. HTTP Agent Socket Protocol

Implemented in `src/bridge/agent-socket.ts`. Bound strictly to loopback (`127.0.0.1` by default).

### 2.1 Security & Transport Invariants

Every incoming HTTP request passes through a fixed guard pipeline before routing:

```text
  HTTP Request
    |
    +--> [1. URL Length Check]   > 8192 bytes -> 414 URI Too Long
    +--> [2. Host/Origin Guard]  src/bridge/host-guard.ts -> 403 Forbidden
    |      - Exact loopback allowlist: 127.0.0.1, localhost, [::1]
    |      - Rejects DNS rebinding (localhost.evil.com, 127.0.0.1.nip.io)
    |      - Rejects duplicate Host/Origin headers and non-loopback Origin
    +--> [3. Auth Check]         src/bridge/auth.ts -> 401 Unauthorized / 429 Too Many Requests
    |      - Header: `x-troy-agent: <agentToken>`
    |      - Constant-time SHA-256 + raw buffer comparison (`crypto.timingSafeEqual`)
    |      - Rejects duplicate `x-troy-agent` headers
    |      - Auth-failure limiter: default 30 failures / 60s per remote IP
    +--> [4. Rate Limiter]       src/bridge/rate-limit.ts -> 429 Too Many Requests
    |      - Sliding window: default 600 requests / 10s per client/session key
    |      - Emits `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`
    |      - Emits `retry-after` on HTTP 429
    +--> [5. Body Parser]
           - Standard cap: 128 KiB (`MAX_BODY`); import routes cap: 2 MiB (`MAX_IMPORT_BODY`)
           - Rejects duplicate/invalid `Content-Length` -> 400 Bad Request
           - Oversized payload -> 413 Payload Too Large
           - Strips `__proto__`, `constructor`, `prototype` keys during `JSON.parse`
```

#### Unauthenticated Probes & Metrics

- `GET` / `HEAD` on `/healthz`, `/livez`, and `/readyz` are allowed without `x-troy-agent` by default (`healthProbeUnauthenticated: true`) so Kubernetes, Docker, and ALB/systemd probes can check liveness (`200`) and readiness (`200` or `503`).
- `GET` / `HEAD` on `/metrics` supports `x-troy-agent`, `Authorization: Bearer <token>`, or unauthenticated loopback scraping when `metricsUnauthenticated: true`.

### 2.2 Multi-Agent Session Isolation

Clients may pass `x-troy-session: <sessionId>` (header) or `sessionId` in the JSON body (`src/agent/sessions.ts`):
- Session IDs must be 1–64 characters matching `[A-Za-z0-9._:-]`.
- Each session maintains its own `ownedTabIds` set and optional per-session origin allowlist so concurrent AI agents cannot overwrite or close each other's tabs.

### 2.3 HTTP Endpoint Reference

All `POST` routes accept a JSON object body (`Content-Type: application/json`) and return a JSON object response with `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`.

#### Core Lifecycle & Tab Endpoints

| Method | Path | Description | Key Request Fields |
|---|---|---|---|
| `GET` / `HEAD` | `/healthz`, `/livez` | Liveness probe (200 ok) | — |
| `GET` / `HEAD` | `/readyz` | Readiness probe (200 ready / 503 degraded) | — |
| `GET` / `POST` | `/health` | Detailed daemon health, engine, uptime, RSS, metrics summary | — |
| `GET` / `POST` | `/metrics` | Prometheus text exposition (`GET`) or JSON/ASCII metrics (`POST`) | `format?: "json" \| "prometheus" \| "ascii"` |
| `POST` | `/tabs` | List open tabs (scoped to session if `x-troy-session` set) | — |
| `POST` | `/open` | Open a new tab at a URL or omnibox search query | `url: string`, `activate?: boolean` |
| `POST` | `/activate` | Focus/activate a tab by ID | `tabId: number` |
| `POST` | `/close` | Close a tab by ID | `tabId: number` |
| `POST` | `/grant-origin` | Grant origin permission for interactive actions | `origin: string` |

#### Rendering, Extraction & Tool Dispatch

| Method | Path | Description | Key Request Fields |
|---|---|---|---|
| `POST` | `/ascii` | Render tab as strict 7-bit ASCII viewport with `[eN]` refs | `tabId?`, `width?`, `height?`, `density?`, `layout?`, `maxTokens?`, `crop?`, `ref?`, `since?`, `showMediaSummary?`, `untrustedMarkers?`, `redactSecrets?` |
| `POST` | `/markdown` | Export tab as CommonMark/GFM Markdown with inline `[eN]` refs | `tabId?`, `showRefs?`, `includeUrls?`, `includeFrontmatter?`, `includeMediaSummary?`, `asciiOnly?`, `crop?`, `ref?`, `untrustedMarkers?`, `redactSecrets?` |
| `POST` | `/extract` | Extract structured tables, forms, links, headings, metadata | `tabId?`, `sections?`, `limit?`, `maxTableRows?`, `includeJsonLd?`, `includeOpenGraph?` |
| `POST` | `/tool` | Execute any `page_*` browser tool on a tab | `tabId?: number`, `tool: string`, `args?: object` |

#### Memory, Sessions, Storage & Diagnostics

| Method | Path | Description | Key Request Fields |
|---|---|---|---|
| `POST` | `/recall` | Query persistent page memory across sessions | `query?: string`, `origin?: string`, `limit?: number` |
| `POST` | `/forget` | Delete stored page memory for an origin or all origins | `origin?: string` |
| `POST` | `/memory` | Return page memory statistics (`pages`, `elements`, `actions`) | — |
| `GET` / `POST` | `/sessions` | List, create, inspect, or delete named agent sessions | `action?: "list" \| "create" \| "get" \| "delete"`, `sessionId?`, `origins?` |
| `GET` / `POST` | `/policy` | Inspect active policy profile (`strict` / `standard` / `permissive`) | `format?: "json" \| "ascii"` |
| `GET` / `POST` | `/origins` | Inspect or mutate persisted origin allow/deny rules | `action?: "list" \| "allow" \| "deny" \| "remove"`, `pattern?` |
| `GET` / `POST` | `/watchdog` | Inspect daemon memory watchdog RSS & eviction stats | `action?: "status" \| "check"`, `format?: "json" \| "ascii"` |
| `POST` | `/cookies/export` | Export cookies (optionally filtered by domain/URL) | `url?`, `domain?` |
| `POST` | `/cookies/import` | Import cookies (up to 2 MiB body) | `cookies: BrowserCookie[]` |
| `POST` | `/cookies/clear` | Clear stored cookies | `domain?` |
| `POST` | `/storage/inspect` | Inspect `localStorage` / `sessionStorage` for active tab | `tabId?`, `area?: "local" \| "session" \| "both"` |
| `POST` | `/storage/export` | Export origin storage snapshot | `tabId?`, `area?` |
| `POST` | `/storage/import` | Hydrate origin storage snapshot (up to 2 MiB body) | `tabId?`, `snapshot: OriginStorageSnapshot` |
| `POST` | `/storage/clear` | Clear origin storage | `tabId?`, `area?` |
| `POST` | `/emulation` | Configure viewport preset, User-Agent, or custom HTTP headers | `tabId?`, `preset?`, `width?`, `height?`, `userAgent?`, `headers?`, `reset?` |
| `POST` | `/downloads` | Inspect quarantine downloads or change download policy mode | `action?`, `mode?`, `id?` |
| `POST` | `/dialogs` | Inspect captured JS alerts/confirms/prompts or set auto-mode | `action?`, `mode?`, `type?`, `promptText?` |
| `POST` | `/audit` | Query structured `audit.jsonl` action log & refusal stats | `limit?`, `kind?`, `sessionId?`, `format?` |
| `POST` | `/loop-guard` | Inspect or configure repeated-failure loop guard | `action?`, `mode?`, `tabId?` |

### 2.4 `POST /tool` Catalog (`src/engine/manager.ts`)

Request envelope:

```json
{
  "tabId": 1,
  "tool": "page_click",
  "args": { "ref": "e3", "allowSubmit": false }
}
```

Supported `tool` names:

- **Observation & Reading:** `page_read`, `page_read_visual`, `page_read_ascii`, `page_read_markdown`, `page_text`, `page_find`, `page_extract`, `page_recall`
- **Navigation & Timing:** `page_navigate`, `page_history` (`back` | `forward` | `reload`), `page_wait` (`ms`, `text`, `selector`, `url`, `state`, `timeout`)
- **Interaction:** `page_click`, `page_fill`, `page_select`, `page_press`, `page_hover`, `page_scroll`, `page_act` (ordered multi-step batch)
- **Visual & Media:** `page_screenshot`, `page_screenshot_ascii` (`ascii` | `edge` | `braille` | `halfblock`, `crop`, `ref`, `annotate`)
- **Inspection & Emulation:** `page_console`, `page_network`, `page_network_body`, `page_downloads`, `page_emulate`, `page_eval`

### 2.5 Deterministic Safety Refusals

Policy and safety refusals return HTTP `200` with `ok: false`, a structured `status`, a machine-readable `code`, and a human-readable `error`/`reason` (so agent clients can distinguish deterministic policy boundaries from transport failures):

```json
{
  "ok": false,
  "status": "boundary",
  "code": "origin",
  "error": "origin https://example.com has not been granted; call /grant-origin first"
}
```

| `status` | `code` | Trigger |
|---|---|---|
| `blocked` | `readonly` | Mutating endpoint or tool invoked while `--readonly` observer mode is active (`src/agent/readonly.ts`) |
| `blocked` | `policy_tool_blocked` | Tool disallowed by active `policy.json` profile (`src/agent/policy-profile.ts`) |
| `blocked` | `policy_eval_disabled` | `page_eval` disabled under `strict` policy profile |
| `blocked` | `scheme` | Disallowed URL scheme (`javascript:`, `file:`, `data:`, `chrome:`, etc.) |
| `blocked` | `ssrf` | Private/loopback/AWS IMDS (`169.254.169.254`) address blocked under `--block-private-net` (`src/agent/ssrf.ts`) |
| `blocked` | `origin_denied` | Target origin matches a persisted `--deny-origin` rule |
| `blocked` | `sensitive` | Attempt to `page_fill` a password, credit card, CVV, SSN, or OTP field |
| `boundary` | `origin` | Interactive action on an ungranted origin (recoverable via `/grant-origin`) |
| `boundary` | `submit` | Form submission click without explicit `allowSubmit: true` |

---

## 3. Streaming SSE Protocol (`GET /stream`)

Implemented in `src/bridge/sse-stream.ts`. Authenticated with `x-troy-agent` and guarded by `src/bridge/host-guard.ts`.

### 3.1 Query Parameters

| Parameter | Default | Description |
|---|---|---|
| `mode` | *(both)* | Shorthand: `frames` / `ascii` (frames only), `events` (raw events only), `delta` (frames with `since=true`) |
| `frames` | `true` | Emit `ascii_frame` events when the watched tab navigates or mutates |
| `events` | `true` | Forward raw `BrowserManager` lifecycle events |
| `initial` | `true` | Emit an initial `ascii_frame` immediately upon connecting |
| `tabId` / `tab` | *(active)* | Specific numeric tab ID to watch (defaults to active tab) |
| `sessionId` / `session` | *(header)* | Optional multi-agent session scope |
| `width` / `height` | `100` / *(auto)* | Viewport width (`40..240`) and height (`10..200`) |
| `density` | `normal` | `compact` \| `normal` \| `wide` |
| `layout` | `auto` | `auto` \| `spatial` \| `flow` |
| `maxTokens` | *(none)* | Token budget for progressive ASCII compaction |
| `asciiOnly` | `true` | Enforce strict 7-bit printable ASCII |
| `showChrome` | `true` | Include ASCII browser chrome header/footer |
| `since` | `false` | Emit delta ASCII frames after the first full frame |
| `dedupe` | `true` | Suppress consecutive frames with identical content hash |
| `throttleMs` | `25` | Coalesce rapid mutation triggers (`0..5000` ms) |
| `pollMs` | `0` | Optional background DOM poll interval (`0` = off, min `100` ms) |
| `heartbeatMs` | `15000` | SSE `: keep-alive` comment interval (`0` = off, min `1000` ms) |

### 3.2 Wire Format & `ascii_frame` Payload

Messages use standard Server-Sent Events framing (`Content-Type: text/event-stream`):

```text
id: 1
event: ascii_frame
data: {"type":"ascii_frame","seq":1,"ts":1735689600000,"reason":"initial","tabId":1,"url":"https://example.com/","title":"Example Domain","mode":"full","refs":1,"estimatedTokens":64,"hash":"a1b2c3d4e5f60718","ascii":"+-- ... --+"}

```

When `mode` is `"delta"`, the payload additionally includes `delta` (the structured `PageDelta` diff). When `maxTokens` is set, the payload includes `tokenBudget` (`TokenBudgetReport`).

---

## 4. WebSocket Bridge Protocol (`GET /ws`, `troy-ws-v1`)

Implemented in `src/bridge/ws-bridge.ts` using a zero-dependency RFC 6455 server (text, binary, ping/pong, and close frames; 2 MiB max message size).

### 4.1 Handshake & Authentication

- Client initiates an HTTP `Upgrade: websocket` request to `GET /ws`.
- Host and Origin headers are strictly validated (`src/bridge/host-guard.ts`) to prevent Cross-Site WebSocket Hijacking (CSWSH).
- Authentication accepts either `x-troy-agent: <token>` header or `?token=<token>` query parameter (validated via `timingSafeTokenEqual`).
- Optional session binding via `x-troy-session` header or `?sessionId=<id>` query parameter.
- Immediately after upgrade, the server sends a `hello` frame:

```json
{
  "type": "hello",
  "protocol": "troy-ws-v1",
  "engine": "chromium",
  "tabs": 1,
  "sessionId": "agent-1",
  "ts": 1735689600000
}
```

### 4.2 Client-to-Server Messages

Every client message is a JSON object with an optional correlation `id` (`string | number | null`) and either `op` or `route`:

1. **Ping:** `{"id": 1, "op": "ping"}` -> returns `{"type": "pong", "id": 1, "ts": ...}`
2. **Subscribe to live frames/events:**
   ```json
   {"id": 2, "op": "subscribe", "frames": true, "events": true, "initial": true, "width": 100, "since": false}
   ```
3. **Unsubscribe:** `{"id": 3, "op": "unsubscribe"}`
4. **Batch execution (sequential, optional short-circuit):**
   ```json
   {
     "id": 4,
     "op": "batch",
     "stopOnError": true,
     "steps": [
       {"op": "open", "url": "https://example.com"},
       {"op": "ascii", "width": 80}
     ]
   }
   ```
5. **Single route/op dispatch:**
   - Shorthand `op` values map directly to Agent Socket routes: `health`, `tabs`, `open`, `activate`, `close`, `grant` / `grant-origin`, `ascii`, `markdown`, `extract`, `tool`, `recall`, `forget`, `memory`, `sessions`, `emulation`, `downloads`, `dialogs`, `audit`.
   - Any Agent Socket path may also be addressed directly with `"route": "/cookies/export"`.

### 4.3 Server-to-Client Messages

| `type` | Fields | Description |
|---|---|---|
| `hello` | `protocol`, `engine`, `tabs`, `sessionId?`, `ts` | Initial server greeting on connect |
| `response` | `id`, `status`, `ok`, `result?`, `results?`, `error?`, `durationMs` | Correlated reply to a client request or batch |
| `pong` | `id`, `ts` | Reply to `op: "ping"` |
| `event` | `event`, `data`, `ts` | Forwarded `BrowserManager` event (when subscribed) |
| `ascii_frame` | Same as SSE `AsciiFramePayload` | Live ASCII viewport update (when subscribed) |

---

## 5. Model Context Protocol (MCP) over Stdio

Implemented in `src/mcp/server.ts` and `src/mcp/transport.ts`, launched via `troy-advanced mcp [--framing auto|ndjson|content-length]`.

### 5.1 Wire Framing (`src/mcp/transport.ts`)

| Mode | Wire Format | Notes |
|---|---|---|
| `ndjson` | `<json>\n` | One JSON-RPC 2.0 object per line (MCP `2024-11-05+` default) |
| `content-length` | `Content-Length: <utf8-bytes>\r\n\r\n<json>` | Byte-accurate LSP/MCP framing (16 MiB max body, 16 KiB max headers) |
| `auto` *(default)* | Detects framing per incoming stream | Replies match the client's incoming framing |

### 5.2 JSON-RPC 2.0 Lifecycle & Methods

- **`initialize`** -> Returns `protocolVersion: "2024-11-05"`, `serverInfo: { name: "troy-advanced", version: "0.1.0" }`, and capabilities (`tools`, `resources`, `prompts`).
- **`notifications/initialized`** -> Notification (no response emitted).
- **`ping`** -> Returns `{}`.
- **`tools/list`** / **`tools/call`** -> Lists and invokes the 17 MCP tools.
- **`resources/list`** / **`resources/templates/list`** / **`resources/read`** -> Exposes live browser state as MCP resources.
- **`prompts/list`** / **`prompts/get`** -> Exposes structured workflow prompt templates.

Standard JSON-RPC error codes are returned on protocol errors: `-32700` (Parse error), `-32600` (Invalid Request), `-32601` (Method not found), `-32602` (Invalid params), `-32603` (Internal error).

### 5.3 MCP Tools (17)

| Tool Name | Purpose |
|---|---|
| `troy_open` | Open a new tab at a URL or search query |
| `troy_tabs` | List open browser tabs |
| `troy_read_ascii` | Render tab as strict 7-bit ASCII viewport with `[eN]` refs, density, crop, delta, token budget |
| `troy_read_markdown` | Export tab as CommonMark/GFM Markdown preserving `[eN]` refs |
| `troy_screenshot_ascii` | Render Chromium screenshot as `ascii`, `edge`, `braille`, or `halfblock` with optional `[eN]` overlays |
| `troy_find` | Fuzzy + synonym + ARIA role interactive element search |
| `troy_extract` | Structured extraction of tables, forms, links, headings, JSON-LD, OpenGraph |
| `troy_click` | Click element by `ref` (optional `allowSubmit: true`) |
| `troy_fill` | Fill input/textarea by `ref` (blocks sensitive password/payment fields) |
| `troy_wait` | Wait for `ms`, `text`, `selector`, `url`, and visibility `state` |
| `troy_act` | Execute an ordered multi-step batch of `click` / `fill` / `select` / `press` |
| `troy_grant` | Grant origin permission for interactive actions |
| `troy_recall` | Recall persistent page memory entries (optional live DOM `bind: true`) |
| `troy_emulate` | Set viewport preset, custom `WxH`, User-Agent, or custom HTTP headers |
| `troy_downloads` | Inspect quarantined downloads or configure download policy |
| `troy_dialogs` | Inspect captured JS dialogs or set auto-accept/dismiss behavior |
| `troy_network` | Inspect recorded network requests and response bodies |

*(Note: `troy-advanced schema --format openai|anthropic|gemini|mcp` in `src/mcp/schema.ts` exports these tool definitions into provider-native JSON schemas.)*

### 5.4 MCP Resources & Prompts

**Static Resources (`resources/list`):**
- `troy://tabs` (`application/json`) — Open tabs, active tab ID, engine metadata
- `troy://active/ascii` (`text/plain`) — Live strict 7-bit ASCII viewport of the active tab
- `troy://memory/stats` (`application/json`) — Persistent page memory statistics

**Resource Templates (`resources/templates/list`):**
- `troy://tabs/{tabId}/ascii` (`text/plain`) — Strict 7-bit ASCII viewport for a specific numeric `tabId`

**Prompts (`prompts/list`):**
- `browse_and_extract` (args: `url`*, `goal`, `density`) — Guided ASCII navigation and extraction workflow
- `fill_form_safely` (args: `url`*, `fields`, `allowSubmit`) — Safe inspection, non-sensitive fill, and submit confirmation workflow

---

## 6. Streaming Pipe REPL Protocol (`troy-advanced pipe`)

Implemented in `src/pipe/repl.ts`. Reads newline-delimited commands from `stdin` and writes responses to `stdout`. Passing `--json` forces JSON output for every plain-ASCII command.

### 6.1 Plain-ASCII Command Mode

Any non-empty line not starting with `{` is parsed as a plain-ASCII command. Arguments support single/double quotes and backslash escapes (`tokenizePipeArgs`).

| Command | Aliases | Behavior |
|---|---|---|
| `open <url>` | `go`, `goto` | Open URL and immediately emit strict 7-bit ASCII viewport (or JSON in `--json` mode) |
| `ascii [width] [flags]` | `render` | Render active tab in ASCII (`compact\|normal\|wide`, `--density`, `--max-tokens`, `--crop`, `--ref`, `--since`, `--media`, `--untrusted-markers`, `--redact-secrets`) |
| `markdown [flags]` | `md` | Export active tab as Markdown (`--frontmatter`, `--media`, `--ascii`, `--no-refs`, `--no-urls`, `--crop`, `--ref`) |
| `visual [width] [flags]` | — | Capture screenshot ASCII/edge/braille/halfblock (`--mode`, `--crop`, `--ref`) |
| `read [flags]` | — | Structured snapshot read (`--since`, `--untrusted-markers`, `--redact-secrets`) |
| `find <query> [flags]` | — | Smart element search (`--role`, `--limit`, `--no-fuzzy`, `--no-synonyms`) |
| `extract [flags]` | — | Structured data extraction (`--sections`, `--limit`, `--max-rows`) |
| `click <ref> [--submit]` | — | Click element ref |
| `fill <ref> <text>` | — | Fill input/textarea ref |
| `select <ref> <value>` | — | Select option on `<select>` ref |
| `press <key>` | — | Send key or chord (`Enter`, `Control+A`, `Shift+Tab`, etc.) |
| `scroll <up\|down\|top\|bottom>` | — | Scroll viewport |
| `wait [ms] [flags]` | — | Wait for delay or condition (`--text`, `--selector`, `--url`, `--state`, `--timeout`) |
| `back` / `forward` / `reload` | — | History navigation |
| `tabs` / `tab <id>` | `focus` | List tabs or switch active tab |
| `grant <origin>` | — | Authorize origin for interaction |
| `recall <query>` | — | Query persistent page memory |
| `emulate [flags]` | `viewport` | Configure viewport preset, `WxH`, User-Agent, headers |
| `downloads [args]` | — | Inspect or configure quarantined downloads |
| `dialogs [args]` | — | Inspect or configure JS dialog handling |
| `network [args]` | — | Inspect network requests or `--body <reqId>` |
| `help` | — | Print concise command summary |
| `quit` | `exit`, `q` | Emit `BYE` (or `{"ok":true,"bye":true}`) and terminate cleanly |

Errors in plain-ASCII mode are formatted as `ERR: <message>`.

### 6.2 Structured NDJSON Command Mode

Any line starting with `{` is parsed as a JSON command object `{ "cmd": "<name>", "tabId": 1, ... }` and always writes a single-line JSON response to `stdout`:

- Built-in control commands: `open`, `tabs`, `grant`, `activate`, `close`, `quit`, `exit`.
- Any other `cmd` value is automatically normalized to `page_<cmd>` (unless already prefixed with `page_`) and dispatched to `BrowserManager.runTool(tabId, toolName, args)`.

Example session:

```text
> {"cmd":"open","url":"https://example.com"}
< {"ok":true,"id":1,"url":"https://example.com/","title":"Example Domain"}
> {"cmd":"read_ascii","tabId":1,"width":80,"density":"compact"}
< {"ok":true,"ascii":"+-- Example Domain ... --+","refs":1,"estimatedTokens":58}
> {"cmd":"quit"}
< {"ok":true,"bye":true}
```

---

## 7. Cross-Protocol Invariants

Regardless of whether a client uses HTTP Agent Socket, SSE, WebSocket, MCP, or Pipe REPL, the following contracts hold identically:

1. **Opaque `eN` Element Refs (`src/agent/elements.ts`):** Interactive elements are assigned sequential refs (`e1`, `e2`, ...) scoped to `(tabId, navigationEpoch)`. Navigating to a new page increments `epoch` and invalidates prior refs; minor DOM mutations within the same epoch trigger deterministic stale-ref recovery by `id`, `ariaLabel`, `name+tag`, or `role+ariaLabel` when a unique match exists.
2. **Strict 7-Bit ASCII Sanitization (`src/ascii/sanitize.ts`):** When `asciiOnly: true` (default for ASCII views), output contains only printable 7-bit ASCII (`0x20..0x7E`) and `\n`, stripping ANSI escape sequences, bidirectional override marks, and zero-width characters.
3. **Token Budget Trimming (`src/ascii/token-budget.ts`):** Supplying `maxTokens` progressively compacts whitespace, trims non-interactive prose, and preserves `[eN]` refs so responses fit cleanly inside small LLM context windows.
4. **Delta Reads (`--since` / `since: true`):** Computes structural page diffs (`src/agent/delta.ts`) and renders `+` (added), `-` (removed), and `~` (changed) markers (`src/ascii/delta.ts`).
5. **Untrusted Content Isolation (`untrustedMarkers: true`):** Wraps page-derived text in explicit untrusted delimiters (`src/agent/untrusted-markers.ts`) to mitigate indirect prompt injection.
6. **Sensitive Secret Redaction (`redactSecrets: true`):** Masks JWTs, AWS access keys (`AKIA...`), credit card numbers, and bearer/API tokens (`src/agent/secret-redactor.ts`) before returning page content to the caller.
