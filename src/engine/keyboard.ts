/**
 * Keyboard chord parser and Chrome DevTools Protocol (CDP) Input.dispatchKeyEvent builder.
 *
 * Supports single keys (`Escape`, `ArrowDown`, `Enter`, `Tab`, `F5`, `a`) and multi-key chords
 * (`Control+A`, `Shift+Tab`, `Meta+K`, `Control+Shift+Z`, `Alt+ArrowLeft`, `ControlOrMeta+C`)
 * with proper CDP modifier bitmasks (Alt=1, Control=2, Meta=4, Shift=8), DOM `key`/`code`,
 * and Windows virtual key codes.
 */

export const CDP_MODIFIERS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const

export type ModifierName = keyof typeof CDP_MODIFIERS

export interface ModifierDescriptor {
  name: ModifierName
  bit: number
  key: string
  code: string
  windowsVirtualKeyCode: number
  location: number
}

export interface KeyDescriptor {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
  unmodifiedText?: string
  location?: number
  isKeypad?: boolean
}

export interface ParsedKeyChord {
  raw: string
  normalized: string
  modifiers: ModifierDescriptor[]
  modifiersBitmask: number
  mainKey: KeyDescriptor | null
  commands?: string[]
}

export interface CdpKeyEventParams {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp' | 'char'
  modifiers: number
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  text?: string
  unmodifiedText?: string
  location?: number
  isKeypad?: boolean
  commands?: string[]
}

export interface ParseKeyChordOptions {
  platform?: NodeJS.Platform
}

interface NamedKeyDef {
  key: string
  code: string
  vk: number
  text?: string
  location?: number
  isKeypad?: boolean
}

interface UsKeyDef {
  code: string
  vk: number
  unshifted: string
  shifted: string
}

const MODIFIER_DESCRIPTORS: Record<string, ModifierDescriptor> = {
  alt: { name: 'Alt', bit: CDP_MODIFIERS.Alt, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, location: 1 },
  option: { name: 'Alt', bit: CDP_MODIFIERS.Alt, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, location: 1 },
  altleft: { name: 'Alt', bit: CDP_MODIFIERS.Alt, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, location: 1 },
  altright: { name: 'Alt', bit: CDP_MODIFIERS.Alt, key: 'Alt', code: 'AltRight', windowsVirtualKeyCode: 18, location: 2 },

  control: { name: 'Control', bit: CDP_MODIFIERS.Control, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, location: 1 },
  ctrl: { name: 'Control', bit: CDP_MODIFIERS.Control, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, location: 1 },
  controlleft: { name: 'Control', bit: CDP_MODIFIERS.Control, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, location: 1 },
  controlright: { name: 'Control', bit: CDP_MODIFIERS.Control, key: 'Control', code: 'ControlRight', windowsVirtualKeyCode: 17, location: 2 },

  meta: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  cmd: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  command: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  super: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  win: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  os: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  metaleft: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  metaright: { name: 'Meta', bit: CDP_MODIFIERS.Meta, key: 'Meta', code: 'MetaRight', windowsVirtualKeyCode: 92, location: 2 },

  shift: { name: 'Shift', bit: CDP_MODIFIERS.Shift, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 },
  shiftleft: { name: 'Shift', bit: CDP_MODIFIERS.Shift, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 },
  shiftright: { name: 'Shift', bit: CDP_MODIFIERS.Shift, key: 'Shift', code: 'ShiftRight', windowsVirtualKeyCode: 16, location: 2 },
}

