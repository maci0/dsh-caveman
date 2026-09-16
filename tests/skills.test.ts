import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { createSkillProvider, discoverSkills, BUNDLED_SKILL_RANK } from '../src/skills.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(packageRoot, 'skills')

test('parseFrontmatter folds block descriptions and keeps the body', () => {
  const parsed = parseFrontmatter(
    [
      '---',
      'name: caveman',
      'description: >',
      '  First line of the description',
      '  continues on the next line.',
      'argument-hint: "[lite|full|ultra]"',
      'license: MIT',
      '---',
      '',
      '# Caveman',
      '',
      'Body text.',
    ].join('\n'),
  )

  assert.equal(parsed.data['name'], 'caveman')
  assert.equal(parsed.data['description'], 'First line of the description continues on the next line.')
  assert.equal(parsed.data['argument-hint'], '[lite|full|ultra]')
  assert.equal(parsed.data['license'], 'MIT')
  assert.equal(parsed.body, '\n# Caveman\n\nBody text.')
})

test('parseFrontmatter reads quoted scalars and leaves a bodyless file alone', () => {
  const quoted = parseFrontmatter('---\nname: "x"\ndescription: \'y\'\n---\nb\n')
  assert.equal(quoted.data['name'], 'x')
  assert.equal(quoted.data['description'], 'y')

  const none = parseFrontmatter('# just markdown\n')
  assert.deepEqual(none.data, {})
  assert.equal(none.body, '# just markdown\n')
})

test('parseFrontmatter refuses a block scalar it does not read', () => {
  assert.throws(
    () => parseFrontmatter('---\nname: x\ndescription: |\n  one\n  two\n---\nbody\n'),
    /unsupported block scalar indicator "\|"/,
  )
  assert.throws(
    () => parseFrontmatter('---\nname: x\ndescription: >-\n  one\n---\nbody\n'),
    /unsupported block scalar indicator ">-"/,
  )
})

test('discoverSkills skips a file the reader refuses and keeps the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caveman-skills-'))
  try {
    await mkdir(join(root, 'broken'), { recursive: true })
    await writeFile(join(root, 'broken', 'SKILL.md'), '---\nname: broken\ndescription: |\n  literal\n---\nbody\n')
    await mkdir(join(root, 'fine'), { recursive: true })
    await writeFile(join(root, 'fine', 'SKILL.md'), '---\nname: fine\ndescription: >\n  A usable description.\n---\nbody\n')

    const warnings: string[] = []
    const skills = await discoverSkills(root, (message) => warnings.push(message))

    assert.deepEqual(skills.map((skill) => skill.name), ['fine'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /unsupported block scalar indicator/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discoverSkills reads every bundled skill with a usable description', async () => {
  const skills = await discoverSkills(skillsDir)

  assert.deepEqual(
    skills.map((skill) => skill.name),
    [
      'cavecrew',
      'caveman',
      'caveman-commit',
      'caveman-compress',
      'caveman-explore',
      'caveman-help',
      'caveman-review',
      'caveman-stats',
      'investigate-first',
      'lean-build',
      'migration',
      'safe-refactor',
      'surgical-patch',
      'verify-and-stop',
    ],
  )
  for (const skill of skills) {
    assert.ok(skill.description.length > 20, `${skill.name} has a description`)
    assert.doesNotMatch(skill.content, /^---/, `${skill.name} body has no frontmatter`)
    assert.equal(skill.metadata['license'] ?? 'MIT', 'MIT')
  }

  const core = skills.find((skill) => skill.name === 'caveman')
  assert.ok(core)
  assert.match(core.content, /## Intensity/)
  assert.match(core.content, /wenyan-full/)
})

test('bundled resource files travel beside their skills', async () => {
  const { existsSync } = await import('node:fs')
  for (const role of ['investigator', 'builder', 'reviewer']) {
    assert.ok(
      existsSync(join(skillsDir, 'cavecrew', `cavecrew-${role}.md`)),
      `cavecrew-${role}.md ships beside the cavecrew skill`,
    )
  }
  for (const script of ['__main__', 'cli', 'compress', 'detect', 'validate']) {
    assert.ok(
      existsSync(join(skillsDir, 'caveman-compress', 'scripts', `${script}.py`)),
      `${script}.py ships beside the caveman-compress skill`,
    )
  }
})

test('discoverSkills reports and skips an unreadable directory', async () => {
  const warnings: string[] = []
  const skills = await discoverSkills(join(packageRoot, 'does-not-exist'), (message) => warnings.push(message))

  assert.deepEqual(skills, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /cannot read skills directory/)
})

test('the provider lists candidates and loads their bodies', async () => {
  const provider = createSkillProvider({ skillsDir })
  const candidates = await provider.list()

  assert.equal(provider.name, 'caveman')
  assert.equal(candidates.length, 14)
  for (const candidate of candidates) {
    assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.provider, 'caveman')
    assert.equal(candidate.invocation.modelInvocable, true)
    assert.equal(candidate.invocation.userInvocable, true)
    assert.equal(candidate.resourceBase?.kind, 'directory')
  }

  const review = candidates.find((candidate) => candidate.name === 'caveman-review')
  assert.ok(review)
  const definition = await provider.get(review)
  assert.ok(definition)
  assert.equal(definition.name, 'caveman-review')
  assert.match(definition.content, /One line per finding/)
  assert.doesNotMatch(definition.content, /^---/)

  const missing = await provider.get({ ...review, locator: join(skillsDir, 'nope', 'SKILL.md') })
  assert.equal(missing, undefined)
})
