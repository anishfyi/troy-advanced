// Shell completion generator for `troy-advanced` (bash, zsh, fish).
// Single-source-of-truth command/flag spec renders idiomatic completion scripts
// with subcommand routing, enum value completion, and file/dir path completion.

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const
export type CompletionShell = (typeof COMPLETION_SHELLS)[number]

export type CompletionValueHint = 'file' | 'dir' | 'url' | 'host' | 'number' | 'string'

export interface CompletionFlagSpec {
  /** Long flag name without leading `--`, e.g. `engine` */
  name: string
  /** Optional single-char short flag without leading `-`, e.g. `n` */
  short?: string
  /** Human-readable description */
  description: string
  /** Whether the flag consumes a following argument */
  takesValue?: boolean
  /** Fixed enum values for completion */
  values?: readonly string[]
  /** Hint for value completion when `values` is not set */
  valueHint?: CompletionValueHint
  /** Whether the flag may be repeated */
  repeatable?: boolean
}

export interface CompletionSubcommandSpec {
  name: string
  description: string
  flags?: readonly CompletionFlagSpec[]
  positionalValues?: readonly string[]
}

export interface CompletionCommandSpec {
  name: string
  description: string
  subcommands?: readonly CompletionSubcommandSpec[]
  flags?: readonly CompletionFlagSpec[]
  positionalValues?: readonly string[]
}

export interface CompletionSpec {
  defaultBinNames: readonly string[]
  globalFlags: readonly CompletionFlagSpec[]
  commands: readonly CompletionCommandSpec[]
}

export interface GenerateCompletionOptions {
  /** Binary names to register completions for (default: ['troy-advanced', 'troya']) */
  binNames?: readonly string[]
  /** Include descriptive header comments with install instructions (default: true) */
  includeHeader?: boolean
}

const DEFAULT_BIN_NAMES = ['troy-advanced', 'troya'] as const
const SAFE_BIN_RE = /^[a-zA-Z0-9._-]+$/

const ENGINE_VALUES = ['auto', 'chromium', 'lite'] as const
const POLICY_VALUES = ['strict', 'standard', 'permissive'] as const
const DENSITY_VALUES = ['compact', 'normal', 'wide'] as const
const LAYOUT_VALUES = ['flow', 'spatial', 'auto'] as const
const VISUAL_MODE_VALUES = ['ascii', 'edge', 'braille', 'halfblock'] as const
const VIEW_MODE_VALUES = ['layout', 'pixel-ascii', 'braille', 'halfblock'] as const
const INSPECTOR_VALUES = ['console', 'network', 'refs', 'activity'] as const
const NON_TTY_VALUES = ['auto', 'snapshot', 'batch', 'interactive'] as const
const SCHEMA_FORMAT_VALUES = ['openai', 'anthropic', 'gemini', 'mcp'] as const
const MCP_FRAMING_VALUES = ['auto', 'ndjson', 'content-length'] as const
const WAIT_STATE_VALUES = ['visible', 'hidden', 'attached'] as const
const FIND_ROLE_VALUES = ['button', 'input', 'link'] as const
const STORAGE_AREA_VALUES = ['local', 'session', 'both'] as const
const DIALOG_TYPE_VALUES = ['alert', 'confirm', 'prompt', 'beforeunload'] as const
const DIALOG_MODE_VALUES = ['dismiss', 'accept'] as const
const DOWNLOAD_MODE_VALUES = ['quarantine', 'deny', 'allow'] as const
const UNTRUSTED_STYLE_VALUES = ['banner', 'xml'] as const
const REDACT_MODE_VALUES = ['tag', 'partial'] as const
const STREAM_MODE_VALUES = ['ascii', 'delta', 'events'] as const
const TRACKER_MODE_VALUES = ['block', 'log', 'off'] as const
const VIEWPORT_PRESET_VALUES = ['desktop', 'mobile', 'terminal'] as const
const STRICT_HOST_KEY_VALUES = ['accept-new', 'yes', 'no'] as const

