/**
 * Adversarial parity gate for the frontmatter fast path.
 *
 * The fast path claims a block only when it can prove `yaml` would read it the
 * same way; everything else must fall back to the real parser. These are the
 * inputs where a previous version claimed a block it could not prove, so each
 * one is parsed by the reader under test and by `yaml` over the same regex, and
 * the two results are compared with `deepStrictEqual` — including the throws, so
 * a block `yaml` rejects must still be rejected rather than silently flattened.
 *
 * `yaml` is imported here as the oracle only. `src/frontmatter.ts` must never
 * import it at module scope; `frontmatter-fast.test.ts` is the gate for that.
 *
 * @module dsh-caveman/tests/frontmatter-adversarial
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse as yamlParse } from 'yaml'
import { parseFrontmatter, parseFrontmatterAsync } from '../src/frontmatter.ts'

const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** The reader the fast path must match: `yaml` over the same regex and body rule. */
function reference(source: string): { raw: string; data: Readonly<Record<string, unknown>>; body: string } {
  const text = source.replace(/^\uFEFF/, '')
  const match = FRONTMATTER_BLOCK.exec(text)
  if (match === null) return { raw: '', data: {}, body: text }
  const raw = match[0]
  const body = text.slice(raw.length).replace(/\r\n/g, '\n')
  // `logLevel: 'error'` keeps `parse`'s exact semantics — a real parse failure
  // still throws, multiple documents still throw — while dropping the advisory
  // warnings the deliberately odd scalars below would print to stderr.
  const parsed: unknown = yamlParse(match[1] ?? '', { logLevel: 'error' })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { raw, data: {}, body }
  return { raw, data: parsed as Record<string, unknown>, body }
}

/**
 * Each confirmed divergence, then the rest of the adversarial surface: every
 * shape the fast path must refuse and hand to `yaml`. `name` names the axis so
 * a failure says what broke, not just which string.
 */
