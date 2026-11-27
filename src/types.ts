export type EngineKind = 'chromium' | 'lite' | 'auto'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TabSummary {
  id: number
  url: string
  title: string
  active: boolean
  loading: boolean
  engine: 'chromium' | 'lite'
  ownerSession?: string
}

export interface AgentSessionSummary {
  id: string
  createdAt: number
  lastActiveAt: number
  ownedTabIds: number[]
  activeTabId: number | null
  allowedOrigins: string[]
}

export interface ElementDescriptor {
  ref?: string
  selector: string
  tag: string
  type: string
  id?: string
  name?: string
  role?: string
  text: string
  label?: string
  ariaLabel?: string
  placeholder?: string
  autocomplete?: string
  inputMode?: string
  value?: string
  valueRedacted?: boolean
  disabled?: boolean
  readOnly?: boolean
  editable?: boolean
  defaultSubmit?: boolean
  checked?: boolean
  href?: string
  formAction?: string
  formMethod?: string
  formEnctype?: string
  box?: Rect
  options?: Array<{ value: string; label: string; selected?: boolean }>
  signature?: string
  frameId?: string
  frameUrl?: string
  frameName?: string
}

export interface InlineLink {
  text: string
  ref?: string
  href?: string
  selector?: string
  start?: number
  end?: number
}

export interface ContentBlock {
  kind: 'heading' | 'paragraph' | 'link' | 'input' | 'button' | 'select' | 'list-item' | 'code' | 'table-row' | 'image' | 'canvas' | 'hr'
  text: string
  level?: number
  ref?: string
  href?: string
  src?: string
  value?: string
  placeholder?: string
  checked?: boolean
  tag?: string
  box?: Rect
  naturalWidth?: number
  naturalHeight?: number
  canvasDataUrl?: string
  asciiPreview?: string
  cells?: string[]
  isHeader?: boolean
  alt?: string
  links?: InlineLink[]
  formId?: string
  formTitle?: string
  frameId?: string
  frameUrl?: string
  frameName?: string
}

export interface FrameSummary {
  frameId: string
  parentFrameId?: string
  name?: string
  title?: string
  url: string
  selector?: string
  box?: Rect
  elementCount: number
  crossOrigin?: boolean
}

export interface MediaSummaryItem {
  kind: 'image' | 'canvas'
  label: string
  tag: string
  src?: string
  width?: number
  height?: number
  naturalWidth?: number
  naturalHeight?: number
  box?: Rect
  asciiPreview?: string
}

export interface PageSnapshot {
  tabId: number
  url: string
  title: string
  epoch: number
  viewport: { width: number; height: number; scrollX: number; scrollY: number; scrollHeight: number }
  blocks: ContentBlock[]
  elements: ElementDescriptor[]
  frames?: FrameSummary[]
  text: string
  capturedAt: number
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug'
  text: string
  ts: number
  url?: string
}

export interface NetworkEntry {
  /** Stable request identifier within the tab (e.g. `req-1`, `req-2`) for body inspection. */
  requestId?: string
  /** Underlying CDP requestId when captured via Chromium CDP. */
  cdpRequestId?: string
  url: string
  method: string
  status?: number
  statusText?: string
  ok: boolean
  resourceType?: string
  mimeType?: string
  encodedDataLength?: number
  durationMs?: number
  ts: number
  error?: string
  blocked?: boolean
  blockedReason?: string
  retries?: number
  fromCache?: boolean
  cacheStatus?: 'hit' | 'revalidated' | 'miss' | 'bypass'
  hasRequestBody?: boolean
  hasResponseBody?: boolean
}

export interface AgentActivityEntry {
  id: number
  ts: number
  tabId?: number
  sessionId?: string
  tool: string
  summary: string
  ok: boolean
  durationMs: number
  url?: string
  error?: string
}

export interface NetworkListOptions {
  clear?: boolean
  failedOnly?: boolean
  blockedOnly?: boolean
  method?: string
  urlFilter?: string
  limit?: number
}

export interface NetworkBodyInspectionOptions {
  /** Maximum characters to return per body (default: 32768, clamped 256..262144). */
  maxBodyChars?: number
  /** Pretty-print JSON bodies when valid JSON (default: true). */
  prettyJson?: boolean
  /** Reveal sensitive headers (Authorization, Cookie, X-API-Key, etc.) instead of masking (default: false). */
  revealHeaders?: boolean
  /** Include raw base64 payload for binary responses (default: false). */
  includeBinary?: boolean
}

