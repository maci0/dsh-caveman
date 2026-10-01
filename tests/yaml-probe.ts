/**
 * Child-process probe for the frontmatter fast path, run by
 * `frontmatter-fast.test.ts` with the test runner's own executable. It needs a
 * process of its own: the counter is the module registry, and `bun test`
 * shares one process across test files, some of which load `yaml`.
 *
 * `yaml` resolves to its CommonJS build, so every file it loads (statically,
 * by `require`, or by a dynamic `import()`) lands in `require.cache`. Counting
 * them is load-independent, so the gate holds on a busy machine.
 *
 * Prints `{ atStart, afterFlat, afterSkills, skills, firstSkill, nested,
 * afterNested }` as JSON on stdout.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, parseFrontmatterAsync } from '../src/frontmatter.ts'
import { discoverSkills } from '../src/skills.ts'

const require = createRequire(import.meta.url)
const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

/** Count the `yaml` package files this process has loaded so far. */
function yamlModules(): number {
  return Object.keys(require.cache).filter((path) => /node_modules[/\\]yaml[/\\]/.test(path)).length
}

const FLAT = '---\nname: probe\ndescription: >\n  One line.\n  Another line.\n---\nbody\n'

const atStart = yamlModules()
parseFrontmatter(FLAT)
await parseFrontmatterAsync(FLAT)
const afterFlat = yamlModules()
const skills = await discoverSkills(skillsDir)
const afterSkills = yamlModules()
const nested = await parseFrontmatterAsync('---\nname: x\nmetadata:\n  owner: me\n---\nbody\n')
console.log(JSON.stringify({
  atStart,
  afterFlat,
  afterSkills,
  skills: skills.length,
  firstSkill: skills[0]?.name,
  nested: nested.data['metadata'],
  afterNested: yamlModules(),
}))
