import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AD_BEACON_URL_PATTERNS,
  BLOCKED_TRACKER_HOSTS,
  buildCdpTrackerUrlPatterns,
  isTrackerHost,
  isTrackerOrBeaconUrl,
  matchesUrlWildcard,
} from '../src/agent/omnibox.js'
import { CdpTrackerBlocker, type CdpLike } from '../src/engine/tracker-blocker.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import { BrowserManager } from '../src/engine/manager.js'
import type { BlockedTrackerStats, NetworkEntry } from '../src/types.js'

class MockCdp implements CdpLike {
  sent: Array<{ method: string; params?: Record<string, unknown> }> = []
  listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  failMethods = new Set<string>()

  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  async send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    this.sent.push({ method, params })
    if (this.failMethods.has(method)) {
      throw new Error(`Mock CDP error: ${method} unsupported`)
    }
    return {} as T
  }

  emit(method: string, params: Record<string, unknown>): void {
    const set = this.listeners.get(method)
    if (!set) return
    for (const fn of set) fn(params)
  }
}

describe('omnibox tracker list & CDP URL pattern builders (M16)', () => {
  it('matches all core tracker hosts on apex and subdomains without false positives', () => {
    for (const host of BLOCKED_TRACKER_HOSTS) {
      expect(isTrackerHost(`https://${host}/pixel.js`)).toBe(true)
      expect(isTrackerHost(`https://sub.${host}/collect`)).toBe(true)
    }
    expect(isTrackerHost('https://example.com/app.js')).toBe(false)
    // Tracker name in query string or path must NOT match as tracker host
    expect(isTrackerHost('https://example.com/?next=https://doubleclick.net/x')).toBe(false)
    expect(isTrackerHost('https://notdoubleclick.net/x')).toBe(false)
  })

  it('classifies tracker hosts, ad beacons, and custom patterns via isTrackerOrBeaconUrl', () => {
    expect(isTrackerOrBeaconUrl('https://www.google-analytics.com/collect')).toMatchObject({
      blocked: true,
      reason: 'tracker-host',
      matched: 'google-analytics.com',
    })
    expect(isTrackerOrBeaconUrl('https://example.com/__utm.gif?utmac=UA-1')).toMatchObject({
      blocked: true,
      reason: 'ad-beacon',
    })
    expect(isTrackerOrBeaconUrl('https://example.com/pagead/1p-conversion/123/')).toMatchObject({
      blocked: true,
      reason: 'ad-beacon',
    })
    expect(
      isTrackerOrBeaconUrl('https://internal.test/telemetry', {
        extraUrlPatterns: ['*://internal.test/telemetry*'],
      }),
    ).toMatchObject({
      blocked: true,
      reason: 'custom-pattern',
    })
    expect(isTrackerOrBeaconUrl('https://example.com/api/data?ref=doubleclick.net')).toEqual({
      blocked: false,
    })
  })

  it('builds deduplicated CDP wildcard patterns matching BLOCKED_TRACKER_HOSTS and beacons', () => {
    const patterns = buildCdpTrackerUrlPatterns({
      extraHosts: ['tracker.local', '*.tracker.local'],
      extraUrlPatterns: ['*://127.0.0.1:*/custom-pixel*'],
    })
    expect(patterns).toContain('*://doubleclick.net/*')
    expect(patterns).toContain('*://*.doubleclick.net/*')
    expect(patterns).toContain('*://tracker.local/*')
    expect(patterns).toContain('*://*.tracker.local/*')
    expect(patterns).toContain('*://127.0.0.1:*/custom-pixel*')
    for (const beacon of AD_BEACON_URL_PATTERNS) {
      expect(patterns).toContain(beacon)
    }
    expect(new Set(patterns).size).toBe(patterns.length)
    expect(matchesUrlWildcard('http://127.0.0.1:8080/custom-pixel?x=1', '*://127.0.0.1:*/custom-pixel*')).toBe(true)
  })
})