export interface NetworkBodyPayload {
  /** Body text (UTF-8 decoded, optionally pretty-printed, or base64 if `base64Encoded` is true). */
  body?: string
  /** True when `body` is base64-encoded binary data. */
  base64Encoded?: boolean
  /** Original byte size before truncation. */
  sizeBytes?: number
  /** True when `body` was truncated to `maxBodyChars`. */
  truncated?: boolean
  /** True when the payload is detected as binary (image, audio, video, pdf, octet-stream, etc.). */
  isBinary?: boolean
  /** MIME type of the payload if known. */
  mimeType?: string
  /** True when valid JSON was pretty-printed. */
  prettyPrinted?: boolean
  /** Explanation when body is unavailable (e.g. evicted from CDP buffer, blocked, failed, or binary omitted). */
  unavailableReason?: string
}

export interface NetworkBodyResult {
  ok: boolean
  requestId: string
  entry?: NetworkEntry
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBody?: NetworkBodyPayload
  responseBody?: NetworkBodyPayload
  ascii?: string
  error?: string
}

export type TrackerBlockMode = 'fetch' | 'network' | 'both' | 'off'

export interface TrackerBlockingOptions {
  enabled?: boolean
  mode?: TrackerBlockMode
  extraBlockedHosts?: string[]
  extraBlockedUrlPatterns?: string[]
  includeBeacons?: boolean
}

export interface BlockedTrackerStats {
  enabled: boolean
  mode: TrackerBlockMode
  effectiveMode: TrackerBlockMode
  patternCount: number
  blockedCount: number
  continuedCount: number
  blockedByHost: Record<string, number>
}

export type AsciiLayoutMode = 'flow' | 'spatial' | 'auto'

export type AsciiDensity = 'compact' | 'normal' | 'wide'

export interface TokenEstimate {
  tokens: number
  chars: number
  lines: number
  words: number
  bytes: number
}

export type TokenBudgetStrategy = 'none' | 'compact' | 'trim' | 'compact+trim' | 'hard-truncate'

export interface TokenBudgetReport {
  maxTokens: number
  originalTokens: number
  finalTokens: number
  trimmed: boolean
  strategy: TokenBudgetStrategy
  droppedLines: number
  preservedRefs: number
  totalRefs: number
  originalChars: number
  finalChars: number
}

export interface TokenBudgetOptions {
  /** Prioritize preserving lines with interactive [eN] refs (default: true). */
  preserveRefs?: boolean
  /** Prioritize preserving title/URL/heading lines (default: true). */
  preserveHeadings?: boolean
  /** Keep truncation marker strict 7-bit ASCII (default: true). */
  asciiOnly?: boolean
  /** Optional line width hint for formatting the truncation notice. */
  width?: number
}

export interface AsciiRenderOptions {
  width?: number
  height?: number
  asciiOnly?: boolean
  color?: boolean
  showRefs?: boolean
  showChrome?: boolean
  showScrollbar?: boolean
  showMediaSummary?: boolean
  canvasPreviewWidth?: number
  canvasPreviewHeight?: number
  scrollOffset?: number
  layout?: AsciiLayoutMode
  density?: AsciiDensity
  crop?: Rect
  cropLabel?: string
  tabs?: TabSummary[]
  activeTabId?: number
  statusMessage?: string
  focusedRef?: string
  /** Optional LLM token budget; progressively compacts and trims ASCII output to fit <= maxTokens. */
  maxTokens?: number
}

export interface MarkdownRenderOptions {
  showRefs?: boolean
  includeUrls?: boolean
  asciiOnly?: boolean
  includeFrontmatter?: boolean
  includeHeader?: boolean
  includeForms?: boolean
  includeCanvasPreview?: boolean
  includeMediaSummary?: boolean
  includeRefsIndex?: boolean | 'always'
  canvasPreviewWidth?: number
  canvasPreviewHeight?: number
  crop?: Rect
  cropLabel?: string
}

export interface PixelAsciiOptions {
  width?: number
  height?: number
  mode?: 'ascii' | 'edge' | 'braille' | 'halfblock'
  invert?: boolean
  edgeThreshold?: number
  crop?: Rect
  overlays?: Array<{ ref: string; box: Rect }>
  overlayStyle?: 'box' | 'badge'
  viewport?: { width: number; height: number }
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; status: 'blocked' | 'boundary'; code: string; reason: string; origin?: string }

