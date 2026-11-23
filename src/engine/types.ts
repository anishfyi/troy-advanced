import type {
  BlockedTrackerStats,
  BrowserCookie,
  ConsoleEntry,
  CookieExportOptions,
  CookieImportResult,
  CrashRecoveryEvent,
  CrashRecoveryStats,
  EmulationOptions,
  EmulationProfile,
  EmulationUpdateMode,
  NetworkEntry,
  OriginStorageSnapshot,
  PageSnapshot,
  SettleOptions,
  SettleResult,
  StorageArea,
  StorageClearResult,
  StorageImportResult,
  WaitConditionOptions,
  WaitResult,
} from '../types.js'

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
  press(key: string, selector?: string): Promise<{ ok: boolean; normalized?: string; modifiers?: number; error?: string }>
  hover(selector: string): Promise<{ ok: boolean }>
  scroll(direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom', amount?: number): Promise<{ scrollX: number; scrollY: number }>
  waitFor(options: WaitConditionOptions): Promise<WaitResult>
  waitForSettle(options?: SettleOptions): Promise<SettleResult>
  evaluate(expression: string): Promise<unknown>
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer | null>
  getConsole(opts?: { clear?: boolean; level?: string; limit?: number }): ConsoleEntry[]
  getNetwork(opts?: { clear?: boolean; failedOnly?: boolean; blockedOnly?: boolean; limit?: number }): NetworkEntry[]
  getBlockedTrackerStats?(): BlockedTrackerStats
  getStorage(opts?: { area?: StorageArea; keyPrefix?: string }): Promise<OriginStorageSnapshot>
  setStorage(
    data: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> },
    opts?: { clearBeforeImport?: boolean },
  ): Promise<{ origin: string; localKeys: number; sessionKeys: number }>
  clearStorage(opts?: { area?: StorageArea; keys?: string[] }): Promise<{
    origin: string
    removedLocal: number
    removedSession: number
  }>
  getEmulation(): EmulationProfile
  setEmulation(opts: EmulationOptions, mode?: EmulationUpdateMode): Promise<EmulationProfile>
  close(): Promise<void>
}

export interface BrowserEngine {
  readonly kind: 'chromium' | 'lite'
  readonly cdpPort: number
  createTab(initialUrl?: string): Promise<TabDriver>
  getDefaultEmulation?(): EmulationProfile
  setDefaultEmulation?(opts: EmulationOptions, mode?: EmulationUpdateMode): EmulationProfile
  getCrashRecoveryStats?(): CrashRecoveryStats
  onCrashRecovery?(fn: (ev: CrashRecoveryEvent) => void): () => void
  exportCookies(opts?: CookieExportOptions): Promise<BrowserCookie[]>
  importCookies(cookies: BrowserCookie[]): Promise<CookieImportResult>
  clearCookies?(opts?: { domain?: string }): Promise<number>
  getEngineStorage?(opts?: { origin?: string; area?: StorageArea; keyPrefix?: string }): OriginStorageSnapshot[]
  importEngineStorage?(
    snapshots: OriginStorageSnapshot[],
    opts?: { area?: StorageArea; clearBeforeImport?: boolean },
  ): StorageImportResult
  clearEngineStorage?(opts?: { origin?: string; area?: StorageArea; keys?: string[] }): StorageClearResult
  close(): Promise<void>
}
