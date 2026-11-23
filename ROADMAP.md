# ROADMAP — troy-advanced (100+ Autonomous Engineering Milestones)

Each 10-minute `continue` iteration picks the next unchecked milestone (or fixes a concrete bug/gap), implements it cleanly with real tests, verifies `npm run typecheck && npm run build && npm test`, marks the item `[x]`, commits, and pushes to `origin main`.

## Track 1: ASCII Spatial Layout & Visual Engine (Milestones 1–15)
- [x] M01: True 2D spatial layout mode in `src/ascii/layout.ts` using element `box` coordinates (`x, y, width, height`) to preserve multi-column sidebars, headers, and grids in ASCII
- [x] M02: ASCII table auto-column width alignment with borders (`+---+---+`) and header separator rows
- [x] M03: Inline link wrapping inside paragraphs so `[eN: link text]` stays inline rather than forcing a line break
- [x] M04: ASCII progress/scrollbar gutter on the right edge of the viewport frame (`#` thumb on `|` track)
- [x] M05: Form container grouping boxes (`+-- Form: Login --+`) around related inputs and submit buttons
- [x] M06: Collapsible/compact `--density compact|normal|wide` ASCII layout profiles for small LLM token budgets
- [x] M07: ASCII diff renderer (`renderDeltaAscii`) that renders `--since` deltas with `+` added / `-` removed / `~` changed markers
- [x] M08: PNG decoder support for 16-bit channels (downsampled to 8-bit), `tRNS` transparency chunks, and 1/2/4-bit sub-byte depths
- [x] M09: Sobel edge-detection ASCII mode (`mode: 'edge'`) in `src/ascii/pixels.ts` for crisp UI wireframe outlines (`/\-|`)
- [x] M10: Bounding-box wireframe drawing in `renderRgbaToAscii` so Set-of-Marks draws actual `+--[e3]--+` rectangles around clickable elements
- [x] M11: Region crop support (`--crop x,y,w,h` or `--ref eN`) to zoom in on a single chart, canvas, or modal in ASCII
- [x] M12: Image/Canvas extraction summary showing dimensions, bounding boxes, and auto-ASCII preview of `<canvas>` elements
- [x] M13: Strict 7-bit ASCII sanitizer tests covering CJK, emoji, RTL marks, smart quotes, zero-width chars, and ANSI injection stripping
- [x] M14: Snapshot-to-Markdown exporter (`renderPageMarkdown`) preserving inline `[eN]` refs for hybrid AI workflows
- [x] M15: Benchmark & golden snapshot tests verifying ASCII layout speed (<5ms per page) and deterministic output

## Track 2: Chromium CDP Engine Depth (Milestones 16–30)
- [x] M16: Automatic CDP tracker & ad-beacon request interception (`Fetch.enable` / `Network.setBlockedURLs`) matching `omnibox.ts` tracker list
- [x] M17: Real `page_wait` conditions in Chromium & Lite: wait for `--text`, `--selector`, `--url`, `--state visible|hidden|attached`, and `--timeout`
- [x] M18: Network idle + DOM mutation settle detector (`waitForPageSettle`) so SPAs finish hydrating before snapshots
- [x] M19: Full keyboard chord support (`Control+A`, `Shift+Tab`, `Escape`, `ArrowDown`, `Meta+K`) with proper CDP modifier bitmasks and Windows virtual key codes
- [x] M20: Shadow DOM deep selector traversal in `click`, `fill`, `select`, `hover`, and `press` (not just `document.querySelector`)
- [x] M21: Cross-frame `<iframe>` discovery and snapshot flattening so embedded forms and widgets get real `eN` refs
- [x] M22: Deterministic stale-ref recovery (re-locate by `id`, `ariaLabel`, `name+tag`, `role+ariaLabel` when unique match exists on same epoch)
- [x] M23: Cookie export/import commands (`troy-advanced cookies export|import`) for transferring signed-in sessions to an EC2 instance securely
- [x] M24: LocalStorage / SessionStorage inspection & transfer helpers for EC2 session hydration
- [x] M25: Custom HTTP headers & User-Agent / viewport preset profiles (`desktop`, `mobile`, `terminal`, custom `WxH`)
- [x] M26: Automatic crash recovery: detect Chromium process exit and transparently relaunch with the same persistent profile
- [x] M27: Download interception & quarantine directory inside profile (blocks unsafe auto-downloads while letting user inspect filenames)
- [x] M28: Dialog handling (`Page.javascriptDialogOpening`) — auto-dismiss/capture alert/confirm/prompt messages without hanging headless runs
- [x] M29: Request/Response body inspection (`troy-advanced network --body <reqId>`) for debugging APIs from terminal
- [x] M30: Remote CDP proxy support (`--cdp-url ws://...` or `http://...`) for driving Chrome on another EC2 node or SSH tunnel