export type WaitState = 'visible' | 'hidden' | 'attached'

export interface SettleOptions {
  /** Maximum total time to wait for page settle in ms (default: 3000, max: 30000). */
  timeoutMs?: number
  /** Network quiet window with <= maxInflightRequests in ms (default: 250). */
  networkIdleMs?: number
  /** DOM mutation quiet window in ms (default: 200). */
  domQuietMs?: number
  /** Maximum inflight network requests still considered idle (default: 0). */
  maxInflightRequests?: number
  /** Wait for network idle (default: true). */
  waitForNetworkIdle?: boolean
  /** Wait for DOM mutations to settle (default: true). */
  waitForDomQuiet?: boolean
  /** Requests older than this threshold are ignored as stale/long-poll in ms (default: 5000). */
  staleRequestMs?: number
  /** Polling interval in ms (default: 40). */
  pollIntervalMs?: number
}

export interface SettleResult {
  ok: boolean
  settled: boolean
  timedOut: boolean
  waitedMs: number
  networkIdle: boolean
  domQuiet: boolean
  inflightCount: number
  mutationCount: number
  reason: 'settled' | 'timeout' | 'skipped' | 'error'
  error?: string
}

export interface WaitConditionOptions {
  ms?: number
  text?: string
  selector?: string
  url?: string
  state?: WaitState
  settle?: boolean
  networkIdleMs?: number
  domQuietMs?: number
  maxInflightRequests?: number
  timeout?: number
  pollIntervalMs?: number
}

export interface WaitResult {
  ok: boolean
  waitedMs: number
  timedOut?: boolean
  matched?: {
    text?: boolean
    selector?: boolean
    url?: boolean
    state?: WaitState
    currentUrl?: string
    settled?: boolean
  }
  settle?: SettleResult
  error?: string
}

export interface ActStep {
  op: 'click' | 'fill' | 'select' | 'press' | 'hover' | 'scroll' | 'wait' | 'text' | 'read' | 'read_ascii'
  ref?: string
  text?: string
  value?: string
  clear?: boolean
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'
  amount?: number
  ms?: number
  selector?: string
  url?: string
  state?: WaitState
  settle?: boolean
  networkIdleMs?: number
  domQuietMs?: number
  timeout?: number
  allowSubmit?: boolean
}

export interface EndpointDescriptor {
  port: number
  httpEndpoint: string
  webSocketDebuggerUrlHint: string
  remoteCdpUrl?: string
  pid: number
  version: string
  startedAt: string
  engine: 'chromium' | 'lite'
  agentPort: number
  agentToken: string
  profileDir: string
}

export type CookieSameSite = 'Strict' | 'Lax' | 'None'

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: CookieSameSite
}

export interface CookieExportOptions {
  domain?: string
  url?: string
  includeExpired?: boolean
}

export interface CookieImportResult {
  imported: number
  skipped: number
  errors: string[]
}

export interface CookieExportBundle {
  version: 1
  exportedAt: string
  engine: 'chromium' | 'lite'
  count: number
  cookies: BrowserCookie[]
}

export interface EncryptedCookieBundle {
  version: 1
  encrypted: true
  kdf: 'scrypt'
  cipher: 'aes-256-gcm'
  salt: string
  iv: string
  authTag: string
  ciphertext: string
  exportedAt: string
}

export type StorageArea = 'local' | 'session' | 'both'

export interface OriginStorageSnapshot {
  origin: string
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
}

export interface StorageExportOptions {
  origin?: string
  tabId?: number
  area?: StorageArea
  keyPrefix?: string
}

export interface StorageImportOptions {
  tabId?: number
  origin?: string
  area?: StorageArea
  clearBeforeImport?: boolean
}

export interface StorageImportResult {
  importedOrigins: number
  localKeys: number
  sessionKeys: number
  skipped: number
  errors: string[]
}

export interface StorageClearOptions {
  tabId?: number
  origin?: string
  area?: StorageArea
  keys?: string[]
}

export interface StorageClearResult {
  removedLocal: number
  removedSession: number
  origins: string[]
}

export interface StorageExportBundle {
  version: 1
  exportedAt: string
  engine: 'chromium' | 'lite'
  originCount: number
  totalKeys: number
  origins: OriginStorageSnapshot[]
}

