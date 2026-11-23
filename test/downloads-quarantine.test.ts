import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isStrictAscii } from '../src/ascii/sanitize.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import {
  DownloadQuarantineManager,
  classifyDownload,
  formatDownloadsAscii,
  isDownloadResponse,
  parseContentDispositionFilename,
  resolveDownloadPolicy,
  sanitizeSuggestedFilename,
} from '../src/engine/downloads.js'
import { BrowserManager } from '../src/engine/manager.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

async function startDownloadServer(): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0]
    if (urlPath === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head><title>Download Test Lab</title></head>
  <body>
    <h1>Downloads</h1>
    <a id="dl-safe" href="/download/report.csv">Download Safe CSV</a>
    <a id="dl-unsafe" href="/download/payload.exe">Download Unsafe EXE</a>
    <a id="dl-script" href="/download/setup.sh">Download Unsafe SH</a>
  </body>
</html>`)
      return
    }
    if (urlPath === '/download/report.csv') {
      const payload = 'id,name,score\n1,alice,98\n2,bob,95\n'
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="report.csv"',
        'content-length': String(Buffer.byteLength(payload)),
      })
      res.end(payload)
      return
    }
    if (urlPath === '/download/payload.exe') {
      const payload = Buffer.from('MZ-fake-executable-payload-for-quarantine-test')
      res.writeHead(200, {
        'content-type': 'application/x-msdownload',
        'content-disposition': 'attachment; filename="invoice.pdf.exe"',
        'content-length': String(payload.length),
      })
      res.end(payload)
      return
    }
    if (urlPath === '/download/setup.sh') {
      const payload = Buffer.from('#!/bin/sh\necho pwned\n')
      res.writeHead(200, {
        'content-type': 'application/x-sh',
        'content-disposition': 'attachment; filename="setup.sh"',
        'content-length': String(payload.length),
      })
      res.end(payload)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('Download interception & quarantine unit logic (M27)', () => {
  it('sanitizes path traversal, control chars, and detects Unicode Bidi/RTL spoofing', () => {
    const trav = sanitizeSuggestedFilename('../../etc/passwd')
    expect(trav.displayFilename).toBe('passwd')
    expect(trav.hadPathTraversal).toBe(true)

    const winTrav = sanitizeSuggestedFilename('C:\\Windows\\System32\\evil.exe')
    expect(winTrav.displayFilename).toBe('evil.exe')
    expect(winTrav.extension).toBe('.exe')
    expect(winTrav.hadPathTraversal).toBe(true)

    const rtl = sanitizeSuggestedFilename('invoice\u202Efdp.exe')
    expect(rtl.hadRtlSpoof).toBe(true)
    expect(rtl.displayFilename).toBe('invoicefdp.exe')
    expect(rtl.extension).toBe('.exe')

    const fallback = sanitizeSuggestedFilename(undefined, 'https://example.com/files/quarterly%20report.pdf')
    expect(fallback.displayFilename).toBe('quarterly report.pdf')
    expect(fallback.extension).toBe('.pdf')
  })

  it('parses Content-Disposition filenames (standard + RFC 5987) and detects download responses', () => {
    expect(parseContentDispositionFilename('attachment; filename="report.pdf"')).toEqual({
      isAttachment: true,
      filename: 'report.pdf',
    })
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''my%20data%20file.csv")).toEqual({
      isAttachment: true,
      filename: 'my data file.csv',
    })
    expect(parseContentDispositionFilename('inline; filename="preview.png"')).toEqual({
      isAttachment: false,
      filename: 'preview.png',
    })

    expect(isDownloadResponse('attachment; filename="a.txt"', 'text/plain')).toBe(true)
    expect(isDownloadResponse(null, 'application/octet-stream')).toBe(true)
    expect(isDownloadResponse(null, 'application/x-msdownload')).toBe(true)
    expect(isDownloadResponse(null, 'application/pdf')).toBe(true)
    expect(isDownloadResponse(null, 'text/html; charset=utf-8')).toBe(false)
    expect(isDownloadResponse(null, 'application/json')).toBe(false)
  })

  it('classifies unsafe vs safe downloads across quarantine, deny, and allow modes', () => {
    const qDir = makeTempDir('troy-dl-unit-')
    const quarantinePolicy = resolveDownloadPolicy({ mode: 'quarantine', maxBytes: 1024 }, qDir)

    expect(
      classifyDownload({ suggestedFilename: 'report.pdf', url: 'https://example.com/r' }, quarantinePolicy).allowed,
    ).toBe(true)
    expect(
      classifyDownload({ suggestedFilename: 'invoice.pdf.exe', url: 'https://example.com/e' }, quarantinePolicy),
    ).toMatchObject({ allowed: false, blockedReason: 'unsafe_extension:.exe' })
    expect(
      classifyDownload({ suggestedFilename: 'install.sh', url: 'https://example.com/s' }, quarantinePolicy),
    ).toMatchObject({ allowed: false, blockedReason: 'unsafe_extension:.sh' })
    expect(
      classifyDownload(
        { suggestedFilename: 'readme.txt', url: 'https://example.com/x', mimeType: 'application/x-msdownload' },
        quarantinePolicy,
      ),
    ).toMatchObject({ allowed: false, blockedReason: 'unsafe_mime_type:application/x-msdownload' })
    expect(
      classifyDownload(
        { suggestedFilename: 'report\u202Efdp.txt', url: 'https://example.com/rtl' },
        quarantinePolicy,
      ),
    ).toMatchObject({ allowed: false, blockedReason: 'unsafe_rtl_filename_spoof' })
    expect(
      classifyDownload(
        { suggestedFilename: 'big.csv', url: 'https://example.com/big', totalBytes: 2048 },
        quarantinePolicy,
      ),
    ).toMatchObject({ allowed: false })

    // Deny mode blocks even safe files while preserving filename
    const denyPolicy = resolveDownloadPolicy({ mode: 'deny' }, qDir)
    const deniedSafe = classifyDownload({ suggestedFilename: 'report.pdf', url: 'https://example.com/r' }, denyPolicy)
    expect(deniedSafe.allowed).toBe(false)
    expect(deniedSafe.displayFilename).toBe('report.pdf')
    expect(deniedSafe.blockedReason).toBe('downloads_denied_by_policy')

    // Allow mode permits normally risky extensions (still inside quarantine)
    const allowPolicy = resolveDownloadPolicy({ mode: 'allow' }, qDir)
    expect(
      classifyDownload({ suggestedFilename: 'script.sh', url: 'https://example.com/s' }, allowPolicy).allowed,
    ).toBe(true)

    // Custom extraBlockedExtensions and allowedExtensions overrides
    const customPolicy = resolveDownloadPolicy(
      { mode: 'quarantine', extraBlockedExtensions: ['.zip'], allowedExtensions: ['.sh'] },
      qDir,
    )
    expect(
      classifyDownload({ suggestedFilename: 'archive.zip', url: 'https://example.com/a.zip' }, customPolicy),
    ).toMatchObject({ allowed: false, blockedReason: 'unsafe_extension:.zip' })
    expect(
      classifyDownload({ suggestedFilename: 'deploy.sh', url: 'https://example.com/deploy.sh' }, customPolicy).allowed,
    ).toBe(true)
  })

  it('stores quarantined files with 0600 permissions inside 0700 quarantine dir and never writes blocked files', () => {
    const profileDir = makeTempDir('troy-dl-mgr-')
    const qDir = path.join(profileDir, 'quarantine')
    const mgr = new DownloadQuarantineManager({ mode: 'quarantine' }, qDir)

    expect(fs.existsSync(qDir)).toBe(true)
    if (process.platform !== 'win32') {
      expect(fs.statSync(qDir).mode & 0o777).toBe(0o700)
    }

    const safeData = Buffer.from('hello,quarantine\n')
    const safeEntry = mgr.recordDirectBuffer({
      id: 'dl-safe-1',
      url: 'https://example.com/safe.csv',
      suggestedFilename: 'safe.csv',
      mimeType: 'text/csv',
      data: safeData,
    })
    expect(safeEntry.status).toBe('quarantined')
    expect(safeEntry.blocked).toBe(false)
    expect(safeEntry.quarantinePath).toBe(path.join(qDir, 'dl-safe-1'))
    expect(safeEntry.sha256).toBe(crypto.createHash('sha256').update(safeData).digest('hex'))
    expect(fs.existsSync(safeEntry.quarantinePath!)).toBe(true)
    if (process.platform !== 'win32') {
      expect(fs.statSync(safeEntry.quarantinePath!).mode & 0o777).toBe(0o600)
    }

    const blockedEntry = mgr.recordDirectBuffer({
      id: 'dl-evil-1',
      url: 'https://example.com/evil.exe',
      suggestedFilename: 'evil.exe',
      mimeType: 'application/x-msdownload',
      data: Buffer.from('MZ-evil'),
    })
    expect(blockedEntry.status).toBe('blocked')
    expect(blockedEntry.blocked).toBe(true)
    expect(blockedEntry.suggestedFilename).toBe('evil.exe')
    expect(blockedEntry.quarantinePath).toBeUndefined()
    expect(fs.existsSync(path.join(qDir, 'dl-evil-1'))).toBe(false)

    const ascii = formatDownloadsAscii(mgr.list(), mgr.getStats())
    expect(isStrictAscii(ascii, { allowNewlines: true })).toBe(true)
    expect(ascii).toContain('[QUARANTINED]')
    expect(ascii).toContain('[BLOCKED]')
    expect(ascii).toContain('safe.csv')
    expect(ascii).toContain('evil.exe')

    // Remove single entry & verify file deleted
    const rm = mgr.remove('dl-safe-1')
    expect(rm.ok).toBe(true)
    expect(rm.removedFile).toBe(true)
    expect(fs.existsSync(safeEntry.quarantinePath!)).toBe(false)
  })
})

describe('Lite engine + Agent Socket + MCP + Pipe download interception (M27)', () => {
  it('quarantines safe downloads, blocks unsafe downloads, and exposes inspection across Socket, MCP, and Pipe', async () => {
    const server = await startDownloadServer()
    const profileDir = makeTempDir('troy-dl-lite-')
    const manager = await BrowserManager.create({ engine: 'lite', profileDir })
    const socket = await createAgentSocket(manager, { port: 0 })

    try {
      const opened = await manager.openTab(`${server.url}/`, { activate: true })
      expect(opened.ok).toBe(true)

      // Safe CSV download
      await manager.runTool(opened.tabId, 'page_navigate', { url: `${server.url}/download/report.csv` })
      // Unsafe EXE download
      await manager.runTool(opened.tabId, 'page_navigate', { url: `${server.url}/download/payload.exe` })
      // Unsafe SH download
      await manager.runTool(opened.tabId, 'page_navigate', { url: `${server.url}/download/setup.sh` })

      const entries = manager.getDownloads()
      expect(entries.length).toBe(3)

      const safe = entries.find((e) => e.suggestedFilename === 'report.csv')
      const exe = entries.find((e) => e.suggestedFilename === 'invoice.pdf.exe')
      const sh = entries.find((e) => e.suggestedFilename === 'setup.sh')

      expect(safe?.status).toBe('quarantined')
      expect(safe?.quarantinePath?.startsWith(path.join(profileDir, 'quarantine'))).toBe(true)
      expect(fs.existsSync(safe!.quarantinePath!)).toBe(true)

      expect(exe?.status).toBe('blocked')
      expect(exe?.blocked).toBe(true)
      expect(exe?.blockedReason).toBe('unsafe_extension:.exe')
      expect(exe?.quarantinePath).toBeUndefined()

      expect(sh?.status).toBe('blocked')
      expect(sh?.blocked).toBe(true)
      expect(sh?.blockedReason).toBe('unsafe_extension:.sh')

      // Agent Socket /downloads + /health
      const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
        headers: { 'x-troy-agent': socket.token },
      })
      const health = (await healthRes.json()) as { ok: boolean; downloads: { quarantined: number; blocked: number } }
      expect(health.ok).toBe(true)
      expect(health.downloads.quarantined).toBe(1)
      expect(health.downloads.blocked).toBe(2)

      const dlRes = await fetch(`http://127.0.0.1:${socket.port}/downloads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-troy-agent': socket.token },
        body: JSON.stringify({ blockedOnly: true }),
      })
      const dlBody = (await dlRes.json()) as { ok: boolean; count: number; entries: Array<{ suggestedFilename: string }> }
      expect(dlBody.ok).toBe(true)
      expect(dlBody.count).toBe(2)
      expect(dlBody.entries.map((e) => e.suggestedFilename)).toEqual(['invoice.pdf.exe', 'setup.sh'])

      // MCP troy_downloads
      const mcpRes = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'troy_downloads', arguments: {} },
      })) as { result: { content: Array<{ text: string }> } }
      const mcpJson = JSON.parse(mcpRes.result.content[0]!.text) as { ok: boolean; count: number }
      expect(mcpJson.ok).toBe(true)
      expect(mcpJson.count).toBe(3)

      // Pipe REPL downloads mode deny + clear
      const pipeMode = await executePipeCommand(manager, 'downloads mode deny', { jsonMode: true })
      const pipeModeJson = JSON.parse(pipeMode.output) as { ok: boolean; stats: { mode: string } }
      expect(pipeModeJson.ok).toBe(true)
      expect(pipeModeJson.stats.mode).toBe('deny')

      const pipeClear = await executePipeCommand(manager, 'downloads clear', { jsonMode: true })
      const pipeClearJson = JSON.parse(pipeClear.output) as { ok: boolean; cleared: number; removedFiles: number }
      expect(pipeClearJson.ok).toBe(true)
      expect(pipeClearJson.cleared).toBe(3)
      expect(pipeClearJson.removedFiles).toBe(1)
      expect(fs.existsSync(safe!.quarantinePath!)).toBe(false)
    } finally {
      await socket.close()
      await manager.close()
      await server.close()
    }
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('Headless Chromium CDP download interception & quarantine E2E (M27)', () => {
  it('quarantines safe downloads into <profileDir>/quarantine (0600) and cancels unsafe auto-downloads while preserving filenames', async () => {
    const server = await startDownloadServer()
    const profileDir = makeTempDir('troy-dl-chrome-')
    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir,
      downloads: { mode: 'quarantine' },
    })

    const waitForDownloadCount = async (expectedCount: number, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const list = manager.getDownloads()
        if (list.length >= expectedCount && list.every((e) => e.status !== 'in_progress')) {
          return list
        }
        await new Promise((r) => setTimeout(r, 80))
      }
      return manager.getDownloads()
    }

    try {
      const opened = await manager.openTab(`${server.url}/`, { activate: true })
      expect(opened.ok).toBe(true)
      const tabId = opened.tabId!

      // Read page to bind refs
      const read = await manager.runTool(tabId, 'page_read', {})
      expect(read.ok).toBe(true)
      const findSafe = (await manager.runTool(tabId, 'page_find', { query: 'Download Safe CSV' })) as {
        matches: Array<{ ref: string }>
      }
      const findUnsafe = (await manager.runTool(tabId, 'page_find', { query: 'Download Unsafe EXE' })) as {
        matches: Array<{ ref: string }>
      }
      expect(findSafe.matches.length).toBeGreaterThan(0)
      expect(findUnsafe.matches.length).toBeGreaterThan(0)

      // 1. Trigger safe CSV download
      await manager.runTool(tabId, 'page_click', { ref: findSafe.matches[0]!.ref })
      const afterSafe = await waitForDownloadCount(1)
      expect(afterSafe.length).toBe(1)
      const safeEntry = afterSafe[0]!
      expect(safeEntry.status).toBe('quarantined')
      expect(safeEntry.blocked).toBe(false)
      expect(safeEntry.suggestedFilename).toBe('report.csv')
      expect(safeEntry.quarantinePath).toBeTruthy()
      expect(safeEntry.quarantinePath!.startsWith(path.join(profileDir, 'quarantine'))).toBe(true)
      expect(fs.existsSync(safeEntry.quarantinePath!)).toBe(true)
      expect(fs.readFileSync(safeEntry.quarantinePath!, 'utf8')).toContain('1,alice,98')
      if (process.platform !== 'win32') {
        expect(fs.statSync(safeEntry.quarantinePath!).mode & 0o777).toBe(0o600)
      }

      // 2. Trigger unsafe EXE download -> must be blocked and NOT left in quarantine dir
      await manager.runTool(tabId, 'page_click', { ref: findUnsafe.matches[0]!.ref })
      const afterUnsafe = await waitForDownloadCount(2)
      expect(afterUnsafe.length).toBe(2)
      const unsafeEntry = afterUnsafe[1]!
      expect(unsafeEntry.status).toBe('blocked')
      expect(unsafeEntry.blocked).toBe(true)
      expect(unsafeEntry.suggestedFilename).toBe('invoice.pdf.exe')
      expect(unsafeEntry.blockedReason).toBe('unsafe_extension:.exe')
      expect(unsafeEntry.quarantinePath).toBeUndefined()
      expect(fs.existsSync(path.join(profileDir, 'quarantine', unsafeEntry.id))).toBe(false)

      // 3. Switch policy to deny -> even safe CSV is now blocked while filename is still inspectable
      manager.setDownloadPolicy({ mode: 'deny' })
      await manager.runTool(tabId, 'page_click', { ref: findSafe.matches[0]!.ref })
      const afterDeny = await waitForDownloadCount(3)
      expect(afterDeny.length).toBe(3)
      const deniedEntry = afterDeny[2]!
      expect(deniedEntry.status).toBe('blocked')
      expect(deniedEntry.blocked).toBe(true)
      expect(deniedEntry.suggestedFilename).toBe('report.csv')
      expect(deniedEntry.blockedReason).toBe('downloads_denied_by_policy')
      expect(fs.existsSync(path.join(profileDir, 'quarantine', deniedEntry.id))).toBe(false)

      // 4. Clear downloads & verify quarantined file is purged
      const cleared = manager.clearDownloads({ deleteFiles: true })
      expect(cleared.cleared).toBe(3)
      expect(cleared.removedFiles).toBe(1)
      expect(fs.existsSync(safeEntry.quarantinePath!)).toBe(false)
    } finally {
      await manager.close()
      await server.close()
    }
  }, 20000)
})
