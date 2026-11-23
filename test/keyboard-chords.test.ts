import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CDP_MODIFIERS,
  buildCdpKeyEvents,
  dispatchKeyChord,
  parseKeyChord,
  type CdpKeyEventParams,
} from '../src/engine/keyboard.js'
import { BrowserManager } from '../src/engine/manager.js'
import { findChromeBinary } from '../src/engine/chromium.js'

const hasChrome = Boolean(findChromeBinary())

describe('Keyboard chord parser & CDP event builder (M19)', () => {
  it('parses core chords with exact CDP modifier bitmasks and Windows virtual key codes', () => {
    const ctrlA = parseKeyChord('Control+A', { platform: 'linux' })
    expect(ctrlA.normalized).toBe('Control+A')
    expect(ctrlA.modifiersBitmask).toBe(CDP_MODIFIERS.Control)
    expect(ctrlA.mainKey).toMatchObject({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    })
    expect(ctrlA.commands).toEqual(['selectAll'])

    const shiftTab = parseKeyChord('Shift+Tab')
    expect(shiftTab.normalized).toBe('Shift+Tab')
    expect(shiftTab.modifiersBitmask).toBe(CDP_MODIFIERS.Shift)
    expect(shiftTab.mainKey).toMatchObject({
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    })

    const esc = parseKeyChord('Escape')
    expect(esc.normalized).toBe('Escape')
    expect(esc.modifiersBitmask).toBe(0)
    expect(esc.mainKey).toMatchObject({
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })

    const arrowDown = parseKeyChord('ArrowDown')
    expect(arrowDown.normalized).toBe('ArrowDown')
    expect(arrowDown.modifiersBitmask).toBe(0)
    expect(arrowDown.mainKey).toMatchObject({
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
    })

    const metaK = parseKeyChord('Meta+K', { platform: 'darwin' })
    expect(metaK.normalized).toBe('Meta+K')
    expect(metaK.modifiersBitmask).toBe(CDP_MODIFIERS.Meta)
    expect(metaK.mainKey).toMatchObject({
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
    })
  })

  it('supports modifier aliases, ControlOrMeta platform resolution, and combined bitmasks', () => {
    const allMods = parseKeyChord('Ctrl+Shift+Option+Cmd+z', { platform: 'linux' })
    expect(allMods.modifiersBitmask).toBe(
      CDP_MODIFIERS.Control | CDP_MODIFIERS.Shift | CDP_MODIFIERS.Alt | CDP_MODIFIERS.Meta,
    )
    expect(allMods.modifiersBitmask).toBe(15)
    expect(allMods.mainKey).toMatchObject({
      key: 'Z',
      code: 'KeyZ',
      windowsVirtualKeyCode: 90,
    })

    const macPrimary = parseKeyChord('ControlOrMeta+C', { platform: 'darwin' })
    expect(macPrimary.modifiersBitmask).toBe(CDP_MODIFIERS.Meta)
    expect(macPrimary.commands).toEqual(['copy'])

    const linuxPrimary = parseKeyChord('ControlOrMeta+C', { platform: 'linux' })
    expect(linuxPrimary.modifiersBitmask).toBe(CDP_MODIFIERS.Control)
    expect(linuxPrimary.commands).toEqual(['copy'])

    // Deduplicates repeated modifiers
    const dup = parseKeyChord('Control+Ctrl+A', { platform: 'linux' })
    expect(dup.modifiers).toHaveLength(1)
    expect(dup.modifiersBitmask).toBe(CDP_MODIFIERS.Control)
  })

  it('handles function keys, punctuation, shifted symbols, numpad, and literal +', () => {
    expect(parseKeyChord('F1').mainKey).toMatchObject({ key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 })
    expect(parseKeyChord('F12').mainKey).toMatchObject({ key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 })
    expect(parseKeyChord('F24').mainKey).toMatchObject({ key: 'F24', code: 'F24', windowsVirtualKeyCode: 135 })

    expect(parseKeyChord('Shift+1').mainKey).toMatchObject({
      key: '!',
      code: 'Digit1',
      windowsVirtualKeyCode: 49,
      text: '!',
      unmodifiedText: '1',
    })

    expect(parseKeyChord('+').mainKey).toMatchObject({
      key: '+',
      code: 'Equal',
      windowsVirtualKeyCode: 187,
      text: '+',
    })

    const ctrlPlus = parseKeyChord('Control++')
    expect(ctrlPlus.modifiersBitmask).toBe(CDP_MODIFIERS.Control)
    expect(ctrlPlus.mainKey).toMatchObject({ key: '+', code: 'Equal', windowsVirtualKeyCode: 187 })

    const numpad = parseKeyChord('NumpadEnter')
    expect(numpad.mainKey).toMatchObject({
      key: 'Enter',
      code: 'NumpadEnter',
      windowsVirtualKeyCode: 13,
      isKeypad: true,
      location: 3,
    })

    const standaloneMod = parseKeyChord('Shift')
    expect(standaloneMod.mainKey).toBeNull()
    expect(standaloneMod.modifiersBitmask).toBe(CDP_MODIFIERS.Shift)
  })

  it('throws clear errors for empty or invalid multi-key chords', () => {
    expect(() => parseKeyChord('')).toThrow(/empty/i)
    expect(() => parseKeyChord('   ')).toThrow(/empty/i)
    expect(() => parseKeyChord('A+B')).toThrow(/multiple non-modifier/i)
  })

  it('builds exact ordered CDP event sequences for chords and single keys', () => {
    const chord = parseKeyChord('Control+Shift+K', { platform: 'linux' })
    const events = buildCdpKeyEvents(chord)
    expect(events).toHaveLength(6)

    // 1. Control down (mask = 2)
    expect(events[0]).toMatchObject({
      type: 'rawKeyDown',
      modifiers: 2,
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
    })
    // 2. Shift down (mask = 10)
    expect(events[1]).toMatchObject({
      type: 'rawKeyDown',
      modifiers: 10,
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
    })
    // 3. K rawKeyDown (mask = 10, no text because Control is held)
    expect(events[2]).toMatchObject({
      type: 'rawKeyDown',
      modifiers: 10,
      key: 'K',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
    })
    expect(events[2]?.text).toBeUndefined()
    // 4. K keyUp (mask = 10)
    expect(events[3]).toMatchObject({
      type: 'keyUp',
      modifiers: 10,
      key: 'K',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
    })
    // 5. Shift keyUp (mask = 2)
    expect(events[4]).toMatchObject({
      type: 'keyUp',
      modifiers: 2,
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
    })
    // 6. Control keyUp (mask = 0)
    expect(events[5]).toMatchObject({
      type: 'keyUp',
      modifiers: 0,
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
    })
  })

  it('dispatches printable keys with keyDown + text and non-printable keys with rawKeyDown', async () => {
    const sent: Array<{ method: string; params: CdpKeyEventParams }> = []
    const sender = async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params: params as unknown as CdpKeyEventParams })
    }

    const resA = await dispatchKeyChord(sender, 'a')
    expect(resA.eventsDispatched).toBe(2)
    expect(sent[0]?.method).toBe('Input.dispatchKeyEvent')
    expect(sent[0]?.params).toMatchObject({
      type: 'keyDown',
      modifiers: 0,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: 'a',
      unmodifiedText: 'a',
    })
    expect(sent[1]?.params).toMatchObject({
      type: 'keyUp',
      modifiers: 0,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    })

    sent.length = 0
    const resShiftTab = await dispatchKeyChord(sender, 'Shift+Tab')
    expect(resShiftTab.eventsDispatched).toBe(4)
    expect(sent.map((e) => `${e.params.type}:${e.params.key}:${e.params.modifiers}:${e.params.windowsVirtualKeyCode}`)).toEqual([
      'rawKeyDown:Shift:8:16',
      'rawKeyDown:Tab:8:9',
      'keyUp:Tab:8:9',
      'keyUp:Shift:0:16',
    ])
  })
})