## Track 3: Zero-Chrome Lite Engine Depth (Milestones 31–42)
- [x] M31: Persistent file-backed CookieJar (`cookies.json`, `0o600`) with domain/path/expiry/Secure/HttpOnly handling in Lite engine
- [x] M32: Proper HTML entity decoding table (named HTML5 entities + numeric decimal/hex)
- [x] M33: Nested `<label><input .../></label>` implicit label association in Lite HTML parser
- [x] M34: Support `<meta http-equiv="refresh">` and `<base href="...">` resolution in Lite engine
- [x] M35: Support `multipart/form-data` and hidden `<input type="hidden">` form fields (CSRF tokens!) in Lite form submissions
- [x] M36: Support `fieldset`/`legend`, `<details>`/`<summary>`, `<dialog>`, and ARIA `role="button"`/`role="link"` in Lite parser
- [x] M37: JSON & XML pretty-formatter views in Lite engine with collapsible path navigation
- [x] M38: RSS / Atom feed auto-detection and structured ASCII feed reader rendering
- [x] M39: Robots/rate-limit awareness + configurable retry with exponential backoff on HTTP 429/503
- [x] M40: Response caching (`ETag` / `If-None-Match`) for blazing-fast repeated reads in Lite mode
- [x] M41: Plain-text / Markdown / CSV document renderer when Lite fetches non-HTML content
- [x] M42: Comprehensive Lite engine fuzz & malformed-HTML resilience test suite

## Track 4: Interactive Terminal Browser TUI (Milestones 43–55)
- [x] M43: Raw-mode keypress navigation in `terminal-browser.ts` (single-key `j/k` scroll, `g/G` top/bottom, `/` search, `:` command bar, `Tab` focus next ref, `Enter` activate focused ref)
- [x] M44: Highlighted active element focus cursor in ASCII/ANSI TUI with live ref tooltip in status bar
- [x] M45: Split-pane TUI mode: left pane ASCII page viewport, right pane live Console / Network / Refs / Agent Activity inspector
- [x] M46: Inline form-filling modal prompt in TUI when pressing `Enter` on an `<input>` or `<select>` ref
- [x] M47: Quick link-hint jump mode (`f` key highlights `[e1]`..`[e99]`, type digits + Enter to click, vimium-style!)
- [x] M48: Tab bar switching (`1`-`9`, `t` new tab, `w` close tab) and command palette (`Ctrl+P`)
- [x] M49: Bookmark & History sidebar panel inside TUI (`b` bookmarks, `H` history)
- [x] M50: Terminal resize (`SIGWINCH`) live reflow handler so TUI adapts smoothly inside tmux/screen panes
- [x] M51: Non-TTY / piped fallback detection so TUI never corrupts output when stdin/stdout is redirected
- [x] M52: Live pixel-preview toggle (`v` cycles Layout ASCII -> Pixel ASCII -> Braille -> Halfblock)
- [x] M53: Export current page view to `.txt`, `.md`, or `.json` directly from TUI (`:save <file>`)
- [x] M54: Built-in TUI help overlay (`?`) listing all keybindings in an ASCII modal box
- [x] M55: Headless PTY / simulated stream unit tests covering every TUI interaction

## Track 5: Deep AI Agent & Protocol Integration (Milestones 56–70)
- [ ] M56: Full MCP resources (`troy://tabs`, `troy://active/ascii`, `troy://memory/stats`) and MCP prompts (`browse_and_extract`, `fill_form_safely`)
- [ ] M57: MCP `Content-Length` framed stdio transport option alongside NDJSON line mode for maximum MCP client compatibility
- [ ] M58: Claude Code / Dexter / Codex ready-to-use `SKILL.md` and `.claude-plugin/plugin.json` inside `skills/troy-advanced/`
- [ ] M59: OpenAI / Anthropic / Gemini JSON tool-schema generator (`troy-advanced schema --format openai|anthropic|gemini|mcp`)
- [ ] M60: Agent action audit log (`audit.jsonl`) recording every tool call, refusal, timing, and URL transition
- [ ] M61: Token-budget estimator & auto-trimmer (`--max-tokens N`) that fits ASCII page output cleanly into any LLM context window
- [ ] M62: Multi-agent tab isolation: named agent sessions (`x-troy-session`) with per-session owned-tab tracking and origin scopes
- [ ] M63: Structured data extractor (`page_extract` tool) returning tables, forms, links, headings, and JSON-LD/OpenGraph metadata
- [ ] M64: Replayable macro/script runner (`troy-advanced run <flow.json>`) with assertions and ASCII failure dumps
- [ ] M65: Streaming SSE `/stream` live ASCII frame broadcasts whenever the active tab navigates or mutates
- [ ] M66: WebSocket bridge endpoint (`/ws`) on Agent Socket for ultra-low-latency bidirectional AI control
- [ ] M67: Deterministic `page_recall` auto-binding that verifies recalled selectors on the live DOM and issues immediate `eN` refs
- [ ] M68: Smart `page_find` fuzzy + synonym + ARIA role scoring (`button`, `input`, `link` filters)
- [ ] M69: Agent loop guard: detect repeated identical failing actions and return actionable recovery hints
- [ ] M70: End-to-end integration test proving Dexter-style HTTP client + MCP client + Pipe client all interoperate cleanly

