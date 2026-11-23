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
  url: string
  method: string
  status?: number
  ok: boolean
  resourceType?: string
  durationMs?: number
  ts: number
  error?: string
  blocked?: boolean
  blockedReason?: string
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
