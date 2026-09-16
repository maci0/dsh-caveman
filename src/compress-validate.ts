/**
 * Structural validation of a compressed file against its original.
 *
 * TypeScript port of `skills/caveman-compress/scripts/validate.py` (MIT,
 * © JuliusBrussee). Same extractors, same six validators, same fail-closed
 * posture: headings/code/URLs/paths/inline-code must survive byte-identical,
 * bullets only warn on drift. The Python original is dropped.
 *
 * @module dsh-caveman/compress-validate
 */

const URL_REGEX = /https?:\/\/[^\s)]+/g
const FENCE_OPEN_REGEX = /^(\s{0,3})(`{3,}|~{3,})(.*)$/
const FENCE_MARKER_LINE_REGEX = /^\s*(?:`{3,}|~{3,})[^`~]*$/
const HEADING_REGEX = /^(#{1,6})\s+(.*)/gm
const BULLET_REGEX = /^\s*[-*+]\s+/gm
const LIST_ITEM_REGEX = /^\s*(?:[-*+]|\d+[.)])\s/
const PATH_REGEX = /(?:\.\/|\.\.\/|\/|[A-Za-z]:\\)[\w\-\/\\.]+|[\w\-\.]+[\/\\][\w\-\/\\.]+/g
const DEFINITE_PATH_REGEX = /^(?:\.\/|\.\.\/|\/|\|[A-Za-z]:\\)|[^\/\\]*\.[A-Za-z0-9]{1,8}$/

/** Outcome of validating one original/compressed pair. */
export interface ValidationResult {
  readonly isValid: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

function invalid(errors: string[], warnings: string[]): ValidationResult {
  return { isValid: errors.length === 0, errors, warnings }
}

export function extractHeadings(text: string): [string, string][] {
  const out: [string, string][] = []
  for (const match of text.matchAll(HEADING_REGEX)) {
    out.push([match[1] ?? '', (match[2] ?? '').trim()])
  }
  return out
}

function isFenceClose(line: string, fenceChar: string, fenceLen: number): boolean {
  const close = FENCE_OPEN_REGEX.exec(line)
  const run = close?.[2]
  if (run === undefined) return false
  return run[0] === fenceChar && run.length >= fenceLen && (close?.[3] ?? '').trim() === ''
}

function extractFencedSpans(lines: string[]): [number, number][] {
  const spans: [number, number][] = []
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN_REGEX.exec(lines[i] ?? '')
    if (open?.[2] === undefined) {
      i += 1
      continue
    }
    const fenceChar = open[2][0]
    const fenceLen = open[2].length
    const start = i
    i += 1
    while (i < lines.length) {
      if (isFenceClose(lines[i] ?? '', fenceChar ?? '', fenceLen)) {
        i += 1
        break
      }
      i += 1
    }
    spans.push([start, i])
  }
  return spans
}

function extractIndentedCodeBlocks(text: string): [number, string][] {
  const blocks: [number, string][] = []
  const lines = text.split('\n')
  const fenced = new Set<number>()
  for (const [start, end] of extractFencedSpans(lines)) {
    for (let i = start; i < end; i += 1) fenced.add(i)
  }
  let inList = false
  let previousBlank = true
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const stripped = line.trim()
    if (fenced.has(i)) {
      previousBlank = false
      i += 1
      continue
    }
    if (stripped === '') {
      previousBlank = true
      i += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (LIST_ITEM_REGEX.test(line)) inList = true
    else if (indent === 0) inList = false
    if (!inList && previousBlank && indent >= 4) {
      const start = i
      const run: string[] = []
      while (i < lines.length && !fenced.has(i)) {
        const current = lines[i] ?? ''
        if (current.trim() === '') {
          let lookahead = i + 1
          while (lookahead < lines.length && (lines[lookahead] ?? '').trim() === '') lookahead += 1
          const next = lines[lookahead] ?? ''
          if (lookahead < lines.length && !fenced.has(lookahead) && next.length - next.trimStart().length >= 4) {
            run.push(...lines.slice(i, lookahead))
            i = lookahead
            continue
          }
          break
        }
        if (current.length - current.trimStart().length < 4) break
        run.push(current)
        i += 1
      }
      if (run.length > 0) blocks.push([start, run.join('\n')])
      previousBlank = false
      continue
    }
    previousBlank = false
    i += 1
  }
  return blocks
}

export function extractCodeBlocks(text: string): string[] {
  const blocks: [number, string][] = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN_REGEX.exec(lines[i] ?? '')
    if (open?.[2] === undefined) {
      i += 1
      continue
    }
    const start = i
    const fenceChar = open[2][0]
    const fenceLen = open[2].length
    const blockLines = [lines[i] ?? '']
    i += 1
    let closed = false
    while (i < lines.length) {
      if (isFenceClose(lines[i] ?? '', fenceChar ?? '', fenceLen)) {
        blockLines.push(lines[i] ?? '')
        closed = true
        i += 1
        break
      }
      blockLines.push(lines[i] ?? '')
      i += 1
    }
    if (closed) blocks.push([start, blockLines.join('\n')])
  }
  return [...blocks, ...extractIndentedCodeBlocks(text)]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block)
}

export function extractUrls(text: string): Set<string> {
  return new Set(text.match(URL_REGEX) ?? [])
}

export function extractPaths(text: string): Set<string> {
  return new Set(text.match(PATH_REGEX) ?? [])
}

export function countBullets(text: string): number {
  return text.match(BULLET_REGEX)?.length ?? 0
}

export function extractInlineCodes(text: string): string[] {
  let stripped = text
  for (const block of extractCodeBlocks(text)) {
    stripped = stripped.replace(block, '')
  }
  stripped = stripped
    .split('\n')
    .map((line) => (FENCE_MARKER_LINE_REGEX.test(line) ? '' : line))
    .join('\n')
  return [...stripped.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
}

function difference(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => !right.has(item)))
}

function renderSpans(spans: Iterable<string>): string {
  const rendered = [...spans]
    .map((span) => span.replaceAll('\n', '\\n'))
    .map((flat) => (flat.length > 60 ? `${flat.slice(0, 60)}…` : flat))
    .map((flat) => JSON.stringify(flat))
    .sort()
  return `{${rendered.join(', ')}}`
}

/**
 * Validate a compressed candidate against its original.
 * @param original - original file text.
 * @param compressed - compressed candidate text.
 * @returns errors (fail-closed) and warnings (drift notes).
 */
export function validate(original: string, compressed: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const headingsOriginal = extractHeadings(original)
  const headingsCompressed = extractHeadings(compressed)
  if (headingsOriginal.length !== headingsCompressed.length) {
    errors.push(`Heading count mismatch: ${headingsOriginal.length} vs ${headingsCompressed.length}`)
  } else {
    const titlesOriginal = headingsOriginal.map(([, title]) => title)
    const titlesCompressed = headingsCompressed.map(([, title]) => title)
    if (JSON.stringify(titlesOriginal) !== JSON.stringify(titlesCompressed)) {
      const lost = titlesOriginal.filter((title) => !titlesCompressed.includes(title))
      const added = titlesCompressed.filter((title) => !titlesOriginal.includes(title))
      errors.push(`Heading text/order changed: lost=${JSON.stringify(lost)}, added=${JSON.stringify(added)}`)
    } else if (JSON.stringify(headingsOriginal) !== JSON.stringify(headingsCompressed)) {
      warnings.push('Heading levels changed')
    }
  }

  const codeOriginal = extractCodeBlocks(original)
  const codeCompressed = extractCodeBlocks(compressed)
  if (JSON.stringify(codeOriginal) !== JSON.stringify(codeCompressed)) {
    errors.push('Code blocks not preserved exactly')
  }

  const urlsOriginal = extractUrls(original)
  const urlsCompressed = extractUrls(compressed)
  const urlsLost = difference(urlsOriginal, urlsCompressed)
  const urlsAdded = difference(urlsCompressed, urlsOriginal)
  if (urlsLost.size > 0 || urlsAdded.size > 0) {
    errors.push(`URL mismatch: lost=${JSON.stringify([...urlsLost])}, added=${JSON.stringify([...urlsAdded])}`)
  }

  const pathsOriginal = extractPaths(original)
  const pathsCompressed = extractPaths(compressed)
  const pathsLost = difference(pathsOriginal, pathsCompressed)
  const pathsAdded = difference(pathsCompressed, pathsOriginal)
  const definite = [...pathsLost].filter((path) => DEFINITE_PATH_REGEX.test(path))
  if (definite.length > 0) errors.push(`File paths lost: ${JSON.stringify(definite.sort())}`)
  const indefinite = [...pathsLost].filter((path) => !DEFINITE_PATH_REGEX.test(path))
  if (indefinite.length > 0 || pathsAdded.size > 0) {
    warnings.push(`Path mismatch: lost=${JSON.stringify([...pathsLost].sort())}, added=${JSON.stringify([...pathsAdded].sort())}`)
  }

  const bulletsOriginal = countBullets(original)
  const bulletsCompressed = countBullets(compressed)
  if (bulletsOriginal > 0 && Math.abs(bulletsOriginal - bulletsCompressed) / bulletsOriginal > 0.15) {
    warnings.push(`Bullet count changed too much: ${bulletsOriginal} -> ${bulletsCompressed}`)
  }

  const codesOriginal = extractInlineCodes(original)
  const codesCompressed = extractInlineCodes(compressed)
  const countOriginal = new Map<string, number>()
  for (const span of codesOriginal) countOriginal.set(span, (countOriginal.get(span) ?? 0) + 1)
  const countCompressed = new Map<string, number>()
  for (const span of codesCompressed) countCompressed.set(span, (countCompressed.get(span) ?? 0) + 1)
  const lostSpans = new Set<string>()
  const addedSpans = new Set<string>()
  for (const [span, count] of countOriginal) {
    const have = countCompressed.get(span) ?? 0
    if (have < count) lostSpans.add(have === 0 ? span : `${span} (lost ${count - have} of ${count} occurrences)`)
  }
  for (const span of countCompressed.keys()) {
    if (!countOriginal.has(span)) addedSpans.add(span)
  }
  if (lostSpans.size > 0) errors.push(`Inline code lost: ${renderSpans(lostSpans)}`)
  if (addedSpans.size > 0) warnings.push(`Inline code added: ${renderSpans(addedSpans)}`)

  return invalid(errors, warnings)
}
