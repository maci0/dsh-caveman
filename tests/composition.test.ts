import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as Caveman from '../src/index.ts'

/**
 * The real-composition entry test the testing policy asks for: the plugin is
 * mounted into a real Cordis `Context` together with the real `ctx.skills`
 * registry, so provider registration, candidate validation, and teardown run
 * against the host's own implementations instead of the structural fake in
 * `tests/plugin.test.ts`.
 */
test('the plugin mounts into a real Cordis composition and unloads cleanly', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)

  // The plugin declares the structural subset of the host context it uses — as
  // an out-of-tree plugin must — so its `apply` signature is narrower than
  // Cordis's `Context`. The real context satisfies it at runtime.
  const fiber = await ctx.plugin(Caveman as unknown as Parameters<typeof ctx.plugin>[0], { defaultMode: 'full' })

  const summaries = await ctx.skills.list()
  assert.equal(summaries.length, 14)
  assert.deepEqual(
    summaries.map((summary) => summary.name),
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
  for (const summary of summaries) {
    assert.equal(summary.provider, 'caveman')
    assert.equal(summary.source, 'bundled')
    assert.deepEqual(summary.invocation, { modelInvocable: true, userInvocable: true })
  }

  // A body loads through the real registry, which validates the definition.
  const loaded = await ctx.skills.get('caveman-review')
  assert.ok(loaded)
  assert.match(loaded.content, /One line per finding/)
  assert.equal(loaded.provider, 'caveman')

  // HMR safety: disposing the contributing fiber empties the catalog.
  await fiber.dispose()
  assert.deepEqual(await ctx.skills.list(), [])
})

/**
 * The same composition, minus the projections registry.
 *
 * Cordis throws when a context reads an undeclared service as a property, so a
 * structural fake cannot tell the two spellings apart: on a real context,
 * `scope.sessionProjections` fails where `scope.get('sessionProjections')`
 * returns `undefined`. The usage report has to degrade, not break the call.
 */
test('the usage report degrades on a composition without the projections registry', async () => {
  const ctx = new Context()
  const registered: { definition: { execute(args: unknown, exec: unknown): Promise<unknown> } }[] = []
  ctx.provide('tools', {
    register: (definition: { execute(args: unknown, exec: unknown): Promise<unknown> }) => {
      registered.push({ definition })
      return () => {}
    },
  })

  await ctx.plugin(Caveman as unknown as Parameters<typeof ctx.plugin>[0], { defaultMode: 'full' })
  const tool = registered[0]?.definition
  assert.ok(tool, 'the plugin registered its mode tool')

  const reported = await tool.execute({ usage: true }, { agent: { session: { id: 'session-1' } } })
  assert.equal((reported as { mode?: unknown }).mode, 'full')
  assert.equal((reported as { usage?: unknown }).usage, undefined, 'no registry, no usage field')
})
