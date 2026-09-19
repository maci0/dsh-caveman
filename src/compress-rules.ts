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

/** Memoized closer per opening fence run; documents reuse one or two markers. */
const FENCE_CLOSE_CACHE = new Map<string, RegExp>()

/**
 * Closing-fence matcher for an opening run: same character, at least as long,
 * no info string. Cached because the pattern only depends on the run.
 * @param run - the opening fence run, e.g. ` ``` ` or `~~~`.
 * @returns the anchored closer regex.
 */
function fenceCloseRegex(run: string): RegExp {
  const cached = FENCE_CLOSE_CACHE.get(run)
  if (cached !== undefined) return cached
  const compiled = new RegExp(`^[ ]{0,3}${run[0]}{${run.length},}[ \\t]*$`)
  FENCE_CLOSE_CACHE.set(run, compiled)
  return compiled
}

/**
 * Phrase renames: the rewrite rules that emit a replacement word instead of
 * nothing. These run *before* {@link DROP}, and that order is load-bearing: in
 * the original single-pass alternation the rename branches sat at the end, so
 * a rename phrase always won over the article inside it — "implement a
 * solution for a thing" became "fix thing", not "implement solution for a
 * thing". Renaming first preserves that.
 *
 * Each phrase carries the word the ruleset names for it
 * (`skills/caveman-compress/SKILL.md`: `"big" not "extensive"`, `"fix" not
 * "implement a solution for"`, `"use" not "utilize"`), plus `to` for `in order
 * to` and `because` for `due to the fact that`.
 *
 * `the reason (?:is|why) because` was a branch of that alternation and is not
 * one here: the article branch preceded it and any text it could match starts
 * with `the\b`, so the article branch always consumed that text first and the
 * branch could never fire (0 hits over the repo docs and the bench corpus).
 * Groups, in order: 1 = `to`, 2 = `because`, 3 = `fix`, 4 = `use`, 5 = `big`.
 */
const RENAME = new RegExp(
  String.raw`\b(?:${[
    String.raw`(in order to\b)`,
    String.raw`(due to the fact that\b)`,
    String.raw`(implement a solution for\b)`,
    String.raw`(utilize\b)`,
    String.raw`(extensive\b)`,
  ].join('|')})`,
  'gi',
)

/**
 * Drop-only rules: everything the rewrite deletes. One pass with a plain
 * string replacement, so the frequent matches (articles, filler words) do not
 * pay for a replacer call; the rare renames above keep the function replacer.
 *
 * The leading `\b` is written once around the alternation instead of once per
 * branch: every branch starts with a word character, so the assertion is the
 * same at a given position either way, and one boundary check in front of the
 * branch dispatch retires roughly half the instructions the engine spent
 * re-checking it before each branch.
 */