const CASES: ReadonlyArray<readonly [string, string]> = [
  // Confirmed divergences of the previous fast path.
  ['duplicate keys throw like yaml', '---\nname: a\nname: b\n---\nbody\n'],
  ['duplicate keys with another key', '---\nname: a\ndescription: d\nname: b\n---\nbody\n'],
  ['whitespace-only block line keeps its residual space', '---\ndescription: |\n  a\n   \n  b\n---\nbody\n'],
  ['whitespace-only folded block line', '---\ndescription: >\n  a\n \n  b\n---\nbody\n'],
  ['leading-zero integer resolves to a number', '---\nv: 01\n---\nbody\n'],
  ['padded integer resolves to a number', '---\nv: 0009\n---\nbody\n'],
  ['signed padded integer resolves to a number', '---\nv: +007\n---\nbody\n'],
  ['zero-width no-break space inside the block is a key to yaml', '---\ndescription: |\n\uFEFFname: x\n---\nbody\n'],
  ['no-break space inside the block is content', '---\ndescription: |\n\u00A0name: x\n---\nbody\n'],
  ['vertical tab is content to yaml, not separation', '---\nname: a\u000Bb\n---\nbody\n'],
  ['bool word as a key keeps yaml\u2019s name', '---\nTrue: v\n---\nbody\n'],
  ['null word as a key keeps yaml\u2019s name', '---\nNULL: v\n---\nbody\n'],

  // Keep-chomping trailing blank lines, with and without a following key.
  ['keep-chomped literal trailing blanks', '---\ndescription: |+\n  a\n\n\n---\nbody\n'],
  ['keep-chomped folded trailing blanks', '---\ndescription: >+\n  a\n\n\n---\nbody\n'],
  ['keep-chomped literal before another key', '---\ndescription: |+\n  a\n\nname: x\n---\nbody\n'],
  ['keep-chomped folded before another key', '---\ndescription: >+\n  a\n\nname: x\n---\nbody\n'],
  ['strip and clip chomping', '---\na: |-\n  one\n  two\nb: |\n  one\n  two\n---\nbody\n'],

  // Line breaks inside the block.
  ['bare CR inside a value', '---\ndescription: cars\rcrash\n---\nbody\n'],
  ['bare CR inside a block scalar body', '---\ndescription: |\n  cars\rcrash\n---\nbody\n'],
  ['CRLF throughout the block', '---\r\nname: probe\r\ndescription: >\r\n  folded here.\r\n---\r\nbody\r\n'],

  // Shapes the reader must refuse rather than flatten.
  ['nested maps', '---\nname: nested\nmetadata:\n  owner: caveman\n---\nbody\n'],
  ['lists', '---\nname: listed\nflags:\n  - a\n  - b\n---\nbody\n'],
  ['flow collections', '---\nname: flow\nmeta: {a: 1}\nlist: [1, 2]\n---\nbody\n'],
  ['nested map without a leading key', '---\n  a: b\n---\nbody\n'],
  ['colon without a space is not a key', '---\na:b\n---\nbody\n'],
  ['explicit key syntax', '---\n? a\n---\nbody\n'],
  ['anchor on a plain scalar', '---\nname: &x v\n---\nbody\n'],
  ['tag on a plain scalar', '---\nname: !!str 1\n---\nbody\n'],
  ['multi-line plain scalar', '---\ndescription: a\n  b\n---\nbody\n'],
  ['bare scalar block', '---\nnot a mapping\n---\nbody\n'],
  ['multi-line bare scalar block', '---\nplain\nscalar\n---\nbody\n'],
  ['empty value resolves to null', '---\nname:\ndescription: x\n---\nbody\n'],
  ['sequence block', '---\n- one\n- two\n---\nbody\n'],

  // Plain scalars whose type the reader must leave to `yaml`.
  ['hex integer', '---\nv: 0x10\n---\nbody\n'],
  ['octal integer', '---\nv: 0o17\n---\nbody\n'],
  ['infinity', '---\nv: .inf\n---\nbody\n'],
  ['not-a-number', '---\nv: .nan\n---\nbody\n'],
  ['underscored digits stay a string', '---\nv: 1_000\n---\nbody\n'],
  ['exponent without a dot', '---\nv: 1e5\n---\nbody\n'],
  ['date-like plain scalar stays a string', '---\nv: 2024-01-01\n---\nbody\n'],
  ['timestamp-like plain scalar', '---\nv: 2024-01-01T00:00:00Z\n---\nbody\n'],
  ['nested mapping in a value', '---\ndescription: a: b\n---\nbody\n'],
  ['comma-led plain scalar', '---\nv: ,a\n---\nbody\n'],
  ['quoted key, single', "---\n'qk': v\n---\nbody\n"],
  ['quoted key, double', '---\n"qk": v\n---\nbody\n'],
  ['proto key stays an own data property', '---\n__proto__: x\n---\nbody\n'],
  ['double-quoted escapes the reader knows', '---\nname: "a\\"b\\\\c\\nd"\n---\nbody\n'],
  ['double-quoted escape the reader must refuse', '---\nname: "\\u0041"\n---\nbody\n'],
  ['unterminated double quote', '---\nname: "unterminated\n---\nbody\n'],

  // Block scalar bodies.
  ['tab-indented block body', '---\ndescription: |\n\ta\n---\nbody\n'],
  ['tab inside a block body line', '---\ndescription: |\n  a\tb\n---\nbody\n'],
  ['more-indented block body', '---\ndescription: >\n  plain\n    deeper\n---\nbody\n'],
  ['whitespace-only block body', '---\ndescription: |\n   \n---\nbody\n'],
  ['leading blank lines in a block body', '---\ndescription: |\n\n  a\n---\nbody\n'],
  ['explicit indentation indicator', '---\ndescription: |2\n  a\n---\nbody\n'],
  ['comment after a block header', '---\ndescription: | # c\n  a\n---\nbody\n'],
  ['empty block body', '---\ndescription: |\nname: x\n---\nbody\n'],
  ['empty block body then blank line', '---\ndescription: |\n\nname: x\n---\nbody\n'],

  // Document framing.
  ['empty block', '---\n---\nbody\n'],
  ['comments-only block', '---\n# nothing\n\n---\nbody\n'],
  ['leading blank line before the first key', '---\n\nname: x\n---\nbody\n'],
  ['document start inside a literal value', '---\ndescription: |\n  a\n  ---\n  b\n---\nbody\n'],
  ['document end marker', '---\nname: x\n...\n---\nbody\n'],
  ['BOM before the opening delimiter', '\uFEFF---\nname: x\n---\nbody\n'],
  ['BOM-only block', '\uFEFF---\n---\nbody\n'],
  ['unclosed frontmatter', '---\nname: x\nbody\n'],
  ['no frontmatter', '# just markdown\nname: x\n'],
  ['empty source', ''],
]

