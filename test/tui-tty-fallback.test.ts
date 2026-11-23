import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import {
  TerminalBrowserController,
  runTerminalBrowser,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'
import {
  detectTtyCapabilities,
  formatFallbackNotice,
  hasAnsiEscapes,
  isBrokenPipeError,
  parseNonTtyPolicy,
  safeWriteStream,
  sanitizeNonTtyOutput,
  stripAnsiSequences,
  type TuiStderrStream,
} from '../src/tui/tty-fallback.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? false
  stream.columns = opts.columns ?? 96
  stream.rows = opts.rows ?? 24
  stream.on('data', (chunk) => {
    chunks.push(chunk.toString('utf8'))
  })
  return {
    stream,
    chunks,
    getText: () => chunks.join(''),
  }
}

function createMockStderr(isTTY = false) {
  const chunks: string[] = []
  const stream: TuiStderrStream = {
    isTTY,
    write(chunk: string | Uint8Array): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    },
  }
  return {
    stream,
    chunks,
    getText: () => chunks.join(''),
  }
}

function createMockInput(opts: { isTTY?: boolean } = {}) {
  const stream = new PassThrough() as unknown as TuiInputStream & PassThrough
  const rawModeCalls: boolean[] = []
  stream.isTTY = opts.isTTY ?? false
  stream.setRawMode = (mode: boolean) => {
    rawModeCalls.push(mode)
  }
  return { stream, rawModeCalls }
}

