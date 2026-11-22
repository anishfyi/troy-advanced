import type { BlockedTrackerStats, ConsoleEntry, NetworkEntry, PageSnapshot, WaitConditionOptions, WaitResult } from '../types.js'

export interface TabDriver {
  readonly id: number
  readonly engine: 'chromium' | 'lite'
  getUrl(): string
  getTitle(): string
  isLoading(): boolean
  getEpoch(): number
  navigate(url: string): Promise<{ url: string; title: string }>
  history(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string }>
  snapshot(): Promise<PageSnapshot>
  click(selector: string): Promise<{ ok: boolean; note?: string }>
  fill(selector: string, text: string, clear?: boolean): Promise<{ ok: boolean; value?: string }>
  select(selector: string, value: string): Promise<{ ok: boolean; value?: string }>
  press(key: string, selector?: string): Promise<{ ok: boolean }>
  hover(selector: string): Promise<{ ok: boolean }>
  scroll(direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom', amount?: number): Promise<{ scrollX: number; scrollY: number }>
  waitFor(options: WaitConditionOptions): Promise<WaitResult>
  evaluate(expression: string): Promise<unknown>
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer | null>
  getConsole(opts?: { clear?: boolean; level?: string; limit?: number }): ConsoleEntry[]
  getNetwork(opts?: { clear?: boolean; failedOnly?: boolean; blockedOnly?: boolean; limit?: number }): NetworkEntry[]
  getBlockedTrackerStats?(): BlockedTrackerStats
  close(): Promise<void>
}

export interface BrowserEngine {
  readonly kind: 'chromium' | 'lite'
  readonly cdpPort: number
  createTab(initialUrl?: string): Promise<TabDriver>
  close(): Promise<void>
}
