/**
 * Deterministic local compression rules: the caveman style without a model.
 *
 * This replaces the `callClaude` half of
 * `skills/caveman-compress/scripts/compress.py` (MIT, © JuliusBrussee),
 * which this plugin deliberately does not port — shipping file bytes to a
 * third-party model for a local rewrite is the "dumb feature" this port
 * leaves out. Everything else (detect, validate, file handling) is ported
 * faithfully; only the rewrite step is local and rule-based.
 *
 * Rules mirror the skill's Compression Rules section: drop articles, filler,
 * pleasantries, hedging, and connective fluff; shorten redundant phrasing;
 * keep code/URLs/paths/commands/technical terms/numbers byte-identical;
 * never touch headings. Code spans (fenced, indented, inline) are masked
 * before rewriting and restored after, so prose rules cannot reach them.
 *
 * @module dsh-caveman/compress-rules
 */

const FENCE_OPEN_REGEX = /^[ ]{0,3}(`{3,}|~{3,})(?:[^\r\n]*)$/
const CODE_MARKER_PREFIX = '@@CAVEMAN_PRESERVED_CODE_'
const LIST_ITEM_REGEX = /^\s*(?:[-*+]|\d+[.)])\s/

/** Articles dropped everywhere outside code. */
const ARTICLES = /\b(a|an|the)\b\s*/gi

/** Filler adverbs and adjectives dropped everywhere outside code. */
const FILLER = /\b(just|really|basically|actually|simply|essentially|generally|very|quite|rather)\b\s*/gi

/** Pleasantries and recommendations dropped outside code. */
const PLEASANTRIES = /\b(sure|certainly|of course|happy to|i'd recommend|we'd recommend|please note that|please)\b[,.!]?\s*/gi

/** Hedging constructions tightened outside code. */
const HEDGING: [RegExp, string][] = [
  [/\bit might be worth\b\s*/gi, ''],
  [/\byou could consider\b\s*/gi, ''],
  [/\bit would be good to\b\s*/gi, ''],
  [/\byou might want to\b\s*/gi, ''],
  [/\bit seems (like |that )?/gi, ''],
  [/\b(perhaps|maybe)\b\s*/gi, ''],
]

/** Redundant phrasing shortened outside code. */
const REDUNDANT: [RegExp, string][] = [
  [/\bin order to\b/gi, 'to'],
  [/\bmake sure to\b/gi, ''],
  [/\bremember to\b/gi, ''],
  [/\bthe reason (is|why) because\b/gi, 'because'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\byou should (always )?/gi, ''],
  [/\b(it is|it's|this is) important (to|because|that)\b/gi, ''],
  [/\bimplement a solution for\b/gi, 'fix'],
  [/\butilize\b/gi, 'use'],
  [/\bextensive\b/gi, 'big'],
]

/** Connective fluff dropped at sentence starts outside code. */
const CONNECTIVES = /(^|[.!?]\s+)(however|furthermore|additionally|moreover|in addition|also)\b[,.]?\s*/gi

/** Trailing connective residue (`, however.`) dropped at line end, keeping the stop. */
const TRAILING_CONNECTIVE = /,\s*(however|furthermore|additionally|moreover|in addition|also)\s*([.!]?)\s*$/i

/**
 * Mask fenced and indented code blocks with opaque markers.
 * @param text - markdown body.
 * @returns masked text plus the blocks for restoration.
 */
export function maskCodeBlocks(text: string): { masked: string; blocks: string[] } {
  if (text.includes(CODE_MARKER_PREFIX)) {
    throw new Error('Input contains reserved Caveman code-preservation marker')
  }
  const lines = text.split('\n')
  const out: string[] = []
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE_OPEN_REGEX.exec(line)
    const indented = line !== '' && (line.startsWith('    ') || line.startsWith('\t'))
    if (fence === null && !indented) {
      out.push(line)
      i += 1
      continue
    }
    const start = i
    if (fence?.[1] !== undefined) {
      const run = fence[1]
      const close = new RegExp(`^[ ]{0,3}${run[0]}{${run.length},}[ \\t]*$`)
      i += 1
      while (i < lines.length) {
        if (close.test(lines[i] ?? '')) {
          i += 1
          break
        }
        i += 1
      }
    } else {
      i += 1
      while (i < lines.length) {
        const candidate = lines[i] ?? ''
        if (candidate.trim() === '' || candidate.startsWith('    ') || candidate.startsWith('\t')) {
          i += 1
          continue
        }
        break
      }
    }
    const block = lines.slice(start, i).join('\n')
    const marker = `${CODE_MARKER_PREFIX}${blocks.length}@@`
    blocks.push(block)
    out.push(marker)
  }
  return { masked: out.join('\n'), blocks }
}

/**
 * Restore masked code blocks exactly; fail closed on tampering.
 * @param text - rewritten text with markers.
 * @param blocks - blocks from {@link maskCodeBlocks}.
 * @returns text with code restored.
 */
export function restoreCodeBlocks(text: string, blocks: string[]): string {
  let restored = text
  blocks.forEach((block, index) => {
    const marker = `${CODE_MARKER_PREFIX}${index}@@`
    const count = restored.split(marker).length - 1
    if (count !== 1) throw new Error(`Preserved code marker ${marker} altered; refusing to write`)
    restored = restored.replace(marker, block)
  })
  if (restored.includes(CODE_MARKER_PREFIX)) {
    throw new Error('Unknown Caveman code-preservation marker in output')
  }
  return restored
}

/**
 * Compress one prose line: drop fluff, tighten phrasing, collapse space.
 * Inline code spans (`` `...` ``) are masked first so rules skip them.
 * @param line - a single non-heading, non-code line.
 * @returns the compressed line.
 */
export function compressLine(line: string): string {
  const spans: string[] = []
  const masked = line.replace(/`[^`]+`/g, (span) => {
    spans.push(span)
    return `@@caveman-inline-${spans.length - 1}@@`
  })
  let out = masked
  for (const [pattern, replacement] of [...HEDGING, ...REDUNDANT]) {
    out = out.replace(pattern, replacement)
  }
  out = out.replace(PLEASANTRIES, '')
  out = out.replace(FILLER, '')
  out = out.replace(ARTICLES, '')
  out = out.replace(CONNECTIVES, '$1')
  out = out.replace(TRAILING_CONNECTIVE, '$2')
  out = out.replace(/[ \t]{2,}/g, ' ').trim()
  out = out.replace(/\s+([,.!?;:])/g, '$1')
  return out.replace(/@@caveman-inline-(\d+)@@/g, (_, index: string) => spans[Number(index)] ?? '')
}

