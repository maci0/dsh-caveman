import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { createSkillProvider, discoverSkills } from '../src/skills.ts'

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
  // YAML clip chomping keeps the final line break of a folded scalar; the
  // skill reader trims every projected string before it reaches a summary.
  assert.equal(parsed.data['description'], 'First line of the description continues on the next line.\n')
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

test('parseFrontmatter reads literal and chomped block scalars and nested maps', () => {
  const parsed = parseFrontmatter(
    [
      '---',
      'name: nested',
      'description: |-',
      '  one',
      '  two',
      'whenToUse: >-',
      '  Use when the task needs a nested map.',
      'metadata:',
      '  owner: caveman',
      '  flags:',
      '    - a',
      '    - b',
      'disable-model-invocation: true',
      'user-invocable: false',
      '---',
      'body',
    ].join('\n'),
  )

  assert.equal(parsed.data['description'], 'one\ntwo')
  assert.equal(parsed.data['whenToUse'], 'Use when the task needs a nested map.')
  assert.deepEqual(parsed.data['metadata'], { owner: 'caveman', flags: ['a', 'b'] })
  assert.equal(parsed.data['disable-model-invocation'], true)
  assert.equal(parsed.data['user-invocable'], false)
  assert.equal(parsed.body, 'body')
})

test('parseFrontmatter tolerates a missing or non-mapping block and lets YAML errors escape', () => {
  const bare = parseFrontmatter('---\nnot a mapping\n---\nbody\n')
  assert.deepEqual(bare.data, {})
  assert.equal(bare.body, 'body\n')

  const unclosed = parseFrontmatter('---\nname: x\nbody\n')
  assert.deepEqual(unclosed.data, {})
  assert.equal(unclosed.body, '---\nname: x\nbody\n')

  assert.throws(() => parseFrontmatter('---\nname: x\ndescription: "unterminated\n---\nbody\n'))
})

test('discoverSkills skips a file the reader refuses and keeps the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caveman-skills-'))
  try {
    await mkdir(join(root, 'broken'), { recursive: true })
    // Malformed YAML: the reader throws, discovery warns and keeps going.
    await writeFile(join(root, 'broken', 'SKILL.md'), '---\nname: broken\ndescription: "unterminated\n---\nbody\n')
    await mkdir(join(root, 'fine'), { recursive: true })
    await writeFile(join(root, 'fine', 'SKILL.md'), '---\nname: fine\ndescription: >\n  A usable description.\n---\nbody\n')

    const warnings: string[] = []
    const skills = await discoverSkills(root, (message) => warnings.push(message))

    assert.deepEqual(skills.map((skill) => skill.name), ['fine'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /skipping .*broken/)
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

  const stale = await provider.get({ ...review, name: 'other-skill' })
  assert.equal(stale, undefined)
})

/** Write one skill directory and return its root. */
async function writeSkill(frontmatter: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'caveman-invocation-'))
  await mkdir(join(root, 'probe'), { recursive: true })
  await writeFile(join(root, 'probe', 'SKILL.md'), ['---', ...frontmatter, '---', 'body'].join('\n'))
  return root
}

test('the provider projects the two canonical invocation keys and whenToUse', async () => {
  const root = await writeSkill([
    'name: probe',
    'description: A probe skill.',
    'whenToUse: Use when probing the invocation policy.',
    'disable-model-invocation: true',
    'user-invocable: false',
    'license: MIT',
  ])
  try {
    const provider = createSkillProvider({ skillsDir: root })
    const candidates = await provider.list()
    assert.equal(candidates.length, 1)

    const probe = candidates[0]
    assert.ok(probe)
    assert.deepEqual(probe.invocation, { modelInvocable: false, userInvocable: false })
    assert.equal(probe.whenToUse, 'Use when probing the invocation policy.')
    // Only provider-specific keys survive; the projected ones are not repeated.
    assert.deepEqual(probe.metadata, { license: 'MIT' })

    // The body keeps the same policy and guidance.
    const definition = await provider.get(probe)
    assert.ok(definition)
    assert.deepEqual(definition.invocation, { modelInvocable: false, userInvocable: false })
    assert.equal(definition.whenToUse, 'Use when probing the invocation policy.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('omitted invocation keys default to model- and user-invocable', async () => {
  const root = await writeSkill(['name: probe', 'description: A probe skill.'])
  try {
    const candidates = await createSkillProvider({ skillsDir: root }).list()
    assert.deepEqual(candidates[0]?.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(candidates[0]?.whenToUse, undefined)
    assert.deepEqual(candidates[0]?.metadata, {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the provider settles promptly when the lookup signal is aborted', async () => {
  const provider = createSkillProvider({ skillsDir })
  const aborted = AbortSignal.abort()

  await assert.rejects(() => provider.list({ signal: aborted }), /aborted/i)

  const candidates = await provider.list()
  const first = candidates[0]
  assert.ok(first)
  await assert.rejects(() => provider.get(first, { signal: aborted }), /aborted/i)
})
