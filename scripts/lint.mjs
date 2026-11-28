#!/usr/bin/env node
/**
 * Strict TypeScript/ESM static linter for troy-advanced.
 *
 * Zero-dependency beyond TypeScript (already a devDependency). Parses every
 * `.ts` and `.mjs` file via the TypeScript Compiler AST and enforces strict
 * correctness, ESM hygiene, and formatting rules.
 *
 * Usage:
 *   node ./scripts/lint.mjs [paths...] [--json] [--quiet] [--list-rules]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const DEFAULT_TARGETS = ['src', 'test', 'bin', 'scripts']
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.troy-cron', '.trove', 'coverage'])
const LINTABLE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.mjs', '.js'])
const RESTRICTED_NAMES = new Set(['undefined', 'NaN', 'Infinity', 'eval', 'arguments'])

export const RULES = {
  'no-var': {
    severity: 'error',
    description: 'Disallow `var` declarations; use `const` or `let` instead.',
  },
  'no-debugger': {
    severity: 'error',
    description: 'Disallow `debugger` statements.',
  },
  'no-with': {
    severity: 'error',
    description: 'Disallow `with` statements.',
  },
  eqeqeq: {
    severity: 'error',
    description: 'Require strict equality (`===` / `!==`) except when comparing against `null`.',
  },
  'no-explicit-any': {
    severity: 'error',
    description: 'Disallow explicit `any` type annotations in `src/` files.',
  },
  'no-eval': {
    severity: 'error',
    description: 'Disallow `eval()` and `new Function()`.',
  },
  'no-duplicate-imports': {
    severity: 'error',
    description: 'Disallow duplicate imports from the same module specifier.',
  },
  'esm-relative-js-extension': {
    severity: 'error',
    description: 'Require explicit `.js`/`.mjs`/`.cjs`/`.json` extension on relative imports/exports in `src/`.',
  },
  'no-self-compare': {
    severity: 'error',
    description: 'Disallow comparing an expression against itself.',
  },
  'no-self-assign': {
    severity: 'error',
    description: 'Disallow assigning a variable or property to itself.',
  },
  'no-unsafe-finally': {
    severity: 'error',
    description: 'Disallow `return`, `throw`, `break`, or `continue` directly inside a `finally` block.',
  },
  'no-shadow-restricted-names': {
    severity: 'error',
    description: 'Disallow shadowing restricted globals (`undefined`, `NaN`, `Infinity`, `eval`, `arguments`).',
  },
  'no-duplicate-case': {
    severity: 'error',
    description: 'Disallow duplicate literal `case` labels in `switch` statements.',
  },
  'no-empty-interface': {
    severity: 'error',
    description: 'Disallow empty interface declarations without `extends`.',
  },
  'no-throw-literal': {
    severity: 'error',
    description: 'Require `throw` statements to throw an Error/expression rather than a primitive literal.',
  },
  'prefer-const': {
    severity: 'error',
    description: 'Require `const` for `let` bindings that are never reassigned.',
  },
  'no-crlf': {
    severity: 'error',
    description: 'Enforce Unix LF (`\\n`) line endings.',
  },
  'no-trailing-whitespace': {
    severity: 'error',
    description: 'Disallow trailing whitespace at end of lines.',
  },
  'eol-last': {
    severity: 'error',
    description: 'Require non-empty files to end with a trailing newline.',
  },
}

const COMPARISON_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])

const ASSIGNMENT_OPS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

function isNullLiteral(node) {
  return node.kind === ts.SyntaxKind.NullKeyword
}

function isSimpleComparableExpr(node) {
  return (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
}

function isSimpleAssignableExpr(node) {
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)
}

function getLiteralCaseKey(expr) {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return `str:${expr.text}`
  }
  if (ts.isNumericLiteral(expr)) {
    return `num:${Number(expr.text)}`
  }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return `num:${-Number(expr.operand.text)}`
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'bool:true'
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'bool:false'
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isIdentifier(expr) && expr.text === 'undefined') return 'undefined'
  return null
}

function isPrimitiveLiteral(expr) {
  return (
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isTemplateExpression(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && expr.text === 'undefined')
  )
}

/**
 * Parse inline disable comments:
 *   // lint-disable-next-line rule-a, rule-b
 *   // eslint-disable-next-line rule-a
 */