const NAMED_KEYS: Record<string, NamedKeyDef> = {
  // Whitespace & editing
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
  ins: { key: 'Insert', code: 'Insert', vk: 45 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  spacebar: { key: ' ', code: 'Space', vk: 32, text: ' ' },

  // Navigation
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pgup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  pgdn: { key: 'PageDown', code: 'PageDown', vk: 34 },

  // Lock & system keys
  capslock: { key: 'CapsLock', code: 'CapsLock', vk: 20 },
  numlock: { key: 'NumLock', code: 'NumLock', vk: 144 },
  scrolllock: { key: 'ScrollLock', code: 'ScrollLock', vk: 145 },
  printscreen: { key: 'PrintScreen', code: 'PrintScreen', vk: 44 },
  pause: { key: 'Pause', code: 'Pause', vk: 19 },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu', vk: 93 },
  help: { key: 'Help', code: 'Help', vk: 47 },
  clear: { key: 'Clear', code: 'Numpad5', vk: 12 },

  // Named punctuation aliases
  plus: { key: '+', code: 'Equal', vk: 187, text: '+' },
  minus: { key: '-', code: 'Minus', vk: 189, text: '-' },
  equal: { key: '=', code: 'Equal', vk: 187, text: '=' },
  comma: { key: ',', code: 'Comma', vk: 188, text: ',' },
  period: { key: '.', code: 'Period', vk: 190, text: '.' },
  slash: { key: '/', code: 'Slash', vk: 191, text: '/' },
  backslash: { key: '\\', code: 'Backslash', vk: 220, text: '\\' },
  semicolon: { key: ';', code: 'Semicolon', vk: 186, text: ';' },
  quote: { key: "'", code: 'Quote', vk: 222, text: "'" },
  backquote: { key: '`', code: 'Backquote', vk: 192, text: '`' },
  bracketleft: { key: '[', code: 'BracketLeft', vk: 219, text: '[' },
  bracketright: { key: ']', code: 'BracketRight', vk: 221, text: ']' },

  // Numpad
  numpad0: { key: '0', code: 'Numpad0', vk: 96, text: '0', location: 3, isKeypad: true },
  numpad1: { key: '1', code: 'Numpad1', vk: 97, text: '1', location: 3, isKeypad: true },
  numpad2: { key: '2', code: 'Numpad2', vk: 98, text: '2', location: 3, isKeypad: true },
  numpad3: { key: '3', code: 'Numpad3', vk: 99, text: '3', location: 3, isKeypad: true },
  numpad4: { key: '4', code: 'Numpad4', vk: 100, text: '4', location: 3, isKeypad: true },
  numpad5: { key: '5', code: 'Numpad5', vk: 101, text: '5', location: 3, isKeypad: true },
  numpad6: { key: '6', code: 'Numpad6', vk: 102, text: '6', location: 3, isKeypad: true },
  numpad7: { key: '7', code: 'Numpad7', vk: 103, text: '7', location: 3, isKeypad: true },
  numpad8: { key: '8', code: 'Numpad8', vk: 104, text: '8', location: 3, isKeypad: true },
  numpad9: { key: '9', code: 'Numpad9', vk: 105, text: '9', location: 3, isKeypad: true },
  numpadmultiply: { key: '*', code: 'NumpadMultiply', vk: 106, text: '*', location: 3, isKeypad: true },
  numpadadd: { key: '+', code: 'NumpadAdd', vk: 107, text: '+', location: 3, isKeypad: true },
  numpadsubtract: { key: '-', code: 'NumpadSubtract', vk: 109, text: '-', location: 3, isKeypad: true },
  numpaddecimal: { key: '.', code: 'NumpadDecimal', vk: 110, text: '.', location: 3, isKeypad: true },
  numpaddivide: { key: '/', code: 'NumpadDivide', vk: 111, text: '/', location: 3, isKeypad: true },
  numpadenter: { key: 'Enter', code: 'NumpadEnter', vk: 13, text: '\r', location: 3, isKeypad: true },
}

// Populate F1..F24 (Windows VK_F1 = 112 .. VK_F24 = 135)
for (let i = 1; i <= 24; i++) {
  NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i }
}

