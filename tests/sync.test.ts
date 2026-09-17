import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(packageRoot, 'sync.manifest.json')
const scriptPath = join(packageRoot, 'scripts', 'sync-upstream.mjs')

function loadManifest(): { verbatim: string[]; patched: string[] } {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

test('every manifest file exists locally with a matching upstream path', () => {
  const manifest = loadManifest()
  const all = [...manifest.verbatim, ...manifest.patched]
  assert.ok(all.length > 0, 'manifest lists files')

  const seen = new Set<string>()
  for (const file of all) {
    assert.ok(!seen.has(file), `${file} listed twice`)
    seen.add(file)
    assert.ok(!file.startsWith('/'), `${file} is repo-relative`)
    assert.ok(existsSync(join(packageRoot, file)), `${file} exists locally`)
  }
})

test('verbatim files carry no DSH edits (still byte-shaped like upstream)', () => {
  // The sync tool owns byte-identity against the network; this guards the
  // cheaper local invariant: verbatim files must not reference DSH concepts
  // that only the two patched files may mention.
  const manifest = loadManifest()
  for (const file of manifest.verbatim) {
    const body = readFileSync(join(packageRoot, file), 'utf8')
    assert.doesNotMatch(body, /dsh-caveman/i, `${file} has no DSH branding`)
    assert.doesNotMatch(body, /DeepSeek Harness/, `${file} has no harness references`)
  }
})

test('patched files document their divergence', () => {
  // A patched file must say why it differs, so the next sync can re-apply it.
  const manifest = loadManifest()
  assert.deepEqual([...manifest.patched].sort(), [
    'skills/cavecrew/SKILL.md',
    'skills/caveman-compress/SKILL.md',
    'skills/caveman-help/SKILL.md',
    'skills/caveman-stats/SKILL.md',
    'skills/caveman/SKILL.md',
  ])
  for (const file of manifest.patched) {
    const body = readFileSync(join(packageRoot, file), 'utf8')
    assert.ok(body.length > 0, `${file} is non-empty`)
  }
  const core = readFileSync(join(packageRoot, 'skills/caveman/SKILL.md'), 'utf8')
  assert.match(core, /Reason concisely/, 'caveman states its thinking-line adaptation')
  const compress = readFileSync(join(packageRoot, 'skills/caveman-compress/SKILL.md'), 'utf8')
  assert.match(compress, /caveman-compress.*tool/, 'compress states its TS-pipeline adaptation')
  const cavecrew = readFileSync(join(packageRoot, 'skills/cavecrew/SKILL.md'), 'utf8')
  assert.match(cavecrew, /no named-agent registry/, 'cavecrew states its DSH adaptation')
  const stats = readFileSync(join(packageRoot, 'skills/caveman-stats/SKILL.md'), 'utf8')
  assert.match(stats, /tokenUsage/, 'stats states its DSH adaptation')
  const help = readFileSync(join(packageRoot, 'skills/caveman-help/SKILL.md'), 'utf8')
  assert.match(help, /profile row > env var/, 'help states the true default priority')
})

test('sync check reports the five known patched drifts and nothing else', () => {
  // Network-dependent: upstream main must be reachable. Asserts the exact
  // steady state — 12 verbatim clean, 5 patched stale — so a newly drifted
  // verbatim file fails loudly instead of rotting.
  let out: string
  try {
    execFileSync('node', [scriptPath, 'check'], { cwd: packageRoot })
    assert.fail('check should exit non-zero while patched files drift')
  } catch (error) {
    const result = error as { status?: number; stdout?: Buffer }
    assert.equal(result.status, 1)
    out = (result.stdout ?? Buffer.of()).toString()
  }
  assert.match(out, /stale \[patched\]: skills\/caveman\/SKILL\.md/)
  assert.match(out, /stale \[patched\]: skills\/caveman-compress\/SKILL\.md/)
  assert.match(out, /stale \[patched\]: skills\/caveman-help\/SKILL\.md/)
  assert.match(out, /stale \[patched\]: skills\/cavecrew\/SKILL\.md/)
  assert.match(out, /stale \[patched\]: skills\/caveman-stats\/SKILL\.md/)
  assert.doesNotMatch(out, /\[verbatim\]/, 'no verbatim file drifted')
})