describe('CdpTrackerBlocker unit tests (M16)', () => {
  it('enables Fetch.enable in default fetch mode, fails trackers, and continues false positives', async () => {
    const cdp = new MockCdp()
    const blockedEvents: string[] = []
    const blocker = new CdpTrackerBlocker(cdp, {}, { onBlocked: (ev) => blockedEvents.push(ev.url) })

    await blocker.enable()
    expect(cdp.sent[0]?.method).toBe('Fetch.enable')
    const sentPatterns = (cdp.sent[0]?.params?.patterns as Array<{ urlPattern: string }>) ?? []
    expect(sentPatterns.length).toBeGreaterThanOrEqual(BLOCKED_TRACKER_HOSTS.length * 4)

    // Genuine tracker request -> Fetch.failRequest
    cdp.emit('Fetch.requestPaused', {
      requestId: 'req-1',
      request: { url: 'https://www.google-analytics.com/analytics.js', method: 'GET' },
      resourceType: 'Script',
    })
    // Ad beacon -> Fetch.failRequest
    cdp.emit('Fetch.requestPaused', {
      requestId: 'req-2',
      request: { url: 'https://shop.example.com/__utm.gif?a=1', method: 'GET' },
      resourceType: 'Image',
    })
    // False positive (tracker host only in query string) -> Fetch.continueRequest
    cdp.emit('Fetch.requestPaused', {
      requestId: 'req-3',
      request: { url: 'https://docs.example.com/search?q=doubleclick.net', method: 'GET' },
      resourceType: 'Fetch',
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(cdp.sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'req-1', errorReason: 'BlockedByClient' },
    })
    expect(cdp.sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'req-2', errorReason: 'BlockedByClient' },
    })
    expect(cdp.sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: 'req-3' },
    })
    expect(blockedEvents).toEqual([
      'https://www.google-analytics.com/analytics.js',
      'https://shop.example.com/__utm.gif?a=1',
    ])

    const stats = blocker.getStats()
    expect(stats.effectiveMode).toBe('fetch')
    expect(stats.blockedCount).toBe(2)
    expect(stats.continuedCount).toBe(1)
    expect(stats.blockedByHost['www.google-analytics.com']).toBe(1)
    expect(stats.blockedByHost['shop.example.com']).toBe(1)

    await blocker.disable()
    expect(cdp.sent.at(-1)?.method).toBe('Fetch.disable')
    expect(blocker.getStats().effectiveMode).toBe('off')
  })

  it('falls back to Network.setBlockedURLs when Fetch.enable is unsupported', async () => {
    const cdp = new MockCdp()
    cdp.failMethods.add('Fetch.enable')
    const blocker = new CdpTrackerBlocker(cdp, { mode: 'fetch' })

    await blocker.enable()
    expect(cdp.sent.map((s) => s.method)).toEqual(['Fetch.enable', 'Network.setBlockedURLs'])
    expect(blocker.getStats().effectiveMode).toBe('network')

    const res = blocker.recordNetworkLevelBlock('https://connect.facebook.net/en_US/fbevents.js')
    expect(res).toEqual({ blocked: true, reason: 'tracker-host' })
    expect(blocker.getStats().blockedCount).toBe(1)
  })

  it('supports network, both, and off modes cleanly', async () => {
    const cdpNet = new MockCdp()
    const netBlocker = new CdpTrackerBlocker(cdpNet, { mode: 'network' })
    await netBlocker.enable()
    expect(cdpNet.sent.map((s) => s.method)).toEqual(['Network.setBlockedURLs'])
    expect(netBlocker.getStats().effectiveMode).toBe('network')
    await netBlocker.disable()
    expect(cdpNet.sent.at(-1)).toEqual({ method: 'Network.setBlockedURLs', params: { urls: [] } })

    const cdpBoth = new MockCdp()
    const bothBlocker = new CdpTrackerBlocker(cdpBoth, { mode: 'both' })
    await bothBlocker.enable()
    expect(cdpBoth.sent.map((s) => s.method)).toEqual(['Fetch.enable', 'Network.setBlockedURLs'])
    expect(bothBlocker.getStats().effectiveMode).toBe('both')

    const cdpOff = new MockCdp()
    const offBlocker = new CdpTrackerBlocker(cdpOff, { enabled: false })
    await offBlocker.enable()
    expect(cdpOff.sent).toEqual([])
    expect(offBlocker.getStats().effectiveMode).toBe('off')
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('Headless Chromium CDP automatic tracker & ad-beacon interception E2E (M16)', () => {
  let server: http.Server
  let baseUrl = ''
  let receivedPaths: string[] = []
  let tmpRoot: string

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-tracker-'))
    server = http.createServer((req, res) => {
      const reqUrl = req.url || '/'
      receivedPaths.push(reqUrl)

      if (reqUrl.startsWith('/api/ok')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: reqUrl }))
        return
      }
      if (reqUrl.startsWith('/__utm.gif')) {
        res.writeHead(200, { 'content-type': 'image/gif' })
        res.end('GIF89a')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
        <head><title>Tracker Interception Test</title></head>
        <body>
          <h1>Tracker Shield Active</h1>
          <div id="status">pending</div>
          <script>
            (async () => {
              const results = {};
              try {
                const r1 = await fetch('/api/ok');
                results.apiOk = r1.ok;
              } catch { results.apiOk = false; }

              try {
                const r2 = await fetch('/api/ok?ref=doubleclick.net');
                results.falsePositiveOk = r2.ok;
              } catch { results.falsePositiveOk = false; }

              try {
                await fetch('/__utm.gif?utmac=UA-12345-1');
                results.beaconBlocked = false;
              } catch { results.beaconBlocked = true; }

              try {
                await fetch('https://www.google-analytics.com/collect?v=1');
                results.gaBlocked = false;
              } catch { results.gaBlocked = true; }

              try {
                await fetch('https://doubleclick.net/pixel.gif');
                results.dcBlocked = false;
              } catch { results.dcBlocked = true; }

              navigator.sendBeacon('https://clarity.ms/collect', 'x=1');
              document.getElementById('status').textContent = JSON.stringify(results);
            })();
          </script>
        </body>
      </html>`)
    })

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()))
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('blocks tracker hosts and ad-beacons automatically via Fetch.enable while allowing legitimate requests', async () => {
    receivedPaths = []
    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir: path.join(tmpRoot, 'fetch-mode'),
    })
    try {
      const opened = await manager.openTab(baseUrl, { activate: true })
      expect(opened.ok).toBe(true)
      const tabId = opened.id!
      // Wait briefly for async fetch/beacon calls inside page script to settle
      await new Promise((r) => setTimeout(r, 350))

      const evalRes = await manager.runTool(tabId, 'page_eval', {
        expression: 'JSON.parse(document.getElementById("status").textContent)',
      })
      expect(evalRes.ok).toBe(true)
      expect(evalRes.value).toEqual({
        apiOk: true,
        falsePositiveOk: true,
        beaconBlocked: true,
        gaBlocked: true,
        dcBlocked: true,
      })

      // Local server received /api/ok and the false-positive query URL, but NEVER received /__utm.gif
      expect(receivedPaths).toContain('/api/ok')
      expect(receivedPaths).toContain('/api/ok?ref=doubleclick.net')
      expect(receivedPaths.some((p) => p.startsWith('/__utm.gif'))).toBe(false)

      const netRes = await manager.runTool(tabId, 'page_network', { blockedOnly: true })
      expect(netRes.ok).toBe(true)
      const blockedEntries = netRes.entries as NetworkEntry[]
      expect(blockedEntries.length).toBeGreaterThanOrEqual(4)
      expect(blockedEntries.every((e) => e.blocked === true)).toBe(true)
      expect(blockedEntries.some((e) => e.url.includes('google-analytics.com') && e.blockedReason === 'tracker-host')).toBe(true)
      expect(blockedEntries.some((e) => e.url.includes('doubleclick.net') && e.blockedReason === 'tracker-host')).toBe(true)
      expect(blockedEntries.some((e) => e.url.includes('clarity.ms') && e.blockedReason === 'tracker-host')).toBe(true)
      expect(blockedEntries.some((e) => e.url.includes('/__utm.gif') && e.blockedReason === 'ad-beacon')).toBe(true)

      const stats = netRes.trackerBlocking as BlockedTrackerStats
      expect(stats.enabled).toBe(true)
      expect(stats.effectiveMode).toBe('fetch')
      expect(stats.blockedCount).toBeGreaterThanOrEqual(4)
    } finally {
      await manager.close()
    }
  })

  it('blocks trackers via Network.setBlockedURLs when mode is network', async () => {
    receivedPaths = []
    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir: path.join(tmpRoot, 'network-mode'),
      trackerBlocking: { mode: 'network' },
    })
    try {
      const opened = await manager.openTab(baseUrl, { activate: true })
      expect(opened.ok).toBe(true)
      const tabId = opened.id!
      await new Promise((r) => setTimeout(r, 350))

      const evalRes = await manager.runTool(tabId, 'page_eval', {
        expression: 'JSON.parse(document.getElementById("status").textContent)',
      })
      expect(evalRes.ok).toBe(true)
      expect(evalRes.value).toMatchObject({
        apiOk: true,
        beaconBlocked: true,
        gaBlocked: true,
        dcBlocked: true,
      })
      expect(receivedPaths.some((p) => p.startsWith('/__utm.gif'))).toBe(false)

      const netRes = await manager.runTool(tabId, 'page_network', { blockedOnly: true })
      const stats = netRes.trackerBlocking as BlockedTrackerStats
      expect(stats.effectiveMode).toBe('network')
      expect(stats.blockedCount).toBeGreaterThanOrEqual(4)
    } finally {
      await manager.close()
    }
  })

  it('allows beacon requests through when trackerBlocking is explicitly disabled', async () => {
    receivedPaths = []
    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir: path.join(tmpRoot, 'disabled-mode'),
      trackerBlocking: { enabled: false },
    })
    try {
      const opened = await manager.openTab(baseUrl, { activate: true })
      expect(opened.ok).toBe(true)
      const tabId = opened.id!
      await new Promise((r) => setTimeout(r, 350))

      expect(receivedPaths.some((p) => p.startsWith('/__utm.gif'))).toBe(true)
      const netRes = await manager.runTool(tabId, 'page_network', {})
      const stats = netRes.trackerBlocking as BlockedTrackerStats
      expect(stats.enabled).toBe(false)
      expect(stats.effectiveMode).toBe('off')
      expect(stats.blockedCount).toBe(0)
    } finally {
      await manager.close()
    }
  })
})
