import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { cropPageSnapshot, renderPageAscii } from '../src/ascii/layout.js'
import { cropRgba, parseCropRect, renderPngToAscii, renderRgbaToAscii } from '../src/ascii/pixels.js'
import type { DecodedPng } from '../src/ascii/png-decoder.js'
import { BrowserManager } from '../src/engine/manager.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'
import type { PageSnapshot } from '../src/types.js'

function makeRgba(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number, number],
): DecodedPng {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const idx = (y * width + x) * 4
      rgba[idx] = r
      rgba[idx + 1] = g
      rgba[idx + 2] = b
      rgba[idx + 3] = a
    }
  }
  return { width, height, rgba }
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodeRgbaToPng(img: DecodedPng): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rowStride = img.width * 4
  const raw = Buffer.alloc(img.height * (rowStride + 1))
  for (let y = 0; y < img.height; y++) {
    const outOff = y * (rowStride + 1)
    raw[outOff] = 0 // filter None
    Buffer.from(img.rgba.buffer, img.rgba.byteOffset + y * rowStride, rowStride).copy(raw, outOff + 1)
  }
  const idat = deflateSync(raw)
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

function innerLines(framedAscii: string): string[] {
  const lines = framedAscii.split('\n')
  return lines.slice(1, -1).map((line) => line.slice(1, -1))
}

function makeDashboardSnapshot(): PageSnapshot {
  return {
    tabId: 1,
    url: 'https://dashboard.example.com/analytics',
    title: 'Analytics Dashboard',
    epoch: 1,
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
    blocks: [
      {
        kind: 'heading',
        level: 1,
        text: 'Global Navigation Header',
        box: { x: 0, y: 0, width: 1000, height: 60 },
      },
      {
        kind: 'paragraph',
        text: 'Sidebar Filter Controls',
        box: { x: 0, y: 80, width: 200, height: 400 },
      },
      {
        kind: 'heading',
        level: 2,
        text: 'Confirm Deployment Modal',
        box: { x: 320, y: 220, width: 360, height: 40 },
      },
      {
        kind: 'paragraph',
        text: 'Deploy release v2.4 to us-east-1?',
        box: { x: 320, y: 270, width: 360, height: 40 },
      },
      {
        kind: 'button',
        text: 'Deploy Now',
        ref: 'e2',
        box: { x: 340, y: 330, width: 140, height: 36 },
      },
      {
        kind: 'button',
        text: 'Cancel',
        ref: 'e3',
        box: { x: 500, y: 330, width: 120, height: 36 },
      },
    ],
    elements: [
      {
        ref: 'e1',
        selector: '#nav-home',
        tag: 'a',
        type: '',
        text: 'Home',
        href: 'https://dashboard.example.com/',
        box: { x: 20, y: 15, width: 80, height: 30 },
      },
      {
        ref: 'e2',
        selector: '#deploy-modal',
        tag: 'button',
        type: 'button',
        text: 'Deploy Now',
        box: { x: 300, y: 200, width: 400, height: 200 },
      },
      {
        ref: 'e3',
        selector: '#cancel-btn',
        tag: 'button',
        type: 'button',
        text: 'Cancel',
        box: { x: 500, y: 330, width: 120, height: 36 },
      },
    ],
    text: 'Global Navigation Header Sidebar Filter Controls Confirm Deployment Modal Deploy Now Cancel',
    capturedAt: Date.now(),
  }
}