for (const [name, source] of CASES) {
  test(`fast reader matches yaml: ${name}`, async () => {
    let expected: ReturnType<typeof reference> | undefined
    let threw = false
    try {
      expected = reference(source)
    } catch {
      threw = true
    }

    if (threw) {
      assert.throws(() => parseFrontmatter(source), `${name} must still throw`)
      await assert.rejects(() => parseFrontmatterAsync(source), `${name} must still reject`)
      return
    }

    const sync = parseFrontmatter(source)
    assert.deepStrictEqual(sync.data, expected!.data, `${name} diverged synchronously (data)`)
    assert.equal(sync.body, expected!.body, `${name} diverged synchronously (body)`)

    const async = await parseFrontmatterAsync(source)
    assert.deepStrictEqual(async.data, expected!.data, `${name} diverged asynchronously (data)`)
    assert.equal(async.body, expected!.body, `${name} diverged asynchronously (body)`)
  })
}

/**
 * The scalar boundary, swept rather than sampled: every one- and two-character
 * key and value the core schema's tags could disagree with `trim` about, drawn
 * from the characters those tags are built out of. A new tag-shaped guess in the
 * fast path fails here even when no fixture names it.
 */
const BOUNDARY_ALPHABET = [
  '0', '1', '9', '.', 'e', 'E', '+', '-', '_', 'x', 'o', 'n', 'N', 'u', 'l', 'L',
  't', 'T', 'r', 'R', 'f', 'F', 'a', '~', ':', ' ', "'", '"', '?', ',', '!', '&',
  '*', '|', '>', '%', '@', '`', '[', ']', '{', '}', '\t',
]

/** Every non-empty string up to `maxLength` over `alphabet`, shortest first. */
function words(alphabet: readonly string[], maxLength: number): string[] {
  const out: string[] = []
  const walk = (prefix: string): void => {
    if (prefix !== '') out.push(prefix)
    if (prefix.length === maxLength) return
    for (const char of alphabet) walk(prefix + char)
  }
  walk('')
  return out
}

/**
 * Run `subject` with `process.emitWarning` muted.
 *
 * `yaml` reports advisories — an ambiguous `&`/`*` anchor, a collection-valued
 * key — through `process.emitWarning`, both from the oracle and from the
 * production fallback the fast path hands those tokens to. The boundary alphabet
 * below is chosen to trip them, so they are muted for the sweep; no assertion
 * depends on a warning, and the mute is restored afterwards.
 * @param subject - the work to run muted.
 * @returns whatever `subject` resolves to.
 */
async function mutingWarnings<T>(subject: () => Promise<T>): Promise<T> {
  const emitWarning = process.emitWarning
  process.emitWarning = (() => {}) as typeof process.emitWarning
  try {
    return await subject()
  } finally {
    process.emitWarning = emitWarning
  }
}

for (const [axis, block] of [
  ['value', (word: string) => `v: ${word}`],
  ['key', (word: string) => `${word}: v`],
] as ReadonlyArray<readonly [string, (word: string) => string]>) {
  test(`fast reader matches yaml across the scalar boundary alphabet (${axis})`, async () => {
    await mutingWarnings(async () => {
      for (const word of words(BOUNDARY_ALPHABET, 2)) {
        const body = block(word)
        const source = `---\n${body}\n---\nbody\n`
        let expected: ReturnType<typeof reference> | undefined
        let threw = false
        try {
          expected = reference(source)
        } catch {
          threw = true
        }

        if (threw) {
          assert.throws(() => parseFrontmatter(source), `${axis} ${JSON.stringify(word)} must still throw`)
          await assert.rejects(() => parseFrontmatterAsync(source), `${axis} ${JSON.stringify(word)} must still reject`)
          continue
        }

        const sync = parseFrontmatter(source)
        assert.deepStrictEqual(sync.data, expected!.data, `${axis} ${JSON.stringify(word)} diverged synchronously`)
        assert.equal(sync.body, expected!.body, `${axis} ${JSON.stringify(word)} diverged synchronously (body)`)

        const async = await parseFrontmatterAsync(source)
        assert.deepStrictEqual(async.data, expected!.data, `${axis} ${JSON.stringify(word)} diverged asynchronously`)
        assert.equal(async.body, expected!.body, `${axis} ${JSON.stringify(word)} diverged asynchronously (body)`)
      }
    })
  })
}