const US_KEY_DEFS: UsKeyDef[] = [
  { code: 'Digit0', vk: 48, unshifted: '0', shifted: ')' },
  { code: 'Digit1', vk: 49, unshifted: '1', shifted: '!' },
  { code: 'Digit2', vk: 50, unshifted: '2', shifted: '@' },
  { code: 'Digit3', vk: 51, unshifted: '3', shifted: '#' },
  { code: 'Digit4', vk: 52, unshifted: '4', shifted: '$' },
  { code: 'Digit5', vk: 53, unshifted: '5', shifted: '%' },
  { code: 'Digit6', vk: 54, unshifted: '6', shifted: '^' },
  { code: 'Digit7', vk: 55, unshifted: '7', shifted: '&' },
  { code: 'Digit8', vk: 56, unshifted: '8', shifted: '*' },
  { code: 'Digit9', vk: 57, unshifted: '9', shifted: '(' },
  { code: 'Backquote', vk: 192, unshifted: '`', shifted: '~' },
  { code: 'Minus', vk: 189, unshifted: '-', shifted: '_' },
  { code: 'Equal', vk: 187, unshifted: '=', shifted: '+' },
  { code: 'BracketLeft', vk: 219, unshifted: '[', shifted: '{' },
  { code: 'BracketRight', vk: 221, unshifted: ']', shifted: '}' },
  { code: 'Backslash', vk: 220, unshifted: '\\', shifted: '|' },
  { code: 'Semicolon', vk: 186, unshifted: ';', shifted: ':' },
  { code: 'Quote', vk: 222, unshifted: "'", shifted: '"' },
  { code: 'Comma', vk: 188, unshifted: ',', shifted: '<' },
  { code: 'Period', vk: 190, unshifted: '.', shifted: '>' },
  { code: 'Slash', vk: 191, unshifted: '/', shifted: '?' },
]

const US_KEY_BY_CHAR = new Map<string, UsKeyDef>()
for (const def of US_KEY_DEFS) {
  US_KEY_BY_CHAR.set(def.unshifted, def)
  US_KEY_BY_CHAR.set(def.shifted, def)
}

/**
 * Split a chord string like `Control+Shift+A`, `Control++`, or `+` into tokens.
 */
function splitChordTokens(raw: string): string[] {
  if (raw === ' ') return [' ']
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed === '+') return ['+']

  const tokens: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (ch === '+') {
      if (current.length > 0) {
        tokens.push(current.trim())
        current = ''
      } else {
        // Consecutive `+` (e.g. `Control++`) means the literal `+` key
        current += '+'
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) {
    tokens.push(current.trim())
  }
  return tokens.filter((t) => t.length > 0)
}

function resolveModifier(token: string, platform: NodeJS.Platform): ModifierDescriptor | null {
  const lower = token.toLowerCase()
  if (lower === 'controlormeta' || lower === 'cmdorctrl' || lower === 'primary') {
    return platform === 'darwin' ? MODIFIER_DESCRIPTORS.meta! : MODIFIER_DESCRIPTORS.control!
  }
  return MODIFIER_DESCRIPTORS[lower] ?? null
}