export const CLI_COMPLETION_SPEC: CompletionSpec = {
  defaultBinNames: DEFAULT_BIN_NAMES,
  globalFlags: [
    { name: 'help', description: 'Show CLI usage and help' },
    { name: 'tab', description: 'Target tab ID', takesValue: true, valueHint: 'number' },
    { name: 'session', description: 'Isolated multi-agent session ID', takesValue: true, valueHint: 'string' },
    { name: 'endpoint', description: 'Path to agent-endpoint.json', takesValue: true, valueHint: 'file' },
    { name: 'engine', description: 'Browser engine', takesValue: true, values: ENGINE_VALUES },
    { name: 'cdp-url', description: 'Remote Chrome DevTools Protocol URL', takesValue: true, valueHint: 'url' },
    { name: 'proxy', description: 'HTTP/HTTPS/SOCKS5 proxy URL', takesValue: true, valueHint: 'url' },
    { name: 'proxy-bypass', description: 'Hostnames bypassing proxy', takesValue: true, valueHint: 'host', repeatable: true },
    { name: 'no-env-proxy', description: 'Ignore HTTP_PROXY/HTTPS_PROXY environment variables' },
    { name: 'profile', description: 'Named profile or profile directory', takesValue: true, valueHint: 'dir' },
    { name: 'policy', description: 'Security policy profile', takesValue: true, values: POLICY_VALUES },
    { name: 'policy-file', description: 'Path to policy.json', takesValue: true, valueHint: 'file' },
    { name: 'allow-origin', description: 'Allow origin for agent actions', takesValue: true, valueHint: 'url', repeatable: true },
    { name: 'deny-origin', description: 'Deny origin for agent actions', takesValue: true, valueHint: 'url', repeatable: true },
    { name: 'daemon-config', description: 'Path to daemon.json config file', takesValue: true, valueHint: 'file' },
    { name: 'readonly', description: 'Read-only observer mode (refuses mutating tools)' },
    { name: 'viewport', description: 'Viewport preset or WxH', takesValue: true, values: VIEWPORT_PRESET_VALUES },
    { name: 'user-agent', description: 'Custom User-Agent header', takesValue: true, valueHint: 'string' },
    { name: 'header', short: 'H', description: 'Custom HTTP header ("Key: Value")', takesValue: true, valueHint: 'string', repeatable: true },
    { name: 'untrusted-markers', description: 'Wrap web content in untrusted prompt-injection markers' },
    { name: 'untrusted-style', description: 'Untrusted delimiter style', takesValue: true, values: UNTRUSTED_STYLE_VALUES },
    { name: 'redact-secrets', description: 'Redact JWTs, AWS keys, and card numbers in output' },
    { name: 'redact-mode', description: 'Secret redaction style', takesValue: true, values: REDACT_MODE_VALUES },
    { name: 'no-block-trackers', description: 'Disable tracker and ad-beacon blocking' },
    { name: 'tracker-mode', description: 'Tracker blocker mode', takesValue: true, values: TRACKER_MODE_VALUES },
    { name: 'oneshot', description: 'Run without an existing daemon' },
    { name: 'json', description: 'Output machine-readable JSON' },
    { name: 'ascii', description: 'Render output in strict 7-bit ASCII' },
    { name: 'width', description: 'ASCII viewport width in columns', takesValue: true, valueHint: 'number' },
    { name: 'height', description: 'ASCII viewport height in rows', takesValue: true, valueHint: 'number' },
  ],
  commands: [
    {
      name: 'daemon',
      description: 'Manage the background troy-advanced browser daemon',
      subcommands: [
        {
          name: 'start',
          description: 'Start daemon detached in background',
          flags: [
            { name: 'port', description: 'Agent Socket loopback port', takesValue: true, valueHint: 'number' },
            { name: 'url', description: 'Initial URL to open', takesValue: true, valueHint: 'url' },
            { name: 'compat-troy', description: 'Also write Troy-compatible endpoint file' },
            { name: 'log-file', description: 'Daemon log file path', takesValue: true, valueHint: 'file' },
            { name: 'log-max-bytes', description: 'Max bytes before log rotation', takesValue: true, valueHint: 'number' },
            { name: 'log-max-files', description: 'Max rotated log files to retain', takesValue: true, valueHint: 'number' },
            { name: 'max-rss-mb', description: 'Memory watchdog RSS threshold in MB', takesValue: true, valueHint: 'number' },
            { name: 'watchdog-interval-ms', description: 'Memory watchdog check interval (ms)', takesValue: true, valueHint: 'number' },
            { name: 'watchdog-idle-ttl-ms', description: 'Idle tab eviction TTL (ms)', takesValue: true, valueHint: 'number' },
            { name: 'public-metrics', description: 'Expose /metrics without auth header' },
            { name: 'no-health-probe', description: 'Disable /healthz and /readyz probes' },
            { name: 'block-private-net', description: 'Block private/IMDS networks (SSRF protection)' },
            { name: 'ssrf-allow-host', description: 'Allowlist host under SSRF protection', takesValue: true, valueHint: 'host', repeatable: true },
          ],
        },
        {
          name: 'run',
          description: 'Run daemon in foreground (systemd / Docker)',
        },
        {
          name: 'stop',
          description: 'Stop the running daemon',
        },
        {
          name: 'status',
          description: 'Show daemon status and endpoint details',
        },
        {
          name: 'logs',
          description: 'View, follow, rotate, or clear daemon logs',
          flags: [
            { name: 'tail', short: 'n', description: 'Number of lines to show', takesValue: true, valueHint: 'number' },
            { name: 'follow', short: 'f', description: 'Follow appended log output' },
            { name: 'all', description: 'Include rotated log files' },
            { name: 'rotate', description: 'Force log rotation now' },
            { name: 'clear', description: 'Clear daemon log files' },
            { name: 'log-file', description: 'Daemon log file path', takesValue: true, valueHint: 'file' },
            { name: 'log-max-files', description: 'Max rotated log files', takesValue: true, valueHint: 'number' },
          ],
        },
      ],
    },
    {
      name: 'browse',
      description: 'Launch interactive ASCII terminal browser TUI',
      flags: [
        { name: 'view', description: 'Initial view mode', takesValue: true, values: VIEW_MODE_VALUES },
        { name: 'split', description: 'Open split-pane inspector' },
        { name: 'inspector', description: 'Inspector tab to show', takesValue: true, values: INSPECTOR_VALUES },
        { name: 'non-tty', description: 'Behavior when stdin/stdout is not a TTY', takesValue: true, values: NON_TTY_VALUES },
      ],
    },
    {
      name: 'mcp',
      description: 'Start Model Context Protocol stdio server',
      flags: [
        { name: 'framing', description: 'MCP stdio framing mode', takesValue: true, values: MCP_FRAMING_VALUES },
      ],
    },
    {
      name: 'schema',
      description: 'Generate AI provider JSON tool schemas',
      flags: [
        { name: 'format', description: 'Target schema format', takesValue: true, values: SCHEMA_FORMAT_VALUES },
        { name: 'tools', description: 'Comma-separated tool allowlist', takesValue: true, valueHint: 'string' },
        { name: 'prefix', description: 'Prefix for generated tool names', takesValue: true, valueHint: 'string' },
        { name: 'strict', description: 'Enable strict JSON schema mode' },
        { name: 'compact', description: 'Output compact single-line JSON' },
        { name: 'out', description: 'Write schema JSON to file', takesValue: true, valueHint: 'file' },
      ],
    },
    {
      name: 'run',
      description: 'Execute a replayable JSON macro/flow with assertions',
      flags: [
        { name: 'var', description: 'Template variable override (key=value)', takesValue: true, valueHint: 'string', repeatable: true },
        { name: 'base-url', description: 'Base URL for relative flow URLs', takesValue: true, valueHint: 'url' },
        { name: 'dump-dir', description: 'Directory for ASCII failure dumps', takesValue: true, valueHint: 'dir' },
        { name: 'continue-on-error', description: 'Continue executing steps after a failure' },
      ],
    },
    {
      name: 'pipe',
      description: 'Start streaming stdin/stdout AI REPL',
    },
    {
      name: 'doctor',
      description: 'Check EC2 (IMDSv2), Linux, and Chromium environment',
      flags: [
        { name: 'no-imds', description: 'Skip EC2 IMDSv2 metadata probe' },
        { name: 'imds-timeout', description: 'IMDS probe timeout in ms', takesValue: true, valueHint: 'number' },
        { name: 'imds-endpoint', description: 'Override IMDS endpoint URL', takesValue: true, valueHint: 'url' },
      ],
    },
    {
      name: 'bench',
      description: 'Benchmark startup latency, ASCII throughput, and CDP snapshots',
      flags: [
        { name: 'url', description: 'Benchmark target URL', takesValue: true, valueHint: 'url' },
        { name: 'iterations', description: 'ASCII render benchmark iterations', takesValue: true, valueHint: 'number' },
        { name: 'warmup', description: 'ASCII warmup iterations', takesValue: true, valueHint: 'number' },
        { name: 'budget-ms', description: 'Per-render latency budget (ms)', takesValue: true, valueHint: 'number' },
        { name: 'startup-runs', description: 'Number of engine startup runs', takesValue: true, valueHint: 'number' },
        { name: 'snapshot-iterations', description: 'Snapshot benchmark iterations', takesValue: true, valueHint: 'number' },
        { name: 'snapshot-warmup', description: 'Snapshot warmup iterations', takesValue: true, valueHint: 'number' },
        { name: 'screenshot', description: 'Include screenshot-to-ASCII benchmark' },
        { name: 'skip-ascii', description: 'Skip ASCII layout throughput benchmark' },
        { name: 'skip-startup', description: 'Skip engine startup benchmark' },
        { name: 'skip-snapshot', description: 'Skip live snapshot latency benchmark' },
        { name: 'out', description: 'Write benchmark JSON report to file', takesValue: true, valueHint: 'file' },
      ],
    },
    {
      name: 'profile',
      description: 'Manage isolated multi-profile browser directories',
      subcommands: [
        { name: 'list', description: 'List available profiles' },
        { name: 'show', description: 'Show details for a profile' },
        {
          name: 'create',
          description: 'Create or clone a profile',
          flags: [
            { name: 'from', description: 'Clone from existing profile', takesValue: true, valueHint: 'string' },
            { name: 'description', description: 'Profile description', takesValue: true, valueHint: 'string' },
            { name: 'tag', description: 'Profile tag', takesValue: true, valueHint: 'string', repeatable: true },
          ],
        },
        { name: 'delete', description: 'Delete a profile' },
        {
          name: 'export',
          description: 'Export profile archive',
          flags: [
            { name: 'out', description: 'Output archive file path', takesValue: true, valueHint: 'file' },
          ],
        },
        {
          name: 'import',
          description: 'Import profile archive',
          flags: [
            { name: 'name', description: 'Imported profile name', takesValue: true, valueHint: 'string' },
          ],
        },
      ],
      flags: [
        { name: 'profiles-dir', description: 'Root directory for profiles', takesValue: true, valueHint: 'dir' },
      ],
    },
    {
      name: 'ec2',
      description: 'EC2 setup, Docker Compose generation, and SSH tunneling',
      subcommands: [
        { name: 'setup', description: 'Print EC2 deployment and systemd guide' },
        {
          name: 'compose',
          description: 'Generate or validate hardened EC2 docker-compose.yml',
          flags: [
            { name: 'port', description: 'Agent Socket port', takesValue: true, valueHint: 'number' },
            { name: 'shm-size', description: 'Container /dev/shm size (e.g. 1gb)', takesValue: true, valueHint: 'string' },
            { name: 'volume', description: 'Named Docker volume for profile', takesValue: true, valueHint: 'string' },
            { name: 'bind-dir', description: 'Host directory to bind-mount', takesValue: true, valueHint: 'dir' },
            { name: 'memory', description: 'Container memory limit', takesValue: true, valueHint: 'string' },
            { name: 'cpus', description: 'Container CPU limit', takesValue: true, valueHint: 'number' },
            { name: 'public-metrics', description: 'Expose /metrics publicly inside loopback' },
            { name: 'write', description: 'Write generated YAML to file', takesValue: true, valueHint: 'file' },
            { name: 'validate', description: 'Validate an existing docker-compose.yml', takesValue: true, valueHint: 'file' },
          ],
        },
        {
          name: 'tunnel',
          description: 'Print or establish secure 127.0.0.1 SSH tunnel to EC2',
          flags: [
            { name: 'local-port', description: 'Local forwarded Agent Socket port', takesValue: true, valueHint: 'number' },
            { name: 'remote-port', description: 'Remote Agent Socket port', takesValue: true, valueHint: 'number' },
            { name: 'cdp', description: 'Also forward Chromium CDP port' },
            { name: 'cdp-only', description: 'Forward only Chromium CDP port' },
            { name: 'cdp-port', description: 'Local CDP port', takesValue: true, valueHint: 'number' },
            { name: 'remote-cdp-port', description: 'Remote CDP port', takesValue: true, valueHint: 'number' },
            { name: 'identity', short: 'i', description: 'SSH private key path', takesValue: true, valueHint: 'file' },
            { name: 'ssh-port', description: 'SSH server port', takesValue: true, valueHint: 'number' },
            { name: 'jump', description: 'SSH ProxyJump bastion host', takesValue: true, valueHint: 'host' },
            { name: 'strict-host-key', description: 'SSH StrictHostKeyChecking mode', takesValue: true, values: STRICT_HOST_KEY_VALUES },
            { name: 'discover', description: 'Auto-discover remote agent-endpoint.json' },
            { name: 'write-endpoint', description: 'Write local tunneled endpoint file', takesValue: true, valueHint: 'file' },
            { name: 'connect', description: 'Spawn the SSH tunnel process' },
            { name: 'background', description: 'Run SSH tunnel in background (-f)' },
          ],
        },
      ],
    },
    {
      name: 'completions',
      description: 'Generate shell completion scripts (bash, zsh, fish)',
      positionalValues: COMPLETION_SHELLS,
      flags: [
        { name: 'bin', description: 'Binary name to register (repeatable)', takesValue: true, valueHint: 'string', repeatable: true },
        { name: 'out', description: 'Write completion script to file', takesValue: true, valueHint: 'file' },
        { name: 'install-hint', description: 'Print shell installation instructions' },
      ],
    },
    { name: 'status', description: 'Show daemon health and memory stats' },
    { name: 'health', description: 'Run HTTP health probes (/healthz, /readyz, /health)' },
    {
      name: 'metrics',
      description: 'Fetch Prometheus /metrics or ASCII metrics dashboard',
      flags: [
        { name: 'prometheus', description: 'Output raw Prometheus text exposition format' },
      ],
    },
    { name: 'tabs', description: 'List open browser tabs' },
    { name: 'open', description: 'Open a URL or search query in a new tab' },
    { name: 'focus', description: 'Focus an existing tab by ID' },
    { name: 'close', description: 'Close a tab by ID' },
    {
      name: 'ascii',
      description: 'Render tab as strict 7-bit ASCII viewport',
      flags: [
        { name: 'since', description: 'Render delta diff since last read' },
        { name: 'density', description: 'ASCII layout density', takesValue: true, values: DENSITY_VALUES },
        { name: 'layout', description: 'ASCII layout mode', takesValue: true, values: LAYOUT_VALUES },
        { name: 'max-tokens', description: 'Auto-trim output to token budget', takesValue: true, valueHint: 'number' },
        { name: 'crop', description: 'Crop region x,y,w,h', takesValue: true, valueHint: 'string' },
        { name: 'ref', description: 'Crop around element ref (e.g. e3)', takesValue: true, valueHint: 'string' },
      ],
    },
    {
      name: 'stream',
      description: 'Subscribe to live SSE /stream ASCII frames',
      flags: [
        { name: 'since', description: 'Emit delta diffs on updates' },
        { name: 'density', description: 'ASCII layout density', takesValue: true, values: DENSITY_VALUES },
        { name: 'layout', description: 'ASCII layout mode', takesValue: true, values: LAYOUT_VALUES },
        { name: 'max-tokens', description: 'Auto-trim frames to token budget', takesValue: true, valueHint: 'number' },
        { name: 'poll-ms', description: 'Poll interval in ms', takesValue: true, valueHint: 'number' },
        { name: 'throttle-ms', description: 'Minimum interval between frames (ms)', takesValue: true, valueHint: 'number' },
        { name: 'max-frames', description: 'Stop after N frames', takesValue: true, valueHint: 'number' },
        { name: 'mode', description: 'Stream output mode', takesValue: true, values: STREAM_MODE_VALUES },
      ],
    },
    {
      name: 'markdown',
      description: 'Export tab as CommonMark/GFM Markdown with [eN] refs',
      flags: [
        { name: 'frontmatter', description: 'Include YAML frontmatter' },
        { name: 'no-refs', description: 'Omit inline [eN] element refs' },
        { name: 'no-urls', description: 'Omit link URLs' },
        { name: 'media', description: 'Include image and canvas summary' },
        { name: 'crop', description: 'Crop region x,y,w,h', takesValue: true, valueHint: 'string' },
        { name: 'ref', description: 'Crop around element ref', takesValue: true, valueHint: 'string' },
      ],
    },
    {
      name: 'visual',
      description: 'Render Chromium screenshot as ASCII, edge, braille, or halfblock',
      flags: [
        { name: 'mode', description: 'Pixel rendering mode', takesValue: true, values: VISUAL_MODE_VALUES },
        { name: 'annotate', description: 'Draw Set-of-Marks bounding boxes around refs' },
        { name: 'crop', description: 'Crop region x,y,w,h', takesValue: true, valueHint: 'string' },
        { name: 'ref', description: 'Crop around element ref', takesValue: true, valueHint: 'string' },
      ],
    },
    {
      name: 'read',
      description: 'Read structured page snapshot or delta',
      flags: [
        { name: 'since', description: 'Return only changes since last read' },
        { name: 'visual', description: 'Include visual pixel rendering' },
        { name: 'max-tokens', description: 'Auto-trim output to token budget', takesValue: true, valueHint: 'number' },
        { name: 'crop', description: 'Crop region x,y,w,h', takesValue: true, valueHint: 'string' },
        { name: 'ref', description: 'Crop around element ref', takesValue: true, valueHint: 'string' },
      ],
    },
    {
      name: 'find',
      description: 'Fuzzy + synonym + ARIA element search returning eN refs',
      flags: [
        { name: 'role', description: 'Filter by ARIA role category', takesValue: true, values: FIND_ROLE_VALUES },
      ],
    },
    { name: 'text', description: 'Read text content of an element ref or full page' },
    {
      name: 'extract',
      description: 'Extract structured tables, forms, links, headings, and metadata',
      flags: [
        { name: 'sections', description: 'Comma-separated sections (tables,forms,links,headings,metadata)', takesValue: true, valueHint: 'string' },
        { name: 'max-items', description: 'Maximum items per section', takesValue: true, valueHint: 'number' },
        { name: 'external', description: 'Include only external links' },
        { name: 'internal', description: 'Include only internal links' },
      ],
    },
    {
      name: 'click',
      description: 'Click an element ref (e.g. e3)',
      flags: [
        { name: 'allow-submit', description: 'Allow clicking form submit buttons' },
      ],
    },
    {
      name: 'fill',
      description: 'Fill text into an input ref',
      flags: [
        { name: 'clear', description: 'Clear existing value before typing' },
      ],
    },
    { name: 'select', description: 'Select option value on a <select> ref' },
    {
      name: 'press',
      description: 'Send key or chord (e.g. Control+A, Shift+Tab, Escape)',
      flags: [
        { name: 'ref', description: 'Focus element ref before pressing key', takesValue: true, valueHint: 'string' },
      ],
    },
    {
      name: 'scroll',
      description: 'Scroll the active page',
      positionalValues: ['up', 'down', 'top', 'bottom'],
      flags: [
        { name: 'amount', description: 'Scroll amount in pixels', takesValue: true, valueHint: 'number' },
      ],
    },
    {
      name: 'wait',
      description: 'Wait for page text, selector, URL, or fixed timeout',
      flags: [
        { name: 'text', description: 'Wait until text appears', takesValue: true, valueHint: 'string' },
        { name: 'selector', description: 'Wait until CSS selector matches', takesValue: true, valueHint: 'string' },
        { name: 'url', description: 'Wait until URL matches pattern', takesValue: true, valueHint: 'url' },
        { name: 'state', description: 'Target element state', takesValue: true, values: WAIT_STATE_VALUES },
        { name: 'timeout', description: 'Timeout in milliseconds', takesValue: true, valueHint: 'number' },
      ],
    },
    { name: 'back', description: 'Navigate back in tab history' },
    { name: 'forward', description: 'Navigate forward in tab history' },
    { name: 'reload', description: 'Reload the active tab' },
    {
      name: 'console',
      description: 'Inspect captured browser console logs',
      flags: [
        { name: 'limit', description: 'Maximum log entries', takesValue: true, valueHint: 'number' },
        { name: 'level', description: 'Filter by log level', takesValue: true, values: ['log', 'info', 'warn', 'error', 'debug'] },
      ],
    },
    { name: 'eval', description: 'Evaluate a JavaScript expression in the page' },
    {
      name: 'network',
      description: 'Inspect network requests and response bodies',
      flags: [
        { name: 'body', description: 'Inspect request/response body for reqId', takesValue: true, valueHint: 'string' },
        { name: 'failed', description: 'Show only failed requests' },
        { name: 'blocked', description: 'Show only blocked tracker requests' },
        { name: 'method', description: 'Filter by HTTP method', takesValue: true, values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] },
        { name: 'url-filter', description: 'Filter by URL substring', takesValue: true, valueHint: 'string' },
        { name: 'reveal', description: 'Reveal redacted sensitive headers/values' },
        { name: 'raw', description: 'Output raw unformatted body' },
        { name: 'binary', description: 'Allow binary body output' },
        { name: 'max-chars', description: 'Maximum body characters', takesValue: true, valueHint: 'number' },
        { name: 'clear', description: 'Clear recorded network requests' },
      ],
    },
    {
      name: 'downloads',
      description: 'Inspect intercepted downloads or configure download policy',
      flags: [
        { name: 'blocked', description: 'Show only blocked downloads' },
        { name: 'clear', description: 'Clear download history' },
        { name: 'mode', description: 'Download policy mode', takesValue: true, values: DOWNLOAD_MODE_VALUES },
        { name: 'remove', description: 'Remove quarantined download by ID', takesValue: true, valueHint: 'string' },
      ],
    },
    {
      name: 'dialogs',
      description: 'Inspect JS dialogs or configure auto-dismiss/accept policy',
      flags: [
        { name: 'type', description: 'Dialog type', takesValue: true, values: DIALOG_TYPE_VALUES },
        { name: 'mode', description: 'Default policy action', takesValue: true, values: DIALOG_MODE_VALUES },
        { name: 'next', description: 'Queue action for next dialog', takesValue: true, values: DIALOG_MODE_VALUES },
        { name: 'prompt-text', description: 'Text to supply to next prompt()', takesValue: true, valueHint: 'string' },
        { name: 'clear', description: 'Clear captured dialog history' },
        { name: 'clear-queue', description: 'Clear queued dialog responses' },
      ],
    },
    {
      name: 'audit',
      description: 'Inspect persistent agent action audit log (audit.jsonl)',
      flags: [
        { name: 'limit', description: 'Maximum entries to show', takesValue: true, valueHint: 'number' },
        { name: 'tool', description: 'Filter by tool name', takesValue: true, valueHint: 'string' },
        { name: 'kind', description: 'Filter by audit event kind', takesValue: true, valueHint: 'string' },
        { name: 'refused', description: 'Show only policy refusals' },
        { name: 'transitions', description: 'Show only URL transitions' },
        { name: 'failed', description: 'Show only failed calls' },
        { name: 'disk', description: 'Read directly from disk audit.jsonl' },
        { name: 'file', description: 'Explicit audit.jsonl file path', takesValue: true, valueHint: 'file' },
        { name: 'clear', description: 'Clear in-memory audit buffer' },
        { name: 'truncate', description: 'Truncate audit.jsonl on disk' },
      ],
    },
    {
      name: 'policy',
      description: 'Inspect, generate, or validate policy.json profiles',
      subcommands: [
        { name: 'show', description: 'Inspect active policy profile' },
        { name: 'init', description: 'Generate policy.json template' },
        { name: 'validate', description: 'Validate a policy.json file' },
      ],
      flags: [
        { name: 'file', description: 'Path to policy.json', takesValue: true, valueHint: 'file' },
        { name: 'force', description: 'Overwrite existing policy.json' },
      ],
    },
    {
      name: 'origins',
      description: 'Inspect or update persisted origin allowlist/denylist rules',
      subcommands: [
        { name: 'list', description: 'List allowed and denied origins' },
        { name: 'allow', description: 'Add an origin to the allowlist' },
        { name: 'deny', description: 'Add an origin to the denylist' },
        { name: 'unallow', description: 'Remove an origin from the allowlist' },
        { name: 'undeny', description: 'Remove an origin from the denylist' },
        { name: 'clear', description: 'Clear all persisted origin rules' },
      ],
    },
    {
      name: 'sessions',
      description: 'List, inspect, or close isolated multi-agent sessions',
      subcommands: [
        {
          name: 'close',
          description: 'Close a named agent session',
          flags: [
            { name: 'keep-tabs', description: 'Do not close tabs owned by the session' },
          ],
        },
      ],
    },
    {
      name: 'act',
      description: 'Run a batched JSON action list',
      flags: [
        { name: 'allow-submit', description: 'Allow submit clicks inside the batch' },
      ],
    },
    { name: 'grant', description: 'Extend origin autonomy boundary for a tab' },
    { name: 'recall', description: 'Query persistent SQLite page memory' },
    { name: 'forget', description: 'Clear persistent page memory for an origin or all' },
    {
      name: 'cookies',
      description: 'Export, import, or clear browser cookies',
      subcommands: [
        {
          name: 'export',
          description: 'Export cookies to a 0600 file or stdout',
          flags: [
            { name: 'domain', description: 'Filter cookies by domain', takesValue: true, valueHint: 'host' },
            { name: 'url', description: 'Filter cookies by URL', takesValue: true, valueHint: 'url' },
            { name: 'include-expired', description: 'Include expired cookies' },
            { name: 'encrypt', description: 'Encrypt bundle with AES-256-GCM' },
            { name: 'passphrase', description: 'Encryption passphrase', takesValue: true, valueHint: 'string' },
          ],
        },
        {
          name: 'import',
          description: 'Import plain or encrypted cookie bundle',
          flags: [
            { name: 'domain', description: 'Filter imported cookies by domain', takesValue: true, valueHint: 'host' },
            { name: 'passphrase', description: 'Decryption passphrase', takesValue: true, valueHint: 'string' },
          ],
        },
        {
          name: 'clear',
          description: 'Clear cookies from daemon or profile',
          flags: [
            { name: 'domain', description: 'Clear only cookies matching domain', takesValue: true, valueHint: 'host' },
          ],
        },
      ],
    },
    {
      name: 'storage',
      description: 'Inspect, export, import, or clear localStorage/sessionStorage',
      subcommands: [
        {
          name: 'inspect',
          description: 'Inspect web storage (redacted by default)',
          flags: [
            { name: 'origin', description: 'Filter by origin or host', takesValue: true, valueHint: 'url' },
            { name: 'area', description: 'Storage area', takesValue: true, values: STORAGE_AREA_VALUES },
            { name: 'prefix', description: 'Filter by key prefix', takesValue: true, valueHint: 'string' },
            { name: 'reveal', description: 'Reveal redacted values' },
          ],
        },
        {
          name: 'export',
          description: 'Export web storage to 0600 file or stdout',
          flags: [
            { name: 'origin', description: 'Filter by origin or host', takesValue: true, valueHint: 'url' },
            { name: 'area', description: 'Storage area', takesValue: true, values: STORAGE_AREA_VALUES },
            { name: 'prefix', description: 'Filter by key prefix', takesValue: true, valueHint: 'string' },
            { name: 'encrypt', description: 'Encrypt bundle with AES-256-GCM' },
            { name: 'passphrase', description: 'Encryption passphrase', takesValue: true, valueHint: 'string' },
          ],
        },
        {
          name: 'import',
          description: 'Import plain or encrypted web storage bundle',
          flags: [
            { name: 'origin', description: 'Filter by origin or host', takesValue: true, valueHint: 'url' },
            { name: 'area', description: 'Storage area', takesValue: true, values: STORAGE_AREA_VALUES },
            { name: 'clear', description: 'Clear existing keys before import' },
            { name: 'passphrase', description: 'Decryption passphrase', takesValue: true, valueHint: 'string' },
          ],
        },
        {
          name: 'clear',
          description: 'Clear localStorage/sessionStorage entries',
          flags: [
            { name: 'origin', description: 'Filter by origin or host', takesValue: true, valueHint: 'url' },
            { name: 'area', description: 'Storage area', takesValue: true, values: STORAGE_AREA_VALUES },
            { name: 'keys', description: 'Comma-separated keys to delete', takesValue: true, valueHint: 'string' },
          ],
        },
      ],
    },
    {
      name: 'emulate',
      description: 'Configure viewport presets, User-Agent, and custom HTTP headers',
      positionalValues: VIEWPORT_PRESET_VALUES,
      flags: [
        { name: 'accept-language', description: 'Custom Accept-Language header', takesValue: true, valueHint: 'string' },
        { name: 'platform', description: 'Navigator platform override', takesValue: true, valueHint: 'string' },
        { name: 'remove-header', description: 'Remove a custom header', takesValue: true, valueHint: 'string', repeatable: true },
        { name: 'clear-headers', description: 'Clear all custom headers' },
        { name: 'all-tabs', description: 'Apply emulation settings to all open tabs' },
        { name: 'reveal', description: 'Reveal sensitive custom header values' },
      ],
    },
    { name: 'help', description: 'Show CLI usage and help' },
  ],
}