describe('Region crop support (--crop x,y,w,h and --ref eN) (M11)', () => {
  describe('parseCropRect', () => {
    it('parses valid x,y,w,h strings and rect objects', () => {
      expect(parseCropRect('10,20,300,200')).toEqual({ x: 10, y: 20, width: 300, height: 200 })
      expect(parseCropRect(' 0 , 5.5 , 120.5 , 80 ')).toEqual({ x: 0, y: 5.5, width: 120.5, height: 80 })
      expect(parseCropRect({ x: 4, y: 8, width: 64, height: 32 })).toEqual({ x: 4, y: 8, width: 64, height: 32 })
      expect(parseCropRect({ x: 4, y: 8, w: 64, h: 32 })).toEqual({ x: 4, y: 8, width: 64, height: 32 })
    })

    it('rejects malformed or out-of-range crop inputs', () => {
      expect(parseCropRect(undefined)).toBeUndefined()
      expect(parseCropRect('')).toBeUndefined()
      expect(parseCropRect('10,20,300')).toBeUndefined()
      expect(parseCropRect('10,20,300,200,5')).toBeUndefined()
      expect(parseCropRect('10,,300,200')).toBeUndefined()
      expect(parseCropRect('-1,0,100,100')).toBeUndefined()
      expect(parseCropRect('0,0,0,100')).toBeUndefined()
      expect(parseCropRect('0,0,100,-5')).toBeUndefined()
      expect(parseCropRect('a,b,c,d')).toBeUndefined()
      expect(parseCropRect({ x: 0, y: 0, width: 0, height: 50 })).toBeUndefined()
    })
  })

  describe('cropRgba and renderRgbaToAscii', () => {
    it('crops exact pixel sub-rectangle and supports HiDPI viewport scaling', () => {
      // 200x100 image representing a 100x50 viewport (2x DPR)
      // Draw a black chart in viewport region x=50..90, y=10..40 => image pixels x=100..180, y=20..80
      const img = makeRgba(200, 100, (x, y) =>
        x >= 100 && x < 180 && y >= 20 && y < 80 ? [0, 0, 0, 255] : [255, 255, 255, 255],
      )

      const cropped = cropRgba(img, { x: 50, y: 10, width: 40, height: 30 }, { width: 100, height: 50 })
      expect(cropped.width).toBe(80)
      expect(cropped.height).toBe(60)
      // Every pixel inside the cropped region should be black
      expect(cropped.rgba[0]).toBe(0)
      expect(cropped.rgba[1]).toBe(0)
      expect(cropped.rgba[2]).toBe(0)
      expect(cropped.rgba[3]).toBe(255)
    })

    it('clamps out-of-bounds crop rectangles safely', () => {
      const img = makeRgba(40, 20, () => [128, 128, 128, 255])
      const cropped = cropRgba(img, { x: 30, y: 15, width: 100, height: 100 })
      expect(cropped.width).toBe(10)
      expect(cropped.height).toBe(5)
    })

    it('zooms into a chart/modal region in ASCII, edge, braille, and halfblock modes', () => {
      // 100x100 white canvas with a 20x20 solid black square at (60, 60)
      const img = makeRgba(100, 100, (x, y) =>
        x >= 60 && x < 80 && y >= 60 && y < 80 ? [0, 0, 0, 255] : [255, 255, 255, 255],
      )

      const fullAscii = renderRgbaToAscii(img, { width: 20, height: 10, mode: 'ascii' })
      const zoomedAscii = renderRgbaToAscii(img, {
        width: 20,
        height: 10,
        mode: 'ascii',
        crop: { x: 60, y: 60, width: 20, height: 20 },
      })

      // Full view is mostly white spaces; zoomed view is completely filled with dark '@'
      const fullDark = (fullAscii.match(/@/g) ?? []).length
      const zoomedDark = (zoomedAscii.match(/@/g) ?? []).length
      expect(zoomedDark).toBeGreaterThan(fullDark * 5)
      expect(innerLines(zoomedAscii).every((row) => row === '@'.repeat(20))).toBe(true)

      // Edge mode on a cropped region containing a border still produces strict 7-bit ASCII
      const zoomedEdge = renderRgbaToAscii(img, {
        width: 20,
        height: 10,
        mode: 'edge',
        crop: { x: 55, y: 55, width: 30, height: 30 },
      })
      expect(/^[\x20-\x7e\n]+$/.test(zoomedEdge)).toBe(true)
      expect(/[|\-/\\]/.test(zoomedEdge)).toBe(true)

      // Braille mode on the black square fills with full braille cells (U+28FF)
      const zoomedBraille = renderRgbaToAscii(img, {
        width: 16,
        height: 8,
        mode: 'braille',
        crop: { x: 60, y: 60, width: 20, height: 20 },
      })
      expect(zoomedBraille).toContain('\u28ff')

      // Halfblock mode renders black ANSI escapes
      const zoomedHalf = renderRgbaToAscii(img, {
        width: 16,
        height: 8,
        mode: 'halfblock',
        crop: { x: 60, y: 60, width: 20, height: 20 },
      })
      expect(zoomedHalf).toContain('\x1b[38;2;0;0;0m')
    })

    it('translates Set-of-Marks overlays into the cropped coordinate frame and excludes outside overlays', () => {
      const img = makeRgba(200, 100, () => [255, 255, 255, 255])
      const png = encodeRgbaToPng(img)

      const out = renderPngToAscii(png, {
        width: 40,
        height: 16,
        mode: 'ascii',
        viewport: { width: 200, height: 100 },
        crop: { x: 100, y: 20, width: 100, height: 80 },
        overlays: [
          { ref: 'e1', box: { x: 10, y: 10, width: 30, height: 20 } }, // outside crop
          { ref: 'e7', box: { x: 120, y: 40, width: 40, height: 30 } }, // inside crop
        ],
      })

      expect(out).not.toContain('[e1]')
      expect(out).toContain('[e7]')
      expect(out).toContain('+-----[e7]-----+')
    })
  })

  describe('cropPageSnapshot and renderPageAscii', () => {
    it('crops DOM snapshot to a modal region and shows crop/zoom indicator in chrome', () => {
      const snap = makeDashboardSnapshot()
      const modalCrop = { x: 300, y: 200, width: 400, height: 200 }

      const croppedSnap = cropPageSnapshot(snap, modalCrop)
      expect(croppedSnap.viewport.width).toBe(400)
      expect(croppedSnap.viewport.height).toBe(200)
      expect(croppedSnap.blocks.some((b) => b.text.includes('Confirm Deployment Modal'))).toBe(true)
      expect(croppedSnap.blocks.some((b) => b.text.includes('Global Navigation Header'))).toBe(false)
      expect(croppedSnap.blocks.some((b) => b.text.includes('Sidebar Filter Controls'))).toBe(false)
      expect(croppedSnap.elements.map((e) => e.ref)).toEqual(['e2', 'e3'])

      const ascii = renderPageAscii(snap, {
        width: 80,
        height: 20,
        crop: modalCrop,
        cropLabel: 'e2',
      })
      expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
      expect(ascii).toContain('Confirm Deployment Modal')
      expect(ascii).toContain('Deploy Now')
      expect(ascii).not.toContain('Global Navigation Header')
      expect(ascii).not.toContain('Sidebar Filter Controls')
      expect(ascii).toContain('zoom:e2')
    })
  })

  describe('BrowserManager, MCP, and Pipe integration for --crop and --ref', () => {
    it('supports crop and ref zooming across page_screenshot_ascii, page_read_ascii, MCP, and Pipe', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
      try {
        const opened = await manager.openTab(undefined, { activate: true })
        expect(opened.ok).toBe(true)

        // Attach a deterministic screenshot + positioned snapshot to the active tab driver
        const sessions = (manager as unknown as { tabs: Map<number, { driver: Record<string, unknown> }> }).tabs
        const driver = sessions.get(opened.id!)!.driver
        const dashSnap = makeDashboardSnapshot()
        const fullImg = makeRgba(1000, 800, (x, y) =>
          // Dark modal area at x=300..700, y=200..400
          x >= 300 && x < 700 && y >= 200 && y < 400 ? [10, 10, 10, 255] : [255, 255, 255, 255],
        )
        const pngBuf = encodeRgbaToPng(fullImg)
        driver.snapshot = async () => ({ ...dashSnap, tabId: opened.id! })
        driver.screenshot = async () => pngBuf
        driver.getUrl = () => dashSnap.url
        driver.getEpoch = () => dashSnap.epoch

        // 1. Initial read registers e1, e2 (modal box), e3
        const initial = await manager.runTool(opened.id, 'page_read_ascii', { width: 80 })
        expect(initial.ok).toBe(true)

        // 2. Zoom screenshot by --ref e2 (resolves e2 bounding box before any re-snapshot)
        const shotByRef = await manager.runTool(opened.id, 'page_screenshot_ascii', {
          width: 30,
          height: 10,
          ref: 'e2',
        })
        expect(shotByRef.ok).toBe(true)
        expect(shotByRef.cropRef).toBe('e2')
        expect(shotByRef.crop).toEqual({ x: 300, y: 200, width: 400, height: 200 })
        expect(innerLines(String(shotByRef.ascii)).every((r) => r === '@'.repeat(30))).toBe(true)

        // 3. Zoom screenshot by explicit --crop x,y,w,h string (white top-left corner)
        const shotByCrop = await manager.runTool(opened.id, 'page_screenshot_ascii', {
          width: 30,
          height: 10,
          crop: '0,0,200,150',
        })
        expect(shotByCrop.ok).toBe(true)
        expect(shotByCrop.crop).toEqual({ x: 0, y: 0, width: 200, height: 150 })
        expect(innerLines(String(shotByCrop.ascii)).every((r) => r === ' '.repeat(30))).toBe(true)

        // 4. Invalid crop string returns clear error
        const badCrop = await manager.runTool(opened.id, 'page_screenshot_ascii', { crop: 'bad-crop' })
        expect(badCrop.ok).toBe(false)
        expect(String(badCrop.error)).toContain('invalid crop')

        // 5. Unknown ref returns clear error
        const badRef = await manager.runTool(opened.id, 'page_screenshot_ascii', { ref: 'e999' })
        expect(badRef.ok).toBe(false)
        expect(String(badRef.error)).toContain('e999')

        // 6. MCP troy_screenshot_ascii forwards crop
        const mcpRes = (await handleMcpRequest(manager, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'troy_screenshot_ascii',
            arguments: { tabId: opened.id, width: 24, height: 8, crop: '300,200,400,200' },
          },
        })) as { result: { content: Array<{ text: string }> } }
        expect(innerLines(mcpRes.result.content[0]!.text).every((r) => r === '@'.repeat(24))).toBe(true)

        // 7. Pipe REPL supports `visual --crop ...` (with annotate:true overlays!) and `ascii --crop ...`
        const pipeVisual = await executePipeCommand(manager, 'visual 24 --crop 300,200,400,200')
        expect(pipeVisual.output).toContain('[e2]')
        expect(pipeVisual.output).toContain('[e3]')
        expect(pipeVisual.output).not.toContain('[e1]')
        expect(pipeVisual.output).toContain('@'.repeat(20))

        const pipeAscii = await executePipeCommand(manager, 'ascii 80 --crop 300,200,400,200')
        expect(pipeAscii.output).toContain('Confirm Deployment Modal')
        expect(pipeAscii.output).not.toContain('Global Navigation Header')
      } finally {
        await manager.close()
      }
    })
  })
})