function resolveMainKey(token: string, hasShift: boolean, hasNonShiftMod: boolean): KeyDescriptor {
  if (token === ' ') {
    return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' }
  }

  // Named key lookup (Enter, Tab, Escape, ArrowDown, F1..F24, Numpad*, etc.)
  const named = NAMED_KEYS[token.toLowerCase()]
  if (named) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      ...(named.text !== undefined ? { text: named.text, unmodifiedText: named.text } : {}),
      ...(named.location !== undefined ? { location: named.location } : {}),
      ...(named.isKeypad ? { isKeypad: true } : {}),
    }
  }

  // DOM KeyA..KeyZ or Digit0..Digit9 explicit code syntax
  const keyCodeMatch = /^Key([A-Za-z])$/i.exec(token)
  if (keyCodeMatch) {
    const upper = keyCodeMatch[1]!.toUpperCase()
    const lower = upper.toLowerCase()
    const keyChar = hasShift ? upper : lower
    return {
      key: keyChar,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: keyChar,
      unmodifiedText: lower,
    }
  }

  const digitCodeMatch = /^Digit([0-9])$/i.exec(token)
  if (digitCodeMatch) {
    const digit = digitCodeMatch[1]!
    const def = US_KEY_BY_CHAR.get(digit)!
    const keyChar = hasShift ? def.shifted : def.unshifted
    return {
      key: keyChar,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      text: keyChar,
      unmodifiedText: def.unshifted,
    }
  }

  // Single ASCII letter a-z / A-Z
  if (token.length === 1 && /^[a-zA-Z]$/.test(token)) {
    const upper = token.toUpperCase()
    const lower = token.toLowerCase()
    // For chords like `Control+A` or `Meta+K` (without Shift), browsers emit lowercase `key: 'a'` / `'k'`.
    // For `Shift+a` / `Control+Shift+A` / standalone `A`, emit uppercase `'A'`.
    const keyChar = hasShift ? upper : hasNonShiftMod ? lower : token
    return {
      key: keyChar,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: keyChar,
      unmodifiedText: lower,
    }
  }

  // Single US keyboard digit or punctuation character
  if (token.length === 1) {
    const def = US_KEY_BY_CHAR.get(token)
    if (def) {
      const keyChar = hasShift ? def.shifted : token
      return {
        key: keyChar,
        code: def.code,
        windowsVirtualKeyCode: def.vk,
        text: keyChar,
        unmodifiedText: def.unshifted,
      }
    }
    // Generic single printable character fallback (e.g. non-ASCII Unicode)
    return {
      key: token,
      code: '',
      windowsVirtualKeyCode: 0,
      text: token,
      unmodifiedText: token,
    }
  }

  // Unknown multi-character key name fallback
  return {
    key: token,
    code: token,
    windowsVirtualKeyCode: 0,
  }
}

function resolveEditingCommands(
  mainKey: KeyDescriptor | null,
  modifiersBitmask: number,
  platform: NodeJS.Platform,
): string[] | undefined {
  if (!mainKey) return undefined
  const primaryBit = platform === 'darwin' ? CDP_MODIFIERS.Meta : CDP_MODIFIERS.Control
  const hasPrimary = (modifiersBitmask & primaryBit) !== 0
  const hasShift = (modifiersBitmask & CDP_MODIFIERS.Shift) !== 0
  const hasOther = (modifiersBitmask & ~(primaryBit | CDP_MODIFIERS.Shift)) !== 0

  if (!hasPrimary || hasOther) return undefined
  const lower = mainKey.key.toLowerCase()
  if (!hasShift) {
    if (lower === 'a') return ['selectAll']
    if (lower === 'c') return ['copy']
    if (lower === 'x') return ['cut']
    if (lower === 'v') return ['paste']
    if (lower === 'z') return ['undo']
    if (lower === 'y' && platform !== 'darwin') return ['redo']
  } else if (lower === 'z') {
    return ['redo']
  }
  return undefined
}

/**
 * Parse a key or keyboard chord string into a normalized descriptor with CDP modifier bitmasks
 * and Windows virtual key codes.
 */
export function parseKeyChord(input: string, options: ParseKeyChordOptions = {}): ParsedKeyChord {
  const platform = options.platform ?? process.platform
  const tokens = splitChordTokens(input)
  if (tokens.length === 0) {
    throw new Error('Key chord must not be empty')
  }

  const modifiers: ModifierDescriptor[] = []
  const seenModifierBits = new Set<number>()
  let mainToken: string | null = null

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const mod = resolveModifier(token, platform)
    if (mod) {
      if (!seenModifierBits.has(mod.bit)) {
        seenModifierBits.add(mod.bit)
        modifiers.push(mod)
      }
      continue
    }

    if (mainToken !== null) {
      throw new Error(`Invalid key chord "${input}": multiple non-modifier keys ("${mainToken}", "${token}")`)
    }
    mainToken = token
  }

  const modifiersBitmask = modifiers.reduce((mask, m) => mask | m.bit, 0)
  const hasShift = (modifiersBitmask & CDP_MODIFIERS.Shift) !== 0
  const hasNonShiftMod = (modifiersBitmask & ~CDP_MODIFIERS.Shift) !== 0
  const mainKey = mainToken !== null ? resolveMainKey(mainToken, hasShift, hasNonShiftMod) : null
  const commands = resolveEditingCommands(mainKey, modifiersBitmask, platform)

  const normalizedParts = [
    ...modifiers.map((m) => m.name),
    ...(mainKey ? [mainKey.key === ' ' ? 'Space' : mainKey.key.length === 1 && hasNonShiftMod ? mainKey.key.toUpperCase() : mainKey.key] : []),
  ]

  return {
    raw: input,
    normalized: normalizedParts.join('+'),
    modifiers,
    modifiersBitmask,
    mainKey,
    ...(commands ? { commands } : {}),
  }
}