describe('Lite engine page_press chord support (M19)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-kb-lite-'))
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url?.startsWith('/search')) {
        res.end('<html><head><title>Submitted</title></head><body><h1>Search Submitted</h1></body></html>')
        return
      }
      res.end(`<html><head><title>KB Lite</title></head><body>
        <form action="/search" method="GET">
          <input id="q" name="q" type="text" placeholder="Search" />
          <button type="submit">Go</button>
        </form>
        ${'<p>Filler line for scrolling.</p>'.repeat(40)}
      </body></html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })
  })

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((r) => server?.close(() => r()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('normalizes chords, rejects invalid chords, scrolls on ArrowDown, and submits on Return', async () => {
    const opened = await manager.openTab(baseUrl, { activate: true })
    expect(opened.ok).toBe(true)
    const tabId = opened.id!

    const ctrlA = await manager.runTool(tabId, 'page_press', { key: 'Control+A' })
    expect(ctrlA.ok).toBe(true)
    expect(ctrlA.normalized).toBe('Control+A')
    expect(ctrlA.modifiers).toBe(CDP_MODIFIERS.Control)

    const invalid = await manager.runTool(tabId, 'page_press', { key: 'A+B' })
    expect(invalid.ok).toBe(false)
    expect(String(invalid.error)).toMatch(/multiple non-modifier/i)

    const down = await manager.runTool(tabId, 'page_press', { key: 'ArrowDown' })
    expect(down.ok).toBe(true)

    const found = await manager.runTool(tabId, 'page_find', { query: 'Search' })
    const inputRef = (found.matches as Array<{ ref: string }>)[0]!.ref
    const submitted = await manager.runTool(tabId, 'page_press', { key: 'Return', ref: inputRef })
    expect(submitted.ok).toBe(true)
    expect(submitted.normalized).toBe('Enter')
    const after = await manager.runTool(tabId, 'page_read_ascii', {})
    expect(String(after.ascii)).toContain('SEARCH SUBMITTED')
  })
})

describe.skipIf(!hasChrome)('Headless Chromium E2E keyboard chords (M19)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-kb-chrome-'))
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
        <head><title>Keyboard Chords E2E</title></head>
        <body>
          <input id="input1" type="text" value="Hello Troy World" />
          <input id="input2" type="text" value="Second Field" />
          <script>
            window.__keyEvents = [];
            window.addEventListener('keydown', (e) => {
              if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
              window.__keyEvents.push({
                key: e.key,
                code: e.code,
                keyCode: e.keyCode,
                ctrlKey: e.ctrlKey,
                shiftKey: e.shiftKey,
                altKey: e.altKey,
                metaKey: e.metaKey,
                targetId: document.activeElement ? document.activeElement.id : ''
              });
            });
          </script>
        </body>
      </html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    manager = await BrowserManager.create({ engine: 'chromium', profileDir: tmpDir })
  })

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((r) => server?.close(() => r()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('dispatches Control+A, Shift+Tab, Escape, ArrowDown, and Meta+K with real DOM effects', async () => {
    const opened = await manager.openTab(baseUrl, { activate: true })
    expect(opened.ok).toBe(true)
    const tabId = opened.id!

    await manager.runTool(tabId, 'page_read_ascii', {})
    const found1 = await manager.runTool(tabId, 'page_find', { query: 'Hello Troy World' })
    const ref1 = (found1.matches as Array<{ ref: string }>)[0]!.ref
    const found2 = await manager.runTool(tabId, 'page_find', { query: 'Second Field' })
    const ref2 = (found2.matches as Array<{ ref: string }>)[0]!.ref

    // 1. Control+A selects all text inside input1
    const ctrlA = await manager.runTool(tabId, 'page_press', { key: 'Control+A', ref: ref1 })
    expect(ctrlA.ok).toBe(true)
    const sel = await manager.runTool(tabId, 'page_eval', {
      expression: '(() => { const el = document.getElementById("input1"); return { start: el.selectionStart, end: el.selectionEnd, len: el.value.length }; })()',
    })
    expect(sel.value).toEqual({ start: 0, end: 16, len: 16 })

    // 2. Shift+Tab moves focus backwards from input2 to input1
    const shiftTab = await manager.runTool(tabId, 'page_press', { key: 'Shift+Tab', ref: ref2 })
    expect(shiftTab.ok).toBe(true)
    const active = await manager.runTool(tabId, 'page_eval', { expression: 'document.activeElement.id' })
    expect(active.value).toBe('input1')

    // 3. Escape, ArrowDown, Meta+K
    expect((await manager.runTool(tabId, 'page_press', { key: 'Escape' })).ok).toBe(true)
    expect((await manager.runTool(tabId, 'page_press', { key: 'ArrowDown' })).ok).toBe(true)
    expect((await manager.runTool(tabId, 'page_press', { key: 'Meta+K' })).ok).toBe(true)

    const recorded = await manager.runTool(tabId, 'page_eval', { expression: 'window.__keyEvents' })
    const events = recorded.value as Array<Record<string, unknown>>
    expect(events).toHaveLength(5)

    expect(events[0]).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true, shiftKey: false })
    expect(events[1]).toMatchObject({ key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true, ctrlKey: false })
    expect(events[2]).toMatchObject({ key: 'Escape', code: 'Escape', keyCode: 27, ctrlKey: false, shiftKey: false })
    expect(events[3]).toMatchObject({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, ctrlKey: false, shiftKey: false })
    expect(events[4]).toMatchObject({ key: 'k', code: 'KeyK', keyCode: 75, metaKey: true, ctrlKey: false })
  })
})
