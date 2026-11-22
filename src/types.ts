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
}

export interface ContentBlock {
  kind: 'heading' | 'paragraph' | 'link' | 'input' | 'button' | 'select' | 'list-item' | 'code' | 'table-row' | 'image' | 'hr'
  text: string
  level?: number
  ref?: string
  href?: string
  value?: string
  placeholder?: string
  checked?: boolean
  tag?: string
  box?: Rect
  cells?: string[]
  alt?: string
}

export interface PageSnapshot {
  tabId: number
  url: string
  title: string
  epoch: number
  viewport: { width: number; height: number; scrollX: number; scrollY: number; scrollHeight: number }
  blocks: ContentBlock[]
  elements: ElementDescriptor[]
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
}

export type AsciiLayoutMode = 'flow' | 'spatial' | 'auto'

export interface AsciiRenderOptions {
  width?: number
  height?: number
  asciiOnly?: boolean
  color?: boolean
  showRefs?: boolean
  showChrome?: boolean
  scrollOffset?: number
  layout?: AsciiLayoutMode
  tabs?: TabSummary[]
  activeTabId?: number
  statusMessage?: string
}

export interface PixelAsciiOptions {
  width?: number
  height?: number
  mode?: 'ascii' | 'braille' | 'halfblock'
  invert?: boolean
  overlays?: Array<{ ref: string; box: Rect }>
  viewport?: { width: number; height: number }
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; status: 'blocked' | 'boundary'; code: string; reason: string; origin?: string }

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
