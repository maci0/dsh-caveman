/**
 * Deterministic markdown corpus for the compress bench.
 *
 * Fixed seed, no network, no filesystem reads: the same bytes on every host
 * and every run, so instruction counts and CPU time stay comparable.
 *
 * @module dsh-caveman/bench/markdown-corpus
 */

/** xorshift32: tiny, deterministic, good enough to shuffle filler words. */
function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

const FLUFF = [
  'You should always', 'It is important to', 'Please note that',
  'Basically, you could consider', 'Actually, remember to', 'In order to',
  'It might be worth', 'Of course,', 'Certainly,', 'Just simply',
  'Make sure to', 'You might want to', 'Due to the fact that',
]

const SUBJECTS = ['the build', 'the test suite', 'this module', 'the handler', 'the cache', 'the parser', 'the config']
const VERBS = ['utilize', 'run', 'validate', 'extensive', 'rewrite', 'check']
const OBJECTS = ['the API', 'the input', 'the output', 'the schema', 'the rules', 'the pipeline']

const PROSE_LINES = [
  'The compression rules drop articles, filler, pleasantries, and hedging.',
  'However, the code spans must survive byte-identical through every rewrite.',
  'Furthermore, the backup is written before the live file is touched.',
  'The reason is because the masker keeps fenced blocks out of the prose pass.',
  'Additionally, a candidate that is not strictly smaller aborts the run.',
  'This is important to remember when the document mixes prose and code.',
]

const INLINE_SPANS = ['`npm test`', '`node --test`', '`src/compress-rules.ts`', '`--cpu-prof`', '`perf stat`', '`git revert HEAD`']
const PATHS = ['./src/index.ts', '../tests/compress.test.ts', '/usr/bin/perf', 'bench/markdown-corpus.mjs']
const URLS = ['https://example.com/docs', 'https://nodejs.org/api/perf_hooks.html', 'https://github.com/JuliusBrussee/caveman']

const FENCE_BODIES = [
  ['js', 'const regex = /\\b(?:a|an|the)\\b/gi\nfor (const line of lines) {\n  out.push(line.replace(regex, \'\'))\n}'],
  ['bash', 'for i in $(seq 1 100); do\n  node --test tests/*.test.ts || exit 1\ndone'],
  ['ts', 'export function validate(original: string, compressed: string): ValidationResult {\n  const errors: string[] = []\n  return { isValid: errors.length === 0, errors, warnings: [] }\n}'],
  ['json', '{\n  "name": "dsh-caveman",\n  "version": "0.7.0",\n  "private": true\n}'],
]

/**
 * Build one deterministic markdown document.
 * @param targetBytes - approximate document size in bytes.
 * @param seed - PRNG seed; same seed and size give identical bytes.
 * @returns markdown text.
 */
export function buildCorpus(targetBytes, seed = 0x5eed_1234) {
  const random = seededRandom(seed)
  const pick = (list) => list[Math.floor(random() * list.length) % list.length]
  const parts = []
  let bytes = 0
  let section = 0

  while (bytes < targetBytes) {
    section += 1
    const heading = `## Section ${section}\n`
    parts.push(heading)
    bytes += heading.length

    // Prose paragraph: 6-10 lines of realistic fluff-heavy English.
    const paragraph = []
    const lineCount = 6 + Math.floor(random() * 5)
    for (let i = 0; i < lineCount; i += 1) {
      const roll = random()
      if (roll < 0.35) {
        paragraph.push(`${pick(FLUFF)} ${pick(VERBS)} ${pick(OBJECTS)} inside ${pick(INLINE_SPANS)} today.`)
      } else if (roll < 0.6) {
        paragraph.push(`${pick(PROSE_LINES)} See ${pick(URLS)} for ${pick(SUBJECTS)}.`)
      } else if (roll < 0.85) {
        paragraph.push(`The ${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} via ${pick(INLINE_SPANS)} and ${pick(INLINE_SPANS)}.`)
      } else {
        paragraph.push(`Run ${pick(INLINE_SPANS)} ${pick(VERBS)} ${pick(OBJECTS)}; the ${pick(SUBJECTS)} stays intact.`)
      }
    }
    const prose = `${paragraph.join('\n')}\n\n`
    parts.push(prose)
    bytes += prose.length

    // Bullet list, exercises the list-marker preservation path.
    const bullets = []
    for (let i = 0; i < 4; i += 1) {
      bullets.push(`- ${pick(FLUFF)} ${pick(VERBS)} ${pick(OBJECTS)} before ${pick(SUBJECTS)}.`)
    }
    const list = `${bullets.join('\n')}\n\n`
    parts.push(list)
    bytes += list.length

    // Table, passes through untouched.
    const table = '| item | note |\n|---|---|\n| the cache | just warm |\n| a token | very short |\n\n'
    parts.push(table)
    bytes += table.length

    // Fenced code block.
    const [language, body] = pick(FENCE_BODIES)
    const fence = `\`\`\`${language}\n${body}\n\`\`\`\n\n`
    parts.push(fence)
    bytes += fence.length

    if (section % 4 === 0) {
      const indent = '    const indented = 1\n    const preserved = 2\n\n'
      parts.push(indent)
      bytes += indent.length
    }
  }

  return parts.join('')
}
