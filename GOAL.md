# GOAL — troy-advanced

**Status:** IN_PROGRESS

## Mission

Build `troy-advanced` into the gold-standard **terminal-native, EC2-ready, ASCII-rendered AI browser** that:

1. Runs effortlessly inside any SSH terminal, tmux pane, Docker container, or AWS EC2 instance (x86_64 or Graviton ARM64) with zero GUI/X11 dependencies.
2. Renders every web page (and every Chromium screenshot/canvas) into crisp, readable, interactive **strict 7-bit ASCII** (plus ANSI/Braille modes) with inline `[eN]` refs so any AI model—even strictly text/ASCII-only models—can inspect, navigate, fill forms, and verify state.
3. Maintains **100% Troy Agent Socket compatibility** (`agent-endpoint.json`, `x-troy-agent`, deterministic safety refusals, opaque `eN` refs, `--since` delta reads, persistent page memory) alongside native **MCP**, **Streaming Pipe REPL**, and **Interactive ASCII TUI**.
4. Continuously advances through `ROADMAP.md` across **at least 100 autonomous 10-minute cron iterations**, shipping clean, well-tested, type-checked commits and pushing every passing iteration to `origin main`.

## Verification Gate (every iteration)

Every iteration must pass:
- `npm run typecheck`
- `npm run build`
- `npm test`