function parseDisableDirectives(lines) {
  const disabledByLine = new Map()
  const pattern = /\/\/\s*(?:lint|eslint)-disable-next-line(?:\s+([a-z0-9_,\s-]+))?/i
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i])
    if (!match) continue
    const targetLine = i + 2 // 1-indexed next line
    const rawRules = match[1]?.trim()
    if (!rawRules) {
      disabledByLine.set(targetLine, null) // null = disable all rules on that line
    } else {
      const existing = disabledByLine.get(targetLine)
      if (existing === null) continue
      const set = existing ?? new Set()
      for (const r of rawRules.split(/[\s,]+/)) {
        const trimmed = r.trim()
        if (trimmed) set.add(trimmed)
      }
      disabledByLine.set(targetLine, set)
    }
  }
  return disabledByLine
}

function isRuleSuppressed(disabledByLine, line, ruleId) {
  if (!disabledByLine.has(line)) return false
  const entry = disabledByLine.get(line)
  if (entry === null) return true
  return entry.has(ruleId)
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

function isLoopLike(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  )
}

/**
 * Collect all identifier names that are mutated (assigned, updated, or used as
 * a destructuring assignment target) anywhere inside `scopeNode`.
 */
function collectMutatedIdentifiers(scopeNode) {
  const mutated = new Set()

  function collectBindingTarget(target) {
    if (ts.isIdentifier(target)) {
      mutated.add(target.text)
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const el of target.elements) {
        if (ts.isSpreadElement(el)) collectBindingTarget(el.expression)
        else collectBindingTarget(el)
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const prop of target.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          mutated.add(prop.name.text)
        } else if (ts.isPropertyAssignment(prop)) {
          collectBindingTarget(prop.initializer)
        } else if (ts.isSpreadAssignment(prop)) {
          collectBindingTarget(prop.expression)
        }
      }
    } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectBindingTarget(target.left)
    } else if (ts.isParenthesizedExpression(target)) {
      collectBindingTarget(target.expression)
    }
  }

  function visit(node) {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPS.has(node.operatorToken.kind)) {
      collectBindingTarget(node.left)
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      if (ts.isIdentifier(node.operand)) {
        mutated.add(node.operand.text)
      }
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer)) {
        collectBindingTarget(node.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(scopeNode)
  return mutated
}

/**
 * Lint a single source string and return an array of diagnostics.
 *
 * @param {string} filePath - Logical or filesystem path (used to determine src/ vs test/ and script kind).
 * @param {string} content - UTF-8 source text.
 * @param {{ rootDir?: string }} [options]
 * @returns {Array<{ file: string, line: number, column: number, rule: string, severity: string, message: string }>}
 */
export function lintSource(filePath, content, options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const relPath = path.isAbsolute(filePath) ? path.relative(rootDir, filePath) : filePath
  const normalizedRel = relPath.split(path.sep).join('/')
  const isSrcTs = normalizedRel.startsWith('src/') && normalizedRel.endsWith('.ts')
  const isTs = normalizedRel.endsWith('.ts') || normalizedRel.endsWith('.mts') || normalizedRel.endsWith('.cts')

  const diagnostics = []
  const rawLines = content.split('\n')
  const disabledByLine = parseDisableDirectives(rawLines)

  function report(rule, line, column, message) {
    if (isRuleSuppressed(disabledByLine, line, rule)) return
    const meta = RULES[rule]
    diagnostics.push({
      file: normalizedRel,
      line,
      column,
      rule,
      severity: meta?.severity ?? 'error',
      message,
    })
  }

  // 1. Line-based formatting hygiene checks
  if (content.includes('\r\n')) {
    const idx = content.indexOf('\r\n')
    const line = content.slice(0, idx).split('\n').length
    report('no-crlf', line, 1, 'CRLF line endings detected; use Unix LF (`\\n`).')
  }

  if (content.length > 0 && !content.endsWith('\n')) {
    report('eol-last', rawLines.length, (rawLines[rawLines.length - 1]?.length ?? 0) + 1, 'File must end with a newline.')
  }

  // Parse TypeScript AST
  const scriptKind = isTs ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(normalizedRel, content, ts.ScriptTarget.Latest, true, scriptKind)

  // Collect line ranges inside multi-line template literals so we don't flag
  // intentional trailing spaces inside ASCII/template fixtures.
  const templateLines = new Set()
  function collectTemplateLines(node) {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      if (endLine > startLine) {
        for (let l = startLine; l <= endLine; l++) templateLines.add(l)
      }
    }
    ts.forEachChild(node, collectTemplateLines)
  }
  collectTemplateLines(sf)

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1
    if (templateLines.has(lineNo)) continue
    const lineText = rawLines[i].replace(/\r$/, '')
    if (/[ \t]+$/.test(lineText)) {
      report('no-trailing-whitespace', lineNo, lineText.trimEnd().length + 1, 'Trailing whitespace is not allowed.')
    }
  }

  function reportNode(rule, node, message) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    report(rule, line + 1, character + 1, message)
  }

  // Track module imports for no-duplicate-imports
  const seenValueImports = new Map()
  const seenTypeImports = new Map()

  function checkRestrictedName(nameNode) {
    if (nameNode && ts.isIdentifier(nameNode) && RESTRICTED_NAMES.has(nameNode.text)) {
      reportNode('no-shadow-restricted-names', nameNode, `Shadowing restricted global '${nameNode.text}' is not allowed.`)
    }
  }

  function checkUnsafeFinally(block) {
    function walk(node, inLoop, inSwitch) {
      if (isFunctionLike(node) || ts.isClassLike(node)) return
      if (ts.isReturnStatement(node)) {
        reportNode('no-unsafe-finally', node, 'Unsafe `return` statement inside `finally` block.')
        return
      }
      if (ts.isThrowStatement(node)) {
        reportNode('no-unsafe-finally', node, 'Unsafe `throw` statement inside `finally` block.')
        return
      }
      if (ts.isBreakStatement(node) && !inLoop && !inSwitch) {
        reportNode('no-unsafe-finally', node, 'Unsafe `break` statement inside `finally` block.')
        return
      }
      if (ts.isContinueStatement(node) && !inLoop) {
        reportNode('no-unsafe-finally', node, 'Unsafe `continue` statement inside `finally` block.')
        return
      }
      const nextInLoop = inLoop || isLoopLike(node)
      const nextInSwitch = inSwitch || ts.isSwitchStatement(node)
      ts.forEachChild(node, (child) => walk(child, nextInLoop, nextInSwitch))
    }
    ts.forEachChild(block, (child) => walk(child, false, false))
  }

  function findEnclosingScope(node) {
    let cur = node.parent
    while (cur) {
      if (
        ts.isBlock(cur) ||
        ts.isSourceFile(cur) ||
        ts.isModuleBlock(cur) ||
        ts.isCaseClause(cur) ||
        ts.isDefaultClause(cur) ||
        ts.isForStatement(cur) ||
        ts.isForInStatement(cur) ||
        ts.isForOfStatement(cur)
      ) {
        return cur
      }
      cur = cur.parent
    }
    return sf
  }

  const scopeMutationsCache = new WeakMap()
  function getMutatedInScope(scopeNode) {
    let set = scopeMutationsCache.get(scopeNode)
    if (!set) {
      set = collectMutatedIdentifiers(scopeNode)
      scopeMutationsCache.set(scopeNode, set)
    }
    return set
  }

  function visit(node) {
    // no-debugger
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      reportNode('no-debugger', node, 'Unexpected `debugger` statement.')
    }

    // no-with
    if (node.kind === ts.SyntaxKind.WithStatement) {
      reportNode('no-with', node, 'Unexpected `with` statement.')
    }

    // no-explicit-any (enforced strictly in src/**/*.ts)
    if (isSrcTs && node.kind === ts.SyntaxKind.AnyKeyword) {
      reportNode('no-explicit-any', node, 'Unexpected explicit `any`; use `unknown` or a concrete type.')
    }

    // no-var & prefer-const
    if (ts.isVariableDeclarationList(node)) {
      const isLet = (node.flags & ts.NodeFlags.Let) !== 0
      const isConst = (node.flags & ts.NodeFlags.Const) !== 0
      const isUsing =
        (ts.NodeFlags.Using !== undefined && (node.flags & ts.NodeFlags.Using) !== 0) ||
        (ts.NodeFlags.AwaitUsing !== undefined && (node.flags & ts.NodeFlags.AwaitUsing) !== 0)
      if (!isLet && !isConst && !isUsing) {
        reportNode('no-var', node, 'Unexpected `var`; use `const` or `let` instead.')
      }

      if (isLet) {
        const parent = node.parent
        // Check `for (let x of/in ...)` and regular `let x = ...`
        const isForOfOrIn = ts.isForOfStatement(parent) || ts.isForInStatement(parent)
        const isForInit = ts.isForStatement(parent) && parent.initializer === node
        if (!isForInit) {
          const scopeNode = isForOfOrIn ? parent : findEnclosingScope(node)
          const mutated = getMutatedInScope(scopeNode)
          // Only flag if EVERY declarator in the `let` list is an initialized simple identifier that is never mutated
          if (node.declarations.length > 0) {
            const allConstable = node.declarations.every((decl) => {
              if (!ts.isIdentifier(decl.name)) return false
              if (!isForOfOrIn && !decl.initializer) return false
              return !mutated.has(decl.name.text)
            })
            if (allConstable) {
              const names = node.declarations.map((d) => d.name.getText(sf)).join(', ')
              reportNode('prefer-const', node, `'${names}' is never reassigned; use 'const' instead of 'let'.`)
            }
          }
        }
      }
    }

    // no-shadow-restricted-names
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      checkRestrictedName(node.name)
    }

    // eqeqeq, no-self-compare, no-self-assign
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
        if (!isNullLiteral(node.left) && !isNullLiteral(node.right)) {
          const expected = op === ts.SyntaxKind.EqualsEqualsToken ? '===' : '!=='
          reportNode('eqeqeq', node.operatorToken, `Expected '${expected}' instead of '${node.operatorToken.getText(sf)}'.`)
        }
      }
      if (COMPARISON_OPS.has(op) && isSimpleComparableExpr(node.left) && isSimpleComparableExpr(node.right)) {
        const leftText = node.left.getText(sf).trim()
        const rightText = node.right.getText(sf).trim()
        if (leftText === rightText) {
          reportNode('no-self-compare', node, `Comparing '${leftText}' to itself is always constant.`)
        }
      }
      if (op === ts.SyntaxKind.EqualsToken && isSimpleAssignableExpr(node.left) && isSimpleAssignableExpr(node.right)) {
        const leftText = node.left.getText(sf).trim()
        const rightText = node.right.getText(sf).trim()
        if (leftText === rightText) {
          reportNode('no-self-assign', node, `'${leftText}' is assigned to itself.`)
        }
      }
    }

    // no-eval
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      reportNode('no-eval', node, 'Direct `eval()` calls are not allowed.')
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      reportNode('no-eval', node, '`new Function()` is not allowed.')
    }

    // no-duplicate-imports & esm-relative-js-extension
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      const isTypeOnly = Boolean(node.importClause?.isTypeOnly)
      const map = isTypeOnly ? seenTypeImports : seenValueImports
      if (map.has(spec)) {
        reportNode('no-duplicate-imports', node, `Duplicate ${isTypeOnly ? 'type ' : ''}import from '${spec}'.`)
      } else {
        map.set(spec, node)
      }

      if (isSrcTs && (spec.startsWith('./') || spec.startsWith('../'))) {
        if (!/\.(?:js|mjs|cjs|json)$/.test(spec)) {
          reportNode(
            'esm-relative-js-extension',
            node.moduleSpecifier,
            `Relative ESM import '${spec}' must include an explicit '.js' extension.`,
          )
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (isSrcTs && (spec.startsWith('./') || spec.startsWith('../'))) {
        if (!/\.(?:js|mjs|cjs|json)$/.test(spec)) {
          reportNode(
            'esm-relative-js-extension',
            node.moduleSpecifier,
            `Relative ESM export '${spec}' must include an explicit '.js' extension.`,
          )
        }
      }
    }

    // no-unsafe-finally
    if (ts.isTryStatement(node) && node.finallyBlock) {
      checkUnsafeFinally(node.finallyBlock)
    }

    // no-duplicate-case
    if (ts.isSwitchStatement(node)) {
      const seenCases = new Set()
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          const key = getLiteralCaseKey(clause.expression)
          if (key !== null) {
            if (seenCases.has(key)) {
              reportNode('no-duplicate-case', clause, `Duplicate case label '${clause.expression.getText(sf)}'.`)
            } else {
              seenCases.add(key)
            }
          }
        }
      }
    }

    // no-empty-interface
    if (
      ts.isInterfaceDeclaration(node) &&
      node.members.length === 0 &&
      (!node.heritageClauses || node.heritageClauses.length === 0)
    ) {
      reportNode('no-empty-interface', node, `Empty interface '${node.name.text}' is not allowed.`)
    }

    // no-throw-literal
    if (ts.isThrowStatement(node) && node.expression && isPrimitiveLiteral(node.expression)) {
      reportNode('no-throw-literal', node, 'Expected an Error object to be thrown instead of a literal.')
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)

  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule))
  return diagnostics
}