export function getCompletionSpec(): CompletionSpec {
  return CLI_COMPLETION_SPEC
}

export function parseCompletionShell(raw: string): CompletionShell | null {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'bash' || normalized === 'zsh' || normalized === 'fish') {
    return normalized
  }
  return null
}

function normalizeBinNames(binNames?: readonly string[]): string[] {
  const list = binNames && binNames.length > 0 ? [...binNames] : [...DEFAULT_BIN_NAMES]
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (!SAFE_BIN_RE.test(trimmed)) {
      throw new Error(`Invalid binary name "${raw}": only [a-zA-Z0-9._-] characters are allowed`)
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  if (out.length === 0) {
    throw new Error('At least one binary name must be provided')
  }
  return out
}

function collectAllFlags(spec: CompletionSpec): CompletionFlagSpec[] {
  const byName = new Map<string, CompletionFlagSpec>()
  const add = (flag: CompletionFlagSpec) => {
    const existing = byName.get(flag.name)
    if (!existing) {
      byName.set(flag.name, flag)
    } else if (!existing.values && flag.values) {
      byName.set(flag.name, flag)
    }
  }
  for (const f of spec.globalFlags) add(f)
  for (const cmd of spec.commands) {
    for (const f of cmd.flags ?? []) add(f)
    for (const sub of cmd.subcommands ?? []) {
      for (const f of sub.flags ?? []) add(f)
    }
  }
  return [...byName.values()]
}

function uniqueFlagNames(flags: readonly CompletionFlagSpec[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of flags) {
    const longFlag = `--${f.name}`
    if (!seen.has(longFlag)) {
      seen.add(longFlag)
      out.push(longFlag)
    }
    if (f.short) {
      const shortFlag = `-${f.short}`
      if (!seen.has(shortFlag)) {
        seen.add(shortFlag)
        out.push(shortFlag)
      }
    }
  }
  return out
}

function escapeZshSingle(text: string): string {
  return text.replace(/'/g, `'"'"'`).replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/:/g, '\\:')
}

function escapeFishSingle(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function formatInstallHint(shell?: CompletionShell): string {
  const sections: Record<CompletionShell, string> = {
    bash: [
      '# Bash (add to ~/.bashrc or install system-wide):',
      'eval "$(troy-advanced completions bash)"',
      '# Or persist to bash-completion directory:',
      'troy-advanced completions bash --out ~/.local/share/bash-completion/completions/troy-advanced',
    ].join('\n'),
    zsh: [
      '# Zsh (add to ~/.zshrc after compinit):',
      'eval "$(troy-advanced completions zsh)"',
      '# Or save to a directory in $fpath:',
      'troy-advanced completions zsh --out ~/.zsh/completions/_troy-advanced',
    ].join('\n'),
    fish: [
      '# Fish (auto-loaded from completions directory):',
      'troy-advanced completions fish --out ~/.config/fish/completions/troy-advanced.fish',
      '# Or load in current session:',
      'troy-advanced completions fish | source',
    ].join('\n'),
  }
  if (shell) return sections[shell]
  return `${sections.bash}\n\n${sections.zsh}\n\n${sections.fish}`
}

export function generateBashCompletion(options: GenerateCompletionOptions = {}): string {
  const binNames = normalizeBinNames(options.binNames)
  const includeHeader = options.includeHeader !== false
  const spec = CLI_COMPLETION_SPEC
  const allFlags = collectAllFlags(spec)

  const lines: string[] = []
  if (includeHeader) {
    lines.push('# Bash completion for troy-advanced (generated by `troy-advanced completions bash`)')
    lines.push('# Enable in current shell: eval "$(troy-advanced completions bash)"')
    lines.push('')
  }

  const topCommands = spec.commands.map((c) => c.name).join(' ')
  const globalFlagWords = uniqueFlagNames(spec.globalFlags).join(' ')

  lines.push('_troy_advanced_completions() {')
  lines.push('  local cur prev cmd sub')
  lines.push('  COMPREPLY=()')
  lines.push('  cur="${COMP_WORDS[COMP_CWORD]}"')
  lines.push('  prev=""')
  lines.push('  if [[ ${COMP_CWORD} -gt 0 ]]; then')
  lines.push('    prev="${COMP_WORDS[COMP_CWORD-1]}"')
  lines.push('  fi')
  lines.push('')
  lines.push('  # Value completion for flags that take enum values or paths')
  lines.push('  case "${prev}" in')

  for (const flag of allFlags) {
    const patterns = flag.short ? `--${flag.name}|-${flag.short}` : `--${flag.name}`
    if (flag.values && flag.values.length > 0) {
      lines.push(`    ${patterns})`)
      lines.push(`      COMPREPLY=( $(compgen -W "${flag.values.join(' ')}" -- "\${cur}") )`)
      lines.push('      return 0')
      lines.push('      ;;')
    } else if (flag.valueHint === 'file') {
      lines.push(`    ${patterns})`)
      lines.push('      COMPREPLY=( $(compgen -f -- "${cur}") )')
      lines.push('      return 0')
      lines.push('      ;;')
    } else if (flag.valueHint === 'dir') {
      lines.push(`    ${patterns})`)
      lines.push('      COMPREPLY=( $(compgen -d -- "${cur}") )')
      lines.push('      return 0')
      lines.push('      ;;')
    }
  }

  lines.push('  esac')
  lines.push('')
  lines.push('  # Find first non-flag positional command and optional subcommand')
  lines.push('  cmd=""')
  lines.push('  sub=""')
  lines.push('  local i word')
  lines.push('  for (( i=1; i < COMP_CWORD; i++ )); do')
  lines.push('    word="${COMP_WORDS[i]}"')
  lines.push('    if [[ "${word}" == -* ]]; then')
  lines.push('      continue')
  lines.push('    fi')
  lines.push('    if [[ -z "${cmd}" ]]; then')
  lines.push('      cmd="${word}"')
  lines.push('    elif [[ -z "${sub}" ]]; then')
  lines.push('      sub="${word}"')
  lines.push('      break')
  lines.push('    fi')
  lines.push('  done')
  lines.push('')
  lines.push(`  local global_flags="${globalFlagWords}"`)
  lines.push('')
  lines.push('  # Complete top-level commands or global flags')
  lines.push('  if [[ -z "${cmd}" ]]; then')
  lines.push('    if [[ "${cur}" == -* ]]; then')
  lines.push('      COMPREPLY=( $(compgen -W "${global_flags}" -- "${cur}") )')
  lines.push('    else')
  lines.push(`      COMPREPLY=( $(compgen -W "${topCommands}" -- "\${cur}") )`)
  lines.push('    fi')
  lines.push('    return 0')
  lines.push('  fi')
  lines.push('')
  lines.push('  # Subcommand, positional enum, and command-specific flag completion')
  lines.push('  case "${cmd}" in')

  for (const command of spec.commands) {
    const cmdFlags = uniqueFlagNames([...(command.flags ?? []), ...spec.globalFlags])
    const subNames = (command.subcommands ?? []).map((s) => s.name)
    const posValues = command.positionalValues ?? []

    lines.push(`    ${command.name})`)
    if (command.subcommands && command.subcommands.length > 0) {
      lines.push('      if [[ -z "${sub}" && "${cur}" != -* ]]; then')
      lines.push(`        COMPREPLY=( $(compgen -W "${subNames.join(' ')}" -- "\${cur}") )`)
      lines.push('        return 0')
      lines.push('      fi')
      lines.push('      case "${sub}" in')
      for (const s of command.subcommands) {
        const subFlags = uniqueFlagNames([
          ...(s.flags ?? []),
          ...(command.flags ?? []),
          ...spec.globalFlags,
        ])
        lines.push(`        ${s.name})`)
        if (s.positionalValues && s.positionalValues.length > 0) {
          lines.push('          if [[ "${cur}" != -* ]]; then')
          lines.push(`            COMPREPLY=( $(compgen -W "${s.positionalValues.join(' ')}" -- "\${cur}") )`)
          lines.push('            return 0')
          lines.push('          fi')
        }
        lines.push(`          COMPREPLY=( $(compgen -W "${subFlags.join(' ')}" -- "\${cur}") )`)
        lines.push('          return 0')
        lines.push('          ;;')
      }
      lines.push('      esac')
      lines.push(`      COMPREPLY=( $(compgen -W "${cmdFlags.join(' ')}" -- "\${cur}") )`)
      lines.push('      return 0')
    } else if (posValues.length > 0) {
      lines.push('      if [[ "${cur}" == -* ]]; then')
      lines.push(`        COMPREPLY=( $(compgen -W "${cmdFlags.join(' ')}" -- "\${cur}") )`)
      lines.push('      else')
      lines.push(`        COMPREPLY=( $(compgen -W "${posValues.join(' ')}" -- "\${cur}") )`)
      lines.push('      fi')
      lines.push('      return 0')
    } else {
      lines.push('      if [[ "${cur}" == -* ]]; then')
      lines.push(`        COMPREPLY=( $(compgen -W "${cmdFlags.join(' ')}" -- "\${cur}") )`)
      lines.push('        return 0')
      lines.push('      fi')
    }
    lines.push('      ;;')
  }

  lines.push('  esac')
  lines.push('')
  lines.push('  if [[ "${cur}" == -* ]]; then')
  lines.push('    COMPREPLY=( $(compgen -W "${global_flags}" -- "${cur}") )')
  lines.push('  fi')
  lines.push('  return 0')
  lines.push('}')
  lines.push('')
  for (const bin of binNames) {
    lines.push(`complete -F _troy_advanced_completions ${bin}`)
  }
  lines.push('')
  return lines.join('\n')
}

function formatZshFlagArg(flag: CompletionFlagSpec): string {
  const desc = escapeZshSingle(flag.description)
  const repeat = flag.repeatable ? '*' : ''
  const optSpec = flag.short
    ? `'(${flag.repeatable ? '' : `-${flag.short} --${flag.name}`})'{-${flag.short},--${flag.name}}'[${desc}]'`
    : `'${repeat}--${flag.name}[${desc}]'`

  if (!flag.takesValue) {
    return optSpec
  }

  let valueAction = ''
  if (flag.values && flag.values.length > 0) {
    valueAction = `:${flag.name}:(${flag.values.join(' ')})`
  } else if (flag.valueHint === 'file') {
    valueAction = `:${flag.name}:_files`
  } else if (flag.valueHint === 'dir') {
    valueAction = `:${flag.name}:_files -/`
  } else {
    valueAction = `:${flag.name}:`
  }

  if (flag.short) {
    return `'(${flag.repeatable ? '' : `-${flag.short} --${flag.name}`})'{-${flag.short},--${flag.name}}'[${desc}]${valueAction}'`
  }
  return `'${repeat}--${flag.name}[${desc}]${valueAction}'`
}

export function generateZshCompletion(options: GenerateCompletionOptions = {}): string {
  const binNames = normalizeBinNames(options.binNames)
  const includeHeader = options.includeHeader !== false
  const spec = CLI_COMPLETION_SPEC

  const lines: string[] = []
  lines.push(`#compdef ${binNames.join(' ')}`)
  if (includeHeader) {
    lines.push('# Zsh completion for troy-advanced (generated by `troy-advanced completions zsh`)')
    lines.push('# Enable in current shell: eval "$(troy-advanced completions zsh)"')
    lines.push('')
  }

  lines.push('_troy_advanced() {')
  lines.push('  local context state state_descr line')
  lines.push('  typeset -A opt_args')
  lines.push('')
  lines.push('  local -a commands')
  lines.push('  commands=(')
  for (const cmd of spec.commands) {
    lines.push(`    '${cmd.name}:${escapeZshSingle(cmd.description)}'`)
  }
  lines.push('  )')
  lines.push('')
  lines.push('  local -a global_args')
  lines.push('  global_args=(')
  for (const flag of spec.globalFlags) {
    lines.push(`    ${formatZshFlagArg(flag)}`)
  }
  lines.push('  )')
  lines.push('')
  lines.push('  _arguments -C \\')
  lines.push('    "${global_args[@]}" \\')
  lines.push("    '1:command:->cmd' \\")
  lines.push("    '*::arg:->args'")
  lines.push('')
  lines.push('  case "$state" in')
  lines.push('    cmd)')
  lines.push("      _describe -t commands 'troy-advanced command' commands")
  lines.push('      ;;')
  lines.push('    args)')
  lines.push('      case "$words[1]" in')

  for (const cmd of spec.commands) {
    lines.push(`        ${cmd.name})`)
    const cmdFlags = cmd.flags ?? []
    if (cmd.subcommands && cmd.subcommands.length > 0) {
      lines.push('          local -a subcommands')
      lines.push('          subcommands=(')
      for (const sub of cmd.subcommands) {
        lines.push(`            '${sub.name}:${escapeZshSingle(sub.description)}'`)
      }
      lines.push('          )')
      lines.push('          if (( CURRENT == 2 )); then')
      lines.push(`            _describe -t subcommands '${cmd.name} subcommand' subcommands`)
      lines.push('            return')
      lines.push('          fi')
      lines.push('          case "$words[2]" in')
      for (const sub of cmd.subcommands) {
        lines.push(`            ${sub.name})`)
        lines.push('              _arguments -s \\')
        for (const f of [...(sub.flags ?? []), ...cmdFlags]) {
          lines.push(`                ${formatZshFlagArg(f)} \\`)
        }
        lines.push('                "${global_args[@]}"')
        lines.push('              ;;')
      }
      lines.push('            *)')
      lines.push('              _arguments -s "${global_args[@]}"')
      lines.push('              ;;')
      lines.push('          esac')
    } else if (cmd.positionalValues && cmd.positionalValues.length > 0) {
      lines.push('          _arguments -s \\')
      for (const f of cmdFlags) {
        lines.push(`            ${formatZshFlagArg(f)} \\`)
      }
      lines.push('            "${global_args[@]}" \\')
      lines.push(`            '1:${cmd.name} argument:(${cmd.positionalValues.join(' ')})'`)
    } else if (cmdFlags.length > 0) {
      lines.push('          _arguments -s \\')
      for (const f of cmdFlags) {
        lines.push(`            ${formatZshFlagArg(f)} \\`)
      }
      lines.push('            "${global_args[@]}"')
    } else {
      lines.push('          _arguments -s "${global_args[@]}"')
    }
    lines.push('          ;;')
  }

  lines.push('      esac')
  lines.push('      ;;')
  lines.push('  esac')
  lines.push('}')
  lines.push('')
  lines.push('if [[ -n "${ZSH_VERSION:-}" ]] && (( $+functions[compdef] )); then')
  lines.push(`  compdef _troy_advanced ${binNames.join(' ')}`)
  lines.push('fi')
  lines.push('')
  return lines.join('\n')
}

function formatFishFlagLine(
  bin: string,
  condition: string | null,
  flag: CompletionFlagSpec,
): string {
  const parts: string[] = [`complete -c ${bin}`]
  if (condition) {
    parts.push(`-n '${condition}'`)
  }
  if (flag.short) {
    parts.push(`-s ${flag.short}`)
  }
  parts.push(`-l ${flag.name}`)
  if (flag.takesValue) {
    parts.push('-r')
    if (flag.values && flag.values.length > 0) {
      parts.push('-f')
      parts.push(`-a '${flag.values.join(' ')}'`)
    } else if (flag.valueHint === 'file' || flag.valueHint === 'dir') {
      parts.push('-F')
    }
  }
  parts.push(`-d '${escapeFishSingle(flag.description)}'`)
  return parts.join(' ')
}

export function generateFishCompletion(options: GenerateCompletionOptions = {}): string {
  const binNames = normalizeBinNames(options.binNames)
  const includeHeader = options.includeHeader !== false
  const spec = CLI_COMPLETION_SPEC

  const lines: string[] = []
  if (includeHeader) {
    lines.push('# Fish completion for troy-advanced (generated by `troy-advanced completions fish`)')
    lines.push('# Install: troy-advanced completions fish --out ~/.config/fish/completions/troy-advanced.fish')
    lines.push('')
  }

  for (const bin of binNames) {
    lines.push(`# Completions for ${bin}`)
    // Global flags
    for (const flag of spec.globalFlags) {
      lines.push(formatFishFlagLine(bin, null, flag))
    }

    // Top-level commands
    for (const cmd of spec.commands) {
      lines.push(
        `complete -c ${bin} -n '__fish_use_subcommand' -f -a '${cmd.name}' -d '${escapeFishSingle(cmd.description)}'`,
      )
    }

    // Subcommands, positional values, and command-specific flags
    for (const cmd of spec.commands) {
      if (cmd.subcommands && cmd.subcommands.length > 0) {
        const subList = cmd.subcommands.map((s) => s.name).join(' ')
        const noSubCond = `__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${subList}`
        for (const sub of cmd.subcommands) {
          lines.push(
            `complete -c ${bin} -n '${noSubCond}' -f -a '${sub.name}' -d '${escapeFishSingle(sub.description)}'`,
          )
          const subCond = `__fish_seen_subcommand_from ${cmd.name}; and __fish_seen_subcommand_from ${sub.name}`
          for (const flag of sub.flags ?? []) {
            lines.push(formatFishFlagLine(bin, subCond, flag))
          }
        }
      }

      if (cmd.positionalValues && cmd.positionalValues.length > 0) {
        const valList = cmd.positionalValues.join(' ')
        const posCond = `__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${valList}`
        lines.push(
          `complete -c ${bin} -n '${posCond}' -f -a '${valList}'`,
        )
      }

      if (cmd.flags && cmd.flags.length > 0) {
        const cmdCond = `__fish_seen_subcommand_from ${cmd.name}`
        for (const flag of cmd.flags) {
          lines.push(formatFishFlagLine(bin, cmdCond, flag))
        }
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function generateShellCompletion(
  shell: CompletionShell,
  options: GenerateCompletionOptions = {},
): string {
  switch (shell) {
    case 'bash':
      return generateBashCompletion(options)
    case 'zsh':
      return generateZshCompletion(options)
    case 'fish':
      return generateFishCompletion(options)
  }
}