/**
 * Compress a markdown body with local rules. Headings pass through
 * byte-identical; list markers and table pipes are preserved; everything
 * else goes through {@link compressLine}. Empty results fall back to the
 * original line so structure never collapses.
 * @param body - markdown body (frontmatter already removed).
 * @returns the compressed body.
 */
export function compressBody(body: string): string {
  const { masked, blocks } = maskCodeBlocks(body)
  const lines = masked.split('\n').map((line) => {
    if (line.trim() === '') return line
    if (/^#{1,6}\s/.test(line)) return line
    if (line.includes(CODE_MARKER_PREFIX)) return line
    const item = LIST_ITEM_REGEX.exec(line)
    if (item !== null) {
      const compressed = compressLine(line.slice(item[0].length))
      return (compressed === '' ? line : item[0] + compressed)
    }
    if (line.trim().startsWith('|')) return line
    const compressed = compressLine(line)
    return compressed === '' ? line : compressed
  })
  return restoreCodeBlocks(lines.join('\n'), blocks)
}

/**
 * Whether the candidate actually compresses the body (strictly smaller).
 * Guard against a rewrite that validates structurally but saves nothing.
 * @param candidate - compressed body.
 * @param body - original body.
 * @returns true when strictly smaller.
 */
export function isSmaller(candidate: string, body: string): boolean {
  return candidate.trim().length < body.trim().length
}