export interface EncryptedStorageBundle {
  version: 1
  encrypted: true
  kdf: 'scrypt'
  cipher: 'aes-256-gcm'
  salt: string
  iv: string
  authTag: string
  ciphertext: string
  exportedAt: string
}

export type ViewportPresetName = 'desktop' | 'mobile' | 'terminal'

export interface ViewportConfig {
  width: number
  height: number
  deviceScaleFactor?: number
  mobile?: boolean
  hasTouch?: boolean
  preset?: ViewportPresetName | 'custom'
}

export interface EmulationProfile {
  preset: ViewportPresetName | 'custom'
  viewport: {
    width: number
    height: number
    deviceScaleFactor: number
    mobile: boolean
    hasTouch: boolean
  }
  userAgent: string
  acceptLanguage?: string
  platform?: string
  extraHeaders: Record<string, string>
}

export interface EmulationOptions {
  /** Named preset ('desktop' | 'mobile' | 'terminal') or custom 'WxH' string (e.g. '1440x900'). */
  viewport?: ViewportPresetName | string | ViewportConfig
  /** Custom User-Agent string (overrides preset default UA). */
  userAgent?: string
  /** Optional Accept-Language override (e.g. 'en-US,en;q=0.9'). */
  acceptLanguage?: string
  /** Optional navigator.platform override (e.g. 'Linux x86_64', 'iPhone'). */
  platform?: string
  /** Custom HTTP headers sent with every request. */
  extraHeaders?: Record<string, string>
}

export interface EmulationUpdateMode {
  mergeHeaders?: boolean
  clearHeaders?: boolean
  removeHeaders?: string[]
}

export interface CrashRecoveryOptions {
  /** Enable automatic Chromium crash detection and relaunch (default: true for local Chromium). */
  enabled?: boolean
  /** Maximum consecutive automatic crash recoveries before failing (default: 5). */
  maxRestarts?: number
  /** Initial backoff delay in ms before relaunching (default: 250). */
  backoffMs?: number
  /** Maximum backoff delay in ms (default: 5000). */
  maxBackoffMs?: number
  /** Reset consecutive restart counter after this many ms of healthy uptime (default: 60000). */
  resetWindowMs?: number
  /** Re-navigate open tabs to their last URLs after relaunch (default: true). */
  restoreTabs?: boolean
}

export type CrashRecoveryEventKind =
  | 'chromium_crashed'
  | 'chromium_relaunching'
  | 'chromium_recovered'
  | 'chromium_recovery_failed'

export interface CrashRecoveryEvent {
  kind: CrashRecoveryEventKind
  ts: number
  pid?: number
  exitCode?: number | null
  signal?: string | null
  restartCount: number
  maxRestarts: number
  cdpPort?: number
  profileDir?: string
  restoredTabs?: number
  error?: string
}

export type CrashRecoveryStatus = 'healthy' | 'crashed' | 'recovering' | 'failed' | 'closed'

export interface CrashRecoveryStats {
  enabled: boolean
  canRecover: boolean
  status: CrashRecoveryStatus
  pid: number | null
  cdpPort: number
  profileDir: string | null
  restartCount: number
  consecutiveRestarts: number
  totalCrashes: number
  maxRestarts: number
  lastCrashAt: number | null
  lastRecoveredAt: number | null
  lastExitCode: number | null
  lastExitSignal: string | null
  lastError: string | null
}

export type DownloadPolicyMode = 'quarantine' | 'deny' | 'allow'

export type DownloadStatus = 'in_progress' | 'quarantined' | 'blocked' | 'canceled' | 'failed'

export interface DownloadPolicyOptions {
  /**
   * Download interception mode:
   * - 'quarantine' (default): block unsafe/executable auto-downloads while quarantining safe files inside <profileDir>/quarantine (0600, non-executable).
   * - 'deny': block all auto-downloads while still capturing suggested filenames & URLs for inspection.
   * - 'allow': quarantine all downloads inside <profileDir>/quarantine (0600, non-executable).
   */
  mode?: DownloadPolicyMode
  /** Custom quarantine directory (default: <profileDir>/quarantine). */
  quarantineDir?: string
  /** Maximum permitted download size in bytes (default: 50 MiB). */
  maxBytes?: number
  /** Extra lowercase file extensions (with leading dot, e.g. '.zip') to block in quarantine mode. */
  extraBlockedExtensions?: string[]
  /** File extensions explicitly allowed even if in the default unsafe list. */
  allowedExtensions?: string[]
}