function collectFiles(targetPath, out) {
  if (!fs.existsSync(targetPath)) return
  const stat = fs.statSync(targetPath)
  if (stat.isFile()) {
    if (LINTABLE_EXTENSIONS.has(path.extname(targetPath))) {
      out.push(targetPath)
    }
    return
  }
  if (!stat.isDirectory()) return
  const entries = fs.readdirSync(targetPath, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const full = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      collectFiles(full, out)
    } else if (entry.isFile() && LINTABLE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
}

/**
 * Lint a list of file or directory paths.
 *
 * @param {string[]} [targets]
 * @param {{ rootDir?: string }} [options]
 */
export function lintPaths(targets = DEFAULT_TARGETS, options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const files = []
  for (const target of targets) {
    const resolved = path.isAbsolute(target) ? target : path.resolve(rootDir, target)
    collectFiles(resolved, files)
  }

  const diagnostics = []
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    const fileDiags = lintSource(file, content, { rootDir })
    diagnostics.push(...fileDiags)
  }

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warningCount = diagnostics.filter((d) => d.severity !== 'error').length

  return {
    ok: errorCount === 0,
    filesChecked: files.length,
    errorCount,
    warningCount,
    diagnostics,
  }
}

function main(argv) {
  let json = false
  let quiet = false
  let listRules = false
  const targets = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--quiet' || arg === '-q') quiet = true
    else if (arg === '--list-rules') listRules = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node ./scripts/lint.mjs [paths...] [--json] [--quiet] [--list-rules]\n',
      )
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      targets.push(arg)
    }
  }

  if (listRules) {
    if (json) {
      process.stdout.write(`${JSON.stringify(RULES, null, 2)}\n`)
    } else {
      for (const [id, meta] of Object.entries(RULES)) {
        process.stdout.write(`${id.padEnd(28)} [${meta.severity}] ${meta.description}\n`)
      }
    }
    process.exit(0)
  }

  const result = lintPaths(targets.length > 0 ? targets : DEFAULT_TARGETS)

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    for (const d of result.diagnostics) {
      process.stderr.write(`${d.file}:${d.line}:${d.column} ${d.severity} [${d.rule}] ${d.message}\n`)
    }
    if (!quiet || !result.ok) {
      const stream = result.ok ? process.stdout : process.stderr
      stream.write(
        `lint: ${result.ok ? 'PASS' : 'FAIL'} (${result.filesChecked} files, ${result.errorCount} errors, ${result.warningCount} warnings)\n`,
      )
    }
  }

  process.exit(result.ok ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2))
}
