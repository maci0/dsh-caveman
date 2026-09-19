/**
 * Deterministic gate for the frontmatter fast path: a flat block must not load
 * `yaml`.
 *
 * The counter is the module registry, not a clock: after `yaml` has been
 * loaded — statically, by `require`, or by a dynamic `import()` — its files are
 * in `require.cache` (Node routes an ESM import of a CommonJS package through
 * the CommonJS loader). Counting them is load-independent, so the gate holds on
 * a busy machine, and it fails on the pre-fast-path reader, which imported
 * `yaml` at module scope.
 *
 * The last assertion is the self-check: it proves the counter can move, so the
 * three zero assertions before it cannot pass vacuously.
 *
 * @module dsh-caveman/tests/frontmatter-fast
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseFrontmatter, parseFrontmatterAsync } from '../src/frontmatter.ts'
import { discoverSkills } from '../src/skills.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(packageRoot, 'skills')
const require = createRequire(import.meta.url)

/** Count the `yaml` package files the process has loaded so far. */
function yamlModules(): number {
  return Object.keys(require.cache).filter((path) => /node_modules[/\\]yaml[/\\]/.test(path)).length
}

const FLAT = '---\nname: probe\ndescription: >\n  One line.\n  Another line.\n---\nbody\n'

test('a flat frontmatter block never loads yaml', async () => {
  assert.equal(yamlModules(), 0, 'yaml was already loaded before the first parse')

  parseFrontmatter(FLAT)
  await parseFrontmatterAsync(FLAT)
  assert.equal(yamlModules(), 0, 'a flat block went through the yaml fallback')

  const skills = await discoverSkills(skillsDir)
  assert.equal(skills.length, 14, 'every bundled SKILL.md takes the fast path')
  assert.equal(skills[0]?.name, 'cavecrew')

  const nested = await parseFrontmatterAsync('---\nname: x\nmetadata:\n  owner: me\n---\nbody\n')
  assert.deepEqual(nested.data['metadata'], { owner: 'me' })
  assert.ok(yamlModules() > 0, 'the counter must move when the fallback runs')
})

test('a bundled SKILL.md parses through the synchronous entry point too', async () => {
  const source = await readFile(join(skillsDir, 'caveman', 'SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(source)
  assert.equal(parsed.data['name'], 'caveman')
  assert.match(parsed.body, /## Intensity/)
})