describe('M51: Non-TTY / piped fallback detection for TUI', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/next') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><title>Next Destination</title></head><body>
          <h1>SECOND PAGE REACHED</h1>
          <p>Clean piped navigation succeeded.</p>
          <a href="/">Back Home</a>
        </body></html>`)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Piped Home</title></head><body>
        <h1>TUI NON-TTY HOME</h1>
        <p>Welcome to the terminal-native browser.</p>
        <a href="/next">Go to Next Page</a>
        <p>Line 1 of content</p>
        <p>Line 2 of content</p>
        <p>Line 3 of content</p>
      </body></html>`)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      baseUrl = `http://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  describe('detectTtyCapabilities and pure fallback helpers', () => {
    it('detects interactive-tty when both stdin and stdout are TTYs and TERM is capable', () => {
      const caps = detectTtyCapabilities({
        input: { isTTY: true },
        output: { isTTY: true },
        stderr: { isTTY: true },
        env: { TERM: 'xterm-256color' },
      })

      expect(caps.mode).toBe('interactive-tty')
      expect(caps.allowRawMode).toBe(true)
      expect(caps.allowAnsiClear).toBe(true)
      expect(caps.allowColor).toBe(true)
      expect(caps.allowPromptEcho).toBe(true)
      expect(caps.oneShotSnapshot).toBe(false)
      expect(caps.reason).toBeNull()
      expect(formatFallbackNotice(caps)).toBeNull()
    })

    it('detects piped-snapshot when stdin is a TTY but stdout is redirected', () => {
      const caps = detectTtyCapabilities({
        input: { isTTY: true },
        output: { isTTY: false },
        stderr: { isTTY: true },
        env: { TERM: 'xterm-256color' },
      })

      expect(caps.mode).toBe('piped-snapshot')
      expect(caps.allowRawMode).toBe(false)
      expect(caps.allowAnsiClear).toBe(false)
      expect(caps.allowColor).toBe(false)
      expect(caps.allowPromptEcho).toBe(false)
      expect(caps.oneShotSnapshot).toBe(true)
      expect(caps.reason).toContain('stdout is not a TTY')
      expect(formatFallbackNotice(caps)).toContain('piped-snapshot')
    })

    it('detects piped-batch when stdin is redirected (both piped and stdin-only piped)', () => {
      const bothPiped = detectTtyCapabilities({
        input: { isTTY: false },
        output: { isTTY: false },
        env: { TERM: 'xterm-256color' },
      })
      expect(bothPiped.mode).toBe('piped-batch')
      expect(bothPiped.allowRawMode).toBe(false)
      expect(bothPiped.allowAnsiClear).toBe(false)
      expect(bothPiped.allowColor).toBe(false)
      expect(bothPiped.allowPromptEcho).toBe(false)
      expect(bothPiped.oneShotSnapshot).toBe(false)

      const stdinOnlyPiped = detectTtyCapabilities({
        input: { isTTY: false },
        output: { isTTY: true },
        env: { TERM: 'xterm-256color' },
      })
      expect(stdinOnlyPiped.mode).toBe('piped-batch')
      expect(stdinOnlyPiped.allowRawMode).toBe(false)
      expect(stdinOnlyPiped.allowAnsiClear).toBe(false)
      expect(stdinOnlyPiped.allowPromptEcho).toBe(true)
      expect(stdinOnlyPiped.oneShotSnapshot).toBe(false)
    })

    it('detects dumb-terminal when TERM=dumb and disables ANSI colors for NO_COLOR=1', () => {
      const dumb = detectTtyCapabilities({
        input: { isTTY: true },
        output: { isTTY: true },
        env: { TERM: 'dumb' },
      })
      expect(dumb.mode).toBe('dumb-terminal')
      expect(dumb.isDumbTerm).toBe(true)
      expect(dumb.allowRawMode).toBe(false)
      expect(dumb.allowAnsiClear).toBe(false)
      expect(dumb.allowColor).toBe(false)
      expect(dumb.oneShotSnapshot).toBe(false)

      const noColor = detectTtyCapabilities({
        input: { isTTY: true },
        output: { isTTY: true },
        env: { TERM: 'xterm-256color', NO_COLOR: '1' },
      })
      expect(noColor.mode).toBe('interactive-tty')
      expect(noColor.noColor).toBe(true)
      expect(noColor.allowRawMode).toBe(true)
      expect(noColor.allowColor).toBe(false)
    })

    it('parses explicit --non-tty policy overrides cleanly', () => {
      expect(parseNonTtyPolicy('auto')).toBe('auto')
      expect(parseNonTtyPolicy('SNAPSHOT')).toBe('snapshot')
      expect(parseNonTtyPolicy(' batch ')).toBe('batch')
      expect(parseNonTtyPolicy('interactive')).toBe('interactive')
      expect(parseNonTtyPolicy('bogus')).toBeUndefined()
      expect(parseNonTtyPolicy(undefined)).toBeUndefined()

      const forcedSnapshot = detectTtyCapabilities({
        input: { isTTY: true },
        output: { isTTY: true },
        nonTtyMode: 'snapshot',
        env: { TERM: 'xterm-256color' },
      })
      expect(forcedSnapshot.mode).toBe('piped-snapshot')
      expect(forcedSnapshot.oneShotSnapshot).toBe(true)
      expect(forcedSnapshot.allowRawMode).toBe(false)
      expect(forcedSnapshot.allowAnsiClear).toBe(false)
    })

    it('strips ANSI CSI/OSC escapes and unsafe control characters in sanitizeNonTtyOutput', () => {
      const dirty = '\x1b[2J\x1b[H\x1b[1;32mHello\x1b[0m \x1b]8;;https://example.com\x07Link\x1b]8;;\x07\r\nNext\x07\tTab\rLine'
      expect(hasAnsiEscapes(dirty)).toBe(true)
      expect(stripAnsiSequences(dirty)).not.toContain('\x1b')

      const clean = sanitizeNonTtyOutput(dirty)
      expect(hasAnsiEscapes(clean)).toBe(false)
      expect(clean).toBe('Hello Link\nNext\tTabLine')
    })

    it('detects broken pipe errors and handles them safely in safeWriteStream', () => {
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      const destroyed = Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' })
      const other = Object.assign(new Error('boom'), { code: 'EACCES' })

      expect(isBrokenPipeError(epipe)).toBe(true)
      expect(isBrokenPipeError(destroyed)).toBe(true)
      expect(isBrokenPipeError(other)).toBe(false)
      expect(isBrokenPipeError(null)).toBe(false)

      const brokenStream = {
        write() {
          throw epipe
        },
      }
      expect(safeWriteStream(brokenStream, 'hello')).toBe(false)

      const failingStream = {
        write() {
          throw other
        },
      }
      expect(() => safeWriteStream(failingStream, 'hello')).toThrow('boom')
    })
  })

  describe('TUI end-to-end non-TTY / piped fallback behavior', () => {
    it('emits a clean one-shot ASCII snapshot and exits without hanging when stdout is redirected', async () => {
      const manager = await BrowserManager.create({ engine: 'lite' })
      try {
        const inp = createMockInput({ isTTY: true })
        const out = createMockOutput({ isTTY: false, columns: 96, rows: 22 })
        const err = createMockStderr(true)

        await runTerminalBrowser(manager, {
          initialUrl: baseUrl,
          input: inp.stream,
          output: out.stream,
          stderr: err.stream,
          env: { TERM: 'xterm-256color' },
          width: 96,
          height: 22,
          libraryPath: null,
        })

        // Must never enable raw mode when stdout is piped
        expect(inp.rawModeCalls).toEqual([])

        const stdoutText = out.getText()
        expect(stdoutText).toContain('TUI NON-TTY HOME')
        expect(stdoutText).toContain('Go to Next Page')
        // Zero ANSI escape sequences, zero screen-clear codes, zero prompt pollution
        expect(hasAnsiEscapes(stdoutText)).toBe(false)
        expect(stdoutText).not.toContain('\x1b[2J')
        expect(stdoutText).not.toContain('troy-adv>')

        // Diagnostic notice goes strictly to stderr, never stdout
        const stderrText = err.getText()
        expect(stderrText).toContain('[troy-advanced] non-TTY fallback (piped-snapshot)')
        expect(stdoutText).not.toContain('[troy-advanced] non-TTY fallback')
      } finally {
        await manager.close()
      }
    })

    it('suppresses stderr diagnostic notice when suppressFallbackNotice=true', async () => {
      const manager = await BrowserManager.create({ engine: 'lite' })
      try {
        const inp = createMockInput({ isTTY: true })
        const out = createMockOutput({ isTTY: false, columns: 90, rows: 20 })
        const err = createMockStderr(true)

        await runTerminalBrowser(manager, {
          initialUrl: baseUrl,
          input: inp.stream,
          output: out.stream,
          stderr: err.stream,
          suppressFallbackNotice: true,
          env: { TERM: 'xterm-256color' },
          width: 90,
          height: 20,
          libraryPath: null,
        })

        expect(out.getText()).toContain('TUI NON-TTY HOME')
        expect(err.getText()).toBe('')
      } finally {
        await manager.close()
      }
    })

    it('runs clean piped-batch commands without writing troy-adv> prompts or ANSI codes to piped stdout', async () => {
      const manager = await BrowserManager.create({ engine: 'lite' })
      try {
        const inp = createMockInput({ isTTY: false })
        const out = createMockOutput({ isTTY: false, columns: 96, rows: 22 })
        const err = createMockStderr(false)

        const runPromise = runTerminalBrowser(manager, {
          initialUrl: baseUrl,
          input: inp.stream,
          output: out.stream,
          stderr: err.stream,
          env: { TERM: 'xterm-256color' },
          width: 96,
          height: 22,
          libraryPath: null,
        })

        await new Promise((r) => setTimeout(r, 60))
        inp.stream.write('click e1\n')
        inp.stream.write('quit\n')
        inp.stream.end()

        await runPromise

        expect(inp.rawModeCalls).toEqual([])
        const stdoutText = out.getText()
        expect(stdoutText).toContain('TUI NON-TTY HOME')
        expect(stdoutText).toContain('SECOND PAGE REACHED')
        expect(hasAnsiEscapes(stdoutText)).toBe(false)
        expect(stdoutText).not.toContain('troy-adv>')
        expect(err.getText()).toContain('piped-batch')
      } finally {
        await manager.close()
      }
    })

    it('exits immediately on empty piped stdin (e.g. < /dev/null) after rendering initial page', async () => {
      const manager = await BrowserManager.create({ engine: 'lite' })
      try {
        const inp = createMockInput({ isTTY: false })
        const out = createMockOutput({ isTTY: false, columns: 90, rows: 20 })
        inp.stream.end()

        await runTerminalBrowser(manager, {
          initialUrl: baseUrl,
          input: inp.stream,
          output: out.stream,
          env: { TERM: 'xterm-256color' },
          width: 90,
          height: 20,
          libraryPath: null,
        })

        const stdoutText = out.getText()
        expect(stdoutText).toContain('TUI NON-TTY HOME')
        expect(hasAnsiEscapes(stdoutText)).toBe(false)
        expect(stdoutText).not.toContain('troy-adv>')
      } finally {
        await manager.close()
      }
    })

    it('disables raw mode and ANSI escapes on TERM=dumb and respects NO_COLOR=1', async () => {
      const manager = await BrowserManager.create({ engine: 'lite' })
      try {
        const inp = createMockInput({ isTTY: true })
        const out = createMockOutput({ isTTY: true, columns: 96, rows: 22 })
        const err = createMockStderr(true)

        const ctrl = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input: inp.stream,
          output: out.stream,
          stderr: err.stream,
          env: { TERM: 'dumb' },
          width: 96,
          height: 22,
          libraryPath: null,
        })

        const state = ctrl.getState()
        expect(state.runtimeMode).toBe('dumb-terminal')
        expect(state.color).toBe(false)
        expect(state.asciiOnly).toBe(true)
        expect(ctrl.isRawModeEnabled()).toBe(false)

        const runPromise = ctrl.run()
        await new Promise((r) => setTimeout(r, 60))
        inp.stream.write('quit\n')
        inp.stream.end()
        await runPromise

        expect(inp.rawModeCalls).toEqual([])
        const stdoutText = out.getText()
        expect(stdoutText).toContain('TUI NON-TTY HOME')
        expect(hasAnsiEscapes(stdoutText)).toBe(false)
        expect(err.getText()).toContain('dumb-terminal')

        // NO_COLOR=1 on normal xterm keeps interactive-tty but disables ANSI color
        const noColorCtrl = new TerminalBrowserController(manager, {
          input: createMockInput({ isTTY: true }).stream,
          output: createMockOutput({ isTTY: true, columns: 96, rows: 22 }).stream,
          env: { TERM: 'xterm-256color', NO_COLOR: '1' },
          libraryPath: null,
        })
        expect(noColorCtrl.getState().runtimeMode).toBe('interactive-tty')
        expect(noColorCtrl.getState().color).toBe(false)
      } finally {
        await manager.close()
      }
    })

    it('handles broken pipe (EPIPE) on stdout gracefully without crashing', async () => {
      const manager = await BrowserManager.create({ engine: 'lite' })
      try {
        const inp = createMockInput({ isTTY: true })
        const epipeEmitter = new EventEmitter() as unknown as TuiOutputStream & EventEmitter
        epipeEmitter.isTTY = false
        epipeEmitter.columns = 90
        epipeEmitter.rows = 20
        let writes = 0
        epipeEmitter.write = (() => {
          writes += 1
          const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
          throw err
        }) as TuiOutputStream['write']

        await expect(
          runTerminalBrowser(manager, {
            initialUrl: baseUrl,
            input: inp.stream,
            output: epipeEmitter,
            env: { TERM: 'xterm-256color' },
            width: 90,
            height: 20,
            libraryPath: null,
          }),
        ).resolves.toBeUndefined()

        expect(writes).toBeGreaterThanOrEqual(1)
      } finally {
        await manager.close()
      }
    })
  })
})