/**
 * Build the ordered sequence of CDP `Input.dispatchKeyEvent` payloads for a parsed key chord:
 * 1. Press each modifier (`rawKeyDown`) accumulating the modifier bitmask
 * 2. Press main key (`keyDown` with text when printable without Ctrl/Alt/Meta, otherwise `rawKeyDown`)
 * 3. Release main key (`keyUp`)
 * 4. Release each modifier in reverse order (`keyUp`) clearing each modifier bit
 */
export function buildCdpKeyEvents(chord: ParsedKeyChord): CdpKeyEventParams[] {
  const events: CdpKeyEventParams[] = []
  let activeModifiers = 0

  for (const mod of chord.modifiers) {
    activeModifiers |= mod.bit
    events.push({
      type: 'rawKeyDown',
      modifiers: activeModifiers,
      key: mod.key,
      code: mod.code,
      windowsVirtualKeyCode: mod.windowsVirtualKeyCode,
      nativeVirtualKeyCode: mod.windowsVirtualKeyCode,
      location: mod.location,
    })
  }

  if (chord.mainKey) {
    const main = chord.mainKey
    const hasCommandMod = (activeModifiers & (CDP_MODIFIERS.Control | CDP_MODIFIERS.Alt | CDP_MODIFIERS.Meta)) !== 0
    const emitsText = !hasCommandMod && main.text !== undefined && main.text.length > 0

    const downEvent: CdpKeyEventParams = {
      type: emitsText ? 'keyDown' : 'rawKeyDown',
      modifiers: activeModifiers,
      key: main.key,
      code: main.code,
      windowsVirtualKeyCode: main.windowsVirtualKeyCode,
      nativeVirtualKeyCode: main.windowsVirtualKeyCode,
      ...(emitsText ? { text: main.text, unmodifiedText: main.unmodifiedText ?? main.text } : {}),
      ...(main.location !== undefined ? { location: main.location } : {}),
      ...(main.isKeypad ? { isKeypad: true } : {}),
      ...(chord.commands ? { commands: chord.commands } : {}),
    }

    const upEvent: CdpKeyEventParams = {
      type: 'keyUp',
      modifiers: activeModifiers,
      key: main.key,
      code: main.code,
      windowsVirtualKeyCode: main.windowsVirtualKeyCode,
      nativeVirtualKeyCode: main.windowsVirtualKeyCode,
      ...(main.location !== undefined ? { location: main.location } : {}),
      ...(main.isKeypad ? { isKeypad: true } : {}),
    }

    events.push(downEvent, upEvent)
  }

  for (let i = chord.modifiers.length - 1; i >= 0; i--) {
    const mod = chord.modifiers[i]!
    activeModifiers &= ~mod.bit
    events.push({
      type: 'keyUp',
      modifiers: activeModifiers,
      key: mod.key,
      code: mod.code,
      windowsVirtualKeyCode: mod.windowsVirtualKeyCode,
      nativeVirtualKeyCode: mod.windowsVirtualKeyCode,
      location: mod.location,
    })
  }

  return events
}

/**
 * Parse and dispatch a full keyboard chord over a CDP sender.
 */
export async function dispatchKeyChord(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  input: string,
  options: ParseKeyChordOptions = {},
): Promise<{ chord: ParsedKeyChord; eventsDispatched: number }> {
  const chord = parseKeyChord(input, options)
  const events = buildCdpKeyEvents(chord)
  for (const event of events) {
    await send('Input.dispatchKeyEvent', event as unknown as Record<string, unknown>)
  }
  return { chord, eventsDispatched: events.length }
}