## Track 6: Security, Refusals & Sandboxing (Milestones 71–80)
- [ ] M71: SSRF protection mode (`--block-private-net`) to optionally block AWS IMDS `169.254.169.254`, `10.0.0.0/8`, `127.0.0.1` on multi-tenant EC2 deployments
- [ ] M72: Strict DNS rebinding & Host header validation tests on Agent Socket
- [ ] M73: Timing-safe token comparison (`crypto.timingSafeEqual`) on `x-troy-agent` header
- [ ] M74: Prompt-injection sanitizer flag (`--untrusted-markers`) wrapping web page text in explicit untrusted delimiters for AI safety
- [ ] M75: Configurable policy profiles (`strict`, `standard`, `permissive`) via `policy.json`
- [ ] M76: Sensitive output redaction filter (automatically masks JWTs, AWS keys `AKIA...`, credit card numbers in `page_text` / `ascii` when `--redact-secrets` is on)
- [ ] M77: Rate-limiting & body-size fuzz tests on Agent Socket HTTP server
- [ ] M78: Read-only observer mode (`--readonly`) where all mutating tools (`click`, `fill`, `eval`, `navigate`) are deterministically refused
- [ ] M79: Origin allowlist / denylist CLI flags (`--allow-origin`, `--deny-origin`) persisted in daemon config
- [ ] M80: Comprehensive security regression suite testing XSS/scheme disguises, IMDS blocking, sensitive field blocking, and submit guards

## Track 7: EC2, Cloud & Ops Excellence (Milestones 81–90)
- [ ] M81: EC2 Instance Metadata Service (IMDSv2) detection in `doctor` (instance type, region, AZ without failing outside AWS)
- [ ] M82: Daemon log rotation & `troy-advanced daemon logs [--tail N] [--follow]` command
- [ ] M83: Health-check HTTP probe + Prometheus-compatible `/metrics` endpoint (tabs, requests, memory RSS, uptime, tool latency)
- [ ] M84: Multi-profile management (`troy-advanced profile list|create|delete|export|import`)
- [ ] M85: SSH tunnel helper command (`troy-advanced ec2 tunnel <user@host>`) printing and optionally establishing secure loopback forwarding
- [ ] M86: `docker-compose.yml` for one-command EC2 deployment with persistent profile volume and healthcheck
- [ ] M87: GitHub Actions CI workflow (`.github/workflows/ci.yml`) running typecheck, build, unit tests, and headless Chrome E2E on Ubuntu Linux
- [ ] M88: Graceful memory watchdog in daemon: auto-evict idle background tabs or trigger GC hint if RSS exceeds `--max-rss-mb`
- [ ] M89: Proxy support (`--proxy http://...` / `socks5://...`, `HTTP_PROXY`/`HTTPS_PROXY`) for both Chromium and Lite engines
- [ ] M90: One-command `troy-advanced bench` measuring startup latency, ASCII render throughput, and CDP snapshot latency

## Track 8: Polish, Docs & Ecosystem (Milestones 91–105)
- [ ] M91: Interactive demo server (`scripts/demo-site.mjs`) showcasing forms, tables, dynamic JS, and canvas art in ASCII
- [ ] M92: Architecture documentation (`docs/ARCHITECTURE.md`) with ASCII system diagrams
- [ ] M93: Protocol specification (`docs/PROTOCOL.md`) documenting Agent Socket, MCP, and Pipe REPL contracts
- [ ] M94: EC2 Production Operations Guide (`docs/EC2_GUIDE.md`) covering t3/t4g sizing, IAM/IMDS hardening, systemd, and SSH tunneling
- [ ] M95: Shell completion generator (`troy-advanced completions bash|zsh|fish`)
- [ ] M96: CLI `--quiet` / `--verbose` / `--timeout` global flags with clean exit codes (`0` ok, `1` error, `2` policy refusal, `3` daemon offline)
- [ ] M97: Package export map (`exports` in `package.json`) with clean ESM subpath imports (`@anishfyi/troy-advanced/ascii`, `/engine`, `/mcp`)
- [ ] M98: ESLint / strict lint check script added to `package.json` and passing cleanly
- [ ] M99: Zero-warning TypeScript build with `noUnusedLocals` and `noUnusedParameters` enabled
- [ ] M100: Full E2E test suite verifying Daemon + Chromium + Lite + ASCII + Braille + Set-of-Marks + MCP + Pipe + Security Refusals + Memory Recall
- [ ] M101: Stress test (`scripts/stress.mjs`) opening 10 concurrent tabs and verifying sub-50ms ASCII rendering and zero leaked sockets
- [ ] M102: Automated changelog generator / `CHANGELOG.md` summarizing shipped capabilities
- [ ] M103: `troy-advanced` self-test command (`troy-advanced selftest`) verifying Lite + Chromium + ASCII + Agent Socket on any fresh EC2 box
- [ ] M104: Release readiness check & npm publish dry-run validation (`npm pack --dry-run`)
- [ ] M105: Final comprehensive audit & polish pass across all modules, docs, and tests