export interface DownloadEntry {
  id: string
  tabId?: number
  url: string
  suggestedFilename: string
  safeFilename: string
  extension: string
  mimeType?: string
  status: DownloadStatus
  blocked: boolean
  blockedReason?: string
  quarantinePath?: string
  bytesReceived: number
  totalBytes?: number
  sha256?: string
  startedAt: number
  completedAt?: number
}

export interface DownloadStats {
  mode: DownloadPolicyMode
  quarantineDir: string
  maxBytes: number
  total: number
  quarantined: number
  blocked: number
  inProgress: number
  failed: number
}

export type DownloadEventKind =
  | 'download_started'
  | 'download_blocked'
  | 'download_quarantined'
  | 'download_canceled'
  | 'download_failed'

export interface DownloadEvent {
  kind: DownloadEventKind
  entry: DownloadEntry
}

export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

export type DialogPolicyMode = 'dismiss' | 'accept'

export type DialogAction = 'accepted' | 'dismissed'

export interface DialogQueuedResponse {
  accept: boolean
  promptText?: string
  type?: DialogType
}

export interface DialogPolicyOptions {
  /**
   * Default handling for JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`):
   * - 'dismiss' (default): auto-dismiss dialogs so headless runs never hang (note: `beforeunload` defaults to accept unless `acceptBeforeUnload: false`).
   * - 'accept': auto-accept dialogs, supplying `defaultPromptText` (or the page's default prompt) for `prompt()`.
   */
  mode?: DialogPolicyMode
  /** Default text entered when accepting a `prompt()` dialog without a queued override. */
  defaultPromptText?: string
  /** Whether to accept `beforeunload` dialogs so headless navigation is never stalled (default: true). */
  acceptBeforeUnload?: boolean
  /** Maximum number of captured dialogs retained in memory (default: 200). */
  maxHistory?: number
}

export interface DialogEntry {
  id: string
  tabId?: number
  type: DialogType
  message: string
  url: string
  defaultPrompt?: string
  action: DialogAction
  accepted: boolean
  promptText?: string
  handledBy: 'policy' | 'queue'
  hasBrowserHandler?: boolean
  ts: number
  closedAt?: number
}

export interface DialogStats {
  mode: DialogPolicyMode
  acceptBeforeUnload: boolean
  defaultPromptText?: string
  queuedCount: number
  total: number
  alerts: number
  confirms: number
  prompts: number
  beforeUnloads: number
  accepted: number
  dismissed: number
}

export type DialogEventKind = 'dialog_handled' | 'dialog_closed'

export interface DialogEvent {
  kind: DialogEventKind
  entry: DialogEntry
}

export type AuditEventKind = 'tool_call' | 'refusal' | 'url_transition' | 'tab_action' | 'origin_grant'

export interface AuditRefusalInfo {
  status?: 'blocked' | 'boundary' | 'refused'
  code?: string
  reason: string
  origin?: string
}

export interface AuditEntry {
  seq: number
  ts: string
  tsMs: number
  kind: AuditEventKind
  tool: string
  tabId?: number
  sessionId?: string
  ok: boolean
  refused: boolean
  refusal?: AuditRefusalInfo
  durationMs: number
  args?: Record<string, unknown>
  summary?: string
  fromUrl?: string
  toUrl?: string
  urlChanged?: boolean
  error?: string
}

export interface AuditLogOptions {
  /** Enable persistent audit.jsonl recording (default: true). */
  enabled?: boolean
  /** Custom path to audit.jsonl (default: <profileDir>/audit.jsonl). */
  filePath?: string
  /** Max entries kept in the in-memory ring buffer (default: 1000). */
  maxMemoryEntries?: number
  /** Redact potentially sensitive argument keys/values before logging (default: true). */
  redactArgs?: boolean
}

export interface AuditQueryOptions {
  limit?: number
  kind?: AuditEventKind
  tool?: string
  tabId?: number
  sessionId?: string
  refusedOnly?: boolean
  urlChangedOnly?: boolean
  failedOnly?: boolean
  sinceMs?: number
  fromDisk?: boolean
}

export interface AuditStats {
  enabled: boolean
  filePath: string
  totalEntries: number
  toolCalls: number
  refusals: number
  errors: number
  urlTransitions: number
  avgDurationMs: number
  maxDurationMs: number
  byTool: Record<string, number>
  byRefusalCode: Record<string, number>
}
