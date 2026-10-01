/**
 * Deterministic gate for the frontmatter fast path: a flat block must not load
 * `yaml`.
 *
 * The counter is the module registry, not a clock, and it runs in a child
 * process (`tests/yaml-probe.ts`): `bun test` shares one process across files,
 * so another file's `yaml` import would otherwise decide the result. It fails
 * on the pre-fast-path reader, which imported `yaml` at module scope.
 *
 * The last assertion is the self-check: it proves the counter can move, so the
 * three zero assertions before it cannot pass vacuously.
 *
 * @module dsh-caveman/tests/frontmatter-fast
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parseFrontmatter } from '../src/frontmatter.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(packageRoot, 'skills')
const run = promisify(execFile)

test('a flat frontmatter block never loads yaml', async () => {
  const { stdout } = await run(process.execPath, [join(packageRoot, 'tests', 'yaml-probe.ts')], {
    cwd: packageRoot,
    timeout: 60_000,
  })
  const probe = JSON.parse(stdout) as {
    atStart: number
    afterFlat: number
    afterSkills: number
    skills: number
    firstSkill: string | undefined
    nested: unknown
    afterNested: number
  }

  assert.equal(probe.atStart, 0, 'yaml was already loaded before the first parse')
  assert.equal(probe.afterFlat, 0, 'a flat block went through the yaml fallback')
  assert.equal(probe.skills, 14, 'the probe read every bundled SKILL.md')
  assert.equal(probe.afterSkills, 0, 'every bundled SKILL.md takes the fast path')
  assert.equal(probe.firstSkill, 'cavecrew')
  assert.deepEqual(probe.nested, { owner: 'me' })
  assert.ok(probe.afterNested > 0, 'the counter must move when the fallback runs')
})

test('a bundled SKILL.md parses through the synchronous entry point too', async () => {
  const source = await readFile(join(skillsDir, 'caveman', 'SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(source)
  assert.equal(parsed.data['name'], 'caveman')
  assert.match(parsed.body, /## Intensity/)
})