const DROP = new RegExp(
  String.raw`\b(?:${[
    String.raw`it might be worth\b\s*`,
    String.raw`you could consider\b\s*`,
    String.raw`it would be good to\b\s*`,
    String.raw`you might want to\b\s*`,
    String.raw`it seems (?:like |that )?`,
    String.raw`(?:perhaps|maybe)\b\s*`,
    String.raw`make sure to\b\s*`,
    String.raw`remember to\b\s*`,
    String.raw`you should (?:always )?\b\s*`,
    String.raw`(?:it is|it's|this is) important (?:to|because|that)\b\s*`,
    String.raw`sure\b[,.!]?\s*`,
    String.raw`certainly\b[,.!]?\s*`,
    String.raw`of course\b[,.!]?\s*`,
    String.raw`happy to\b[,.!]?\s*`,
    String.raw`i'd recommend\b[,.!]?\s*`,
    String.raw`we'd recommend\b[,.!]?\s*`,
    String.raw`please note that\b\s*`,
    String.raw`please\b[,.!]?\s*`,
    String.raw`(?:just|really|basically|actually|simply|essentially|generally|very|quite|rather)\b\s*`,
    String.raw`(?:a|an|the)\b\s*`,
  ].join('|')})`,
  'gi',
)

function rewriteReplacer(_match: string, to: string | undefined, because: string | undefined, fix: string | undefined, use: string | undefined, big: string | undefined): string {
  if (to !== undefined) return 'to'
  if (because !== undefined) return 'because'
  if (fix !== undefined) return 'fix'
  if (use !== undefined) return 'use'
  if (big !== undefined) return 'big'
  return ''
}

/** Connective fluff dropped at sentence starts outside code. */
const CONNECTIVES = /(^|[.!?]\s+)(however|furthermore|additionally|moreover|in addition|also)\b[,.]?\s*/gi

/** Trailing connective residue (`, however.`) dropped at line end, keeping the stop. */
const TRAILING_CONNECTIVE = /,\s*(however|furthermore|additionally|moreover|in addition|also)\s*([.!]?)\s*$/i

/** Inline code spans, masked to a marker before the prose rules run. */
const INLINE_SPAN = /`[^`]+`/g

/** The mask an inline span is replaced with; index is the span's slot. */
const INLINE_SPAN_MARKER = /@@caveman-inline-(\d+)@@/g

/** Runs of spaces/tabs collapsed to one space. */
const SPACE_RUN = /[ \t]{2,}/g

/** Whitespace before punctuation, dropped. */
const SPACE_BEFORE_PUNCT = /\s+([,.!?;:])/g

/** An ATX heading line; those pass through byte-identical. */
const HEADING_LINE = /^#{1,6}\s/

/**
 * Mask fenced and indented code blocks with opaque markers.
 *
 * The output is assembled from the *gaps between* blocks instead of one string
 * per line: a document with no code returns the input string itself, and a
 * document with three blocks pushes a handful of segments rather than tens of
 * thousands of line references and then joins them all. The result is
 * identical — each segment is a run of whole lines and the join puts the same
 * `\n` separators back.
 * @param text - markdown body.
 * @returns masked text plus the blocks for restoration.
 */
export function maskCodeBlocks(text: string): { masked: string; blocks: string[] } {
  if (text.includes(CODE_MARKER_PREFIX)) {
    throw new Error('Input contains reserved Caveman code-preservation marker')
  }
  const lines = text.split('\n')
  const blocks: string[] = []
  /** Output segments, or null while no block has been found. */
  let out: string[] | null = null
  /** First line not yet emitted into `out`. */
  let cursor = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE_OPEN_REGEX.exec(line)
    const indented = line !== '' && (line.startsWith('    ') || line.startsWith('\t'))
    if (fence === null && !indented) {
      i += 1
      continue
    }
    const start = i
    if (fence?.[1] !== undefined) {
      const run = fence[1]
      const close = fenceCloseRegex(run)
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
    if (out === null) out = []
    // Skip an empty gap: two blocks can be adjacent, and an empty segment
    // would add a separator the original one-line-per-entry layout did not.
    if (start > cursor) out.push(lines.slice(cursor, start).join('\n'))
    const marker = `${CODE_MARKER_PREFIX}${blocks.length}@@`
    blocks.push(block)
    out.push(marker)
    cursor = i
  }
  // No code: hand back the input string, no join and no per-line segment.
  if (out === null) return { masked: text, blocks }
  if (cursor < lines.length) out.push(lines.slice(cursor).join('\n'))
  return { masked: out.join('\n'), blocks }
}

/**
 * Restore masked code blocks exactly; fail closed on tampering.
 * @param text - rewritten text with markers.
 * @param blocks - blocks from {@link maskCodeBlocks}.
 * @returns text with code restored.
 */
export function restoreCodeBlocks(text: string, blocks: string[]): string {
  if (blocks.length === 0) {
    if (text.includes(CODE_MARKER_PREFIX)) {
      throw new Error('Unknown Caveman code-preservation marker in output')
    }
    return text
  }
  // Single pass: one combined pattern replaces every marker via lookup,
  // instead of two full scans per block. A marker appearing anything but
  // exactly once fails closed below.
  const pattern = new RegExp(`${CODE_MARKER_PREFIX}(\\d+)@@`, 'g')
  const seen = new Array<number>(blocks.length).fill(0)
  const restored = text.replace(pattern, (marker, index: string) => {
    const slot = Number(index)
    if (!Number.isInteger(slot) || slot < 0 || slot >= blocks.length) return marker
    seen[slot] = (seen[slot] ?? 0) + 1
    return blocks[slot] ?? marker
  })
  for (let index = 0; index < blocks.length; index += 1) {
    if (seen[index] !== 1) {
      throw new Error(`Preserved code marker ${CODE_MARKER_PREFIX}${index}@@ altered; refusing to write`)
    }
  }
  if (CODE_MARKER_PREFIX.length > 0 && restored.includes(CODE_MARKER_PREFIX)) {
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
  // Two guards over work most lines cannot need: a line with no backtick has
  // no span to mask or restore, and `, however.` is the only shape the
  // trailing-connective rule can match. Both keep the output byte-identical.
  const spans: string[] = []
  let masked = line
  if (line.includes('`')) {
    masked = line.replace(INLINE_SPAN, (span) => {
      spans.push(span)
      return `@@caveman-inline-${spans.length - 1}@@`
    })
  }
  let out = masked.replace(RENAME, rewriteReplacer as (substring: string, ...args: unknown[]) => string)
  out = out.replace(DROP, '')
  out = out.replace(CONNECTIVES, '$1')
  if (out.includes(',')) out = out.replace(TRAILING_CONNECTIVE, '$2')
  out = out.replace(SPACE_RUN, ' ').trim()
  out = out.replace(SPACE_BEFORE_PUNCT, '$1')
  if (spans.length === 0) return out
  return out.replace(INLINE_SPAN_MARKER, (_, index: string) => spans[Number(index)] ?? '')
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
  // In place over the one array `split` already produced: no second array and
  // no per-line callback frame. Skipped lines keep their own string.
  const lines = masked.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (HEADING_LINE.test(line)) continue
    if (line.includes(CODE_MARKER_PREFIX)) continue
    const item = LIST_ITEM_REGEX.exec(line)
    if (item !== null) {
      const compressed = compressLine(line.slice(item[0].length))
      if (compressed !== '') lines[index] = item[0] + compressed
      continue
    }
    if (trimmed.startsWith('|')) continue
    const compressed = compressLine(line)
    if (compressed !== '') lines[index] = compressed
  }
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
