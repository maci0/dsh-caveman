import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, readUpstreamConfigFile } from '../src/index.ts'
import type { Config as ConfigType } from '../src/index.ts'
import { MAX_FILE_SIZE } from '../src/compress-files.ts'
import type {
  CommandDefinitionLike,
  HostContext,
  PromptSectionContribution,
  SessionEventLike,
  SkillProviderLike,
} from '../src/host.ts'
import type { CavemanMode } from '../src/modes.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

// Backups land under `XDG_DATA_HOME`; point it at a directory this suite owns so
// a compression test never writes outside the test's own tree.
const backupHome = mkdtempSync(join(tmpdir(), 'caveman-xdg-'))
process.env['XDG_DATA_HOME'] = backupHome
after(() => rmSync(backupHome, { recursive: true, force: true }))

const CAVEMAN_SETTINGS_NAMESPACE = 'caveman'

interface Captured {
  readonly sections: PromptSectionContribution[]
  readonly providers: SkillProviderLike[]
  readonly tools: ToolDefinition[]
  readonly commands: CommandDefinitionLike[]
  readonly updates: { namespace: string; patch: Record<string, unknown> }[]
}

/** A host that records registrations and emulates the settings document. */
function createHost(options: { failUpdate?: boolean } = {}): {
  ctx: HostContext
  captured: Captured
  config: ConfigType
  setDefaultMode: (mode: CavemanMode | undefined) => void
  setMaxFileSize: (bytes: number) => void
  emit: (event: SessionEventLike) => void
  emitVolatile: () => void
} {
  const captured: Captured = {
    sections: [], providers: [], tools: [], commands: [], updates: [],
  }
  // The live row value. `Volatile<T>` is structurally `{ get(): T }`, so the
  // double below satisfies the exported interface with no cast, and a test can
  // move the row the way a committed settings write does.
  let row: CavemanMode | undefined = 'full'
  // The size cap is a live field too: a card write moves this value and the next
  // compress call reads it.
  let cap: number = MAX_FILE_SIZE
  const config: ConfigType = {
    defaultMode: { get: () => row },
    maxFileSize: { get: () => cap },
  }
  const volatileListeners: Array<() => void> = []

  const services = {
    systemPrompt: {
      section: (section: PromptSectionContribution): (() => void) => {
        captured.sections.push(section)
        return () => {}
      },
    },
    skills: {
      registerProvider: (create: () => SkillProviderLike): (() => void) => {
        captured.providers.push(create())
        return () => {}
      },
    },
    tools: {
      register: (tool: ToolDefinition): (() => void) => {
        captured.tools.push(tool)
        return () => {}
      },
    },
    commands: {
      register: (command: CommandDefinitionLike): (() => void) => {
        captured.commands.push(command)
        return () => {}
      },
    },
    settings: {
      update: async (namespace: string, patch: Record<string, unknown>): Promise<void> => {
        if (options.failUpdate === true) throw new Error('settings document is read-only')
        captured.updates.push({ namespace, patch })
        if (typeof patch['defaultMode'] === 'string') row = patch['defaultMode'] as CavemanMode
      },
    },
  }

  const listeners: Array<(session: unknown, event: SessionEventLike) => void> = []

  const ctx = {
    ...services,
    fiber: { entry: { options: { id: CAVEMAN_SETTINGS_NAMESPACE } } },
    // The optional seams are served the way a Cordis context serves them:
    // through the accessor, which is also the shape `apply` has to use.
    get: (name: string): unknown => name === 'settings'
      ? services.settings
      : name === 'sessionProjections' ? services.sessionProjections : undefined,
    inject: (_dependencies: readonly string[], callback: (scope: HostContext) => void): void => {
      callback(ctx as unknown as HostContext)
    },
    on: (event: string, listener: (...args: never[]) => void): (() => void) => {
      if (event === 'loader/volatile-update') volatileListeners.push(listener as () => void)
      else listeners.push(listener as (session: unknown, event: SessionEventLike) => void)
      return () => {}
    },
  }
  return {
    ctx: ctx as unknown as HostContext,
    captured,
    config,
    setDefaultMode: (mode: CavemanMode | undefined): void => { row = mode },
    setMaxFileSize: (bytes: number): void => { cap = bytes },
    emit: (event: SessionEventLike): void => { for (const listener of listeners) listener({}, event) },
    emitVolatile: (): void => { for (const listener of volatileListeners) listener() },
  }
}

function sectionText(section: PromptSectionContribution | undefined): string {
  assert.ok(section)
  return typeof section.text === 'function' ? section.text({}) : section.text
}

async function callTool(host: { captured: Captured }, args: unknown, exec?: ToolRunContext): Promise<unknown> {
  const tool = host.captured.tools[0]
  assert.ok(tool)
  // Only the slice the tool bodies read is supplied; the rest of the execution
  // identity (call id, deferral hooks) is the registry's business.
  return tool.execute(args, (exec ?? { agent: undefined }) as ToolRunContext)
}

async function callCompressTool(host: { captured: Captured }, args: unknown, exec?: ToolRunContext): Promise<unknown> {
  const tool = host.captured.tools[1]
  assert.ok(tool)
  assert.equal(tool.name, 'caveman-compress')
  return tool.execute(args, (exec ?? { agent: undefined }) as ToolRunContext)
}

async function callCommand(host: { captured: Captured }, rawInput: string, index = 0) {
  const command = host.captured.commands[index]
  assert.ok(command)
  return command.handler({ rawInput })
}

test('apply mounts the section, provider, tool, command, and settings namespace', async () => {
  const host = createHost()
  apply(host.ctx, host.config)

  assert.equal(host.captured.sections[0]?.name, 'caveman')
  assert.equal(host.captured.sections[0]?.order, 700)
  assert.equal(host.captured.tools[0]?.name, 'caveman')
  assert.equal(host.captured.tools[1]?.name, 'caveman-compress')
  assert.equal(host.captured.commands[0]?.name, 'caveman')
  assert.equal(host.captured.commands[1]?.name, 'caveman-compress')
  assert.equal(host.captured.providers.length, 1)
  assert.equal((await host.captured.providers[0]?.list())?.length, 14)

  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: full\n\n/)
})

test('the tool persists a level through the settings document', async () => {
  const host = createHost()
  apply(host.ctx, host.config)

  assert.deepEqual(await callTool(host, {}), {
    mode: 'full', previous: 'full', changed: false, active: true,
  })

  const switched = await callTool(host, { mode: 'ultra' })
  assert.deepEqual(switched, { mode: 'ultra', previous: 'full', changed: true, active: true })
  assert.deepEqual(host.captured.updates, [{ namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { defaultMode: 'ultra' } }])
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: ultra\n\n/)

  const off = await callTool(host, { mode: 'off' })
  assert.deepEqual(off, { mode: 'off', previous: 'ultra', changed: true, active: false })
  assert.equal(sectionText(host.captured.sections[0]), '')

  // `defineTool` validates the declared enum before `execute` runs, so an
  // unknown level reaches the model as a schema violation.
  await assert.rejects(
    () => callTool(host, { mode: 'shrug' }),
    /invalid arguments: "mode" must be one of \["off","lite","full","ultra","wenyan-lite","wenyan-full","wenyan-ultra"\]/,
  )
})

test('wenyan levels persist like every other level', async () => {
  const host = createHost()
  apply(host.ctx, host.config)

  const wenyan = await callTool(host, { mode: 'wenyan-full' })
  assert.deepEqual(wenyan, { mode: 'wenyan-full', previous: 'full', changed: true, active: true })
  assert.deepEqual(host.captured.updates, [
    { namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { defaultMode: 'wenyan-full' } },
  ])
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: wenyan-full\n\n/)

  // A card write is a committed settings change: the service updates the row
  // in place and signals the commit through `onChange`.
  host.setDefaultMode('lite')
  host.emitVolatile()
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: lite\n\n/)
})

test('a refused settings write still applies the level for this session', async () => {
  const host = createHost({ failUpdate: true })
  apply(host.ctx, host.config)

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (message?: unknown): void => { warnings.push(String(message)) }
  try {
    const applied = await callTool(host, { mode: 'lite' })
    assert.deepEqual(applied, { mode: 'lite', previous: 'full', changed: true, active: true })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /could not persist level "lite": settings document is read-only/)
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: lite\n\n/)
})

test('the command switches and reports through the UI', async () => {
  const host = createHost()
  apply(host.ctx, host.config)

  assert.deepEqual(await callCommand(host, ''), { kind: 'success', text: 'Caveman level: full.' })
  assert.deepEqual(await callCommand(host, ' lite '), {
    kind: 'success', text: 'Caveman level: lite (was full).',
  })
  assert.deepEqual(host.captured.updates, [{ namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { defaultMode: 'lite' } }])

  assert.deepEqual(await callCommand(host, 'normal mode'), {
    kind: 'success', text: 'Caveman off (was lite). Normal behavior.',
  })
  assert.equal(sectionText(host.captured.sections[0]), '')

  assert.deepEqual(await callCommand(host, 'full'), {
    kind: 'success', text: 'Caveman level: full (was off).',
  })

  assert.deepEqual(await callCommand(host, 'wenyan'), {
    kind: 'success', text: 'Caveman level: wenyan-full (was full).',
  })

  const rejected = await callCommand(host, 'turbo')
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.kind === 'error' ? rejected.text : '', /Unknown caveman level "turbo"/)
})

test('the tool renders its canonical value for the model', async () => {
  const host = createHost()
  host.setDefaultMode('lite')
  apply(host.ctx, host.config)
  const tool = host.captured.tools[0]
  assert.ok(tool)

  const value = await tool.execute({ mode: 'full' }, {} as ToolRunContext)
  assert.deepEqual(tool.output.render({ mode: 'full' } as JsonValue, value as JsonValue), [
    { type: 'text', text: 'Caveman level: full (was lite). The ruleset is injected into every request.' },
  ])

  assert.deepEqual(tool.output.render({} as JsonValue, { mode: 'off', previous: 'full', changed: true, active: false } as JsonValue), [
    { type: 'text', text: 'Caveman off (was full). Normal behavior.' },
  ])
})

test('the tool answers a one-shot level without persisting it', async () => {
  const host = createHost()
  apply(host.ctx, host.config)

  assert.deepEqual(await callTool(host, { once: 'ultra' }), {
    mode: 'ultra', previous: 'full', changed: false, active: true, once: 'ultra',
  })
  assert.deepEqual(host.captured.updates, [])
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: full\n\n/)

  const tool = host.captured.tools[0]
  assert.ok(tool)
  assert.deepEqual(tool.output.render({ once: 'ultra' }, {
    mode: 'ultra', previous: 'full', changed: false, active: true, once: 'ultra',
  }), [
    { type: 'text', text: 'Caveman level: ultra. The ruleset is injected into every request. Reply to this call in ultra; the persisted level is unchanged.' },
  ])

  // `mode` wins when both are given; `once` rides along unpersisted.
  assert.deepEqual(await callTool(host, { mode: 'lite', once: 'ultra' }), {
    mode: 'lite', previous: 'full', changed: true, active: true, once: 'ultra',
  })

  // Both invalid shapes are caught by the declared `once` enum (no `off`, and
  // only the six levels).
  await assert.rejects(
    () => callTool(host, { once: 'shrug' }),
    /invalid arguments: "once" must be one of \["lite","full","ultra","wenyan-lite","wenyan-full","wenyan-ultra"\]/,
  )
  await assert.rejects(
    () => callTool(host, { once: 'off' }),
    /invalid arguments: "once" must be one of \["lite","full","ultra","wenyan-lite","wenyan-full","wenyan-ultra"\]/,
  )
})

test('the tool reports session usage only when asked and available', async () => {
  const host = createHost()
  apply(host.ctx, host.config)
  const tool = host.captured.tools[0]
  assert.ok(tool)

  // No projections service: no usage field, even when asked.
  assert.deepEqual(await callTool(host, { usage: true }), {
    mode: 'full', previous: 'full', changed: false, active: true,
  })

  // With a projections service, usage rides the exec's session. The unit's own
  // bucket names are the ones the token-meter projection publishes.
  const session = { id: 's1' }
  const exec = { agent: { session } } as ToolRunContext
  const totals = { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 10 }
  const projectionsHost = createProjectionsHost(totals)
  apply(projectionsHost.ctx, Config({ defaultMode: 'full' }))
  const using = projectionsHost.captured.tools[0]
  assert.ok(using)

  assert.deepEqual(await using.execute({ usage: true }, exec), {
    mode: 'full', previous: 'full', changed: false, active: true,
    usage: { input: 100, output: 40, cacheRead: 500, cacheWrite: 10 },
  })
  // Not asked: no usage field.
  assert.deepEqual(await using.execute({}, exec), {
    mode: 'full', previous: 'full', changed: false, active: true,
  })
  // No exec (no session): no usage field.
  assert.deepEqual(await using.execute({ usage: true }, {} as ToolRunContext), {
    mode: 'full', previous: 'full', changed: false, active: true,
  })

  assert.deepEqual(using.output.render({ usage: true }, {
    mode: 'full', previous: 'full', changed: false, active: true,
    usage: { input: 100, output: 40, cacheRead: 500, cacheWrite: 10 },
  }), [
    { type: 'text', text: 'Caveman level: full. The ruleset is injected into every request. Session usage so far — input 100, output 40, cache read 500, cache write 10. Savings unknown without a measured comparison.' },
  ])
})

/** A host variant whose scope also carries a stub `sessionProjections` service. */
function createProjectionsHost(totals: {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}): {
  ctx: HostContext
  captured: Captured
} {
  const host = createHost()
  const ctx = {
    ...(host.ctx as unknown as Record<string, unknown>),
    inject: (_dependencies: readonly string[], callback: (scope: HostContext) => void): void => {
      const projections = {
        stateOf: (session: unknown, key: string): unknown =>
          key === 'tokenUsage' && (session as { id?: string })?.id === 's1' ? { totals } : undefined,
      }
      const scope = {
        ...(host.ctx as unknown as Record<string, unknown>),
        // A real Cordis context serves an optional service through the accessor
        // only — reading it as a property is what throws there.
        get: (name: string): unknown => name === 'sessionProjections'
          ? projections
          : (host.ctx as unknown as { get(name: string): unknown }).get(name),
      } as unknown as HostContext
      callback(scope)
    },
    on: (host.ctx as unknown as HostContext).on.bind(host.ctx),
  } as unknown as HostContext
  return { ctx, captured: host.captured }
}

test('readUpstreamConfigFile tolerates a missing or broken file', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  assert.equal(readUpstreamConfigFile(join(tmpdir(), 'caveman-no-such-dir', 'config.json')), undefined)

  const root = await mkdtemp(join(tmpdir(), 'caveman-config-'))
  try {
    const missing = join(root, 'missing.json')
    assert.equal(readUpstreamConfigFile(missing), undefined)

    const broken = join(root, 'broken.json')
    await writeFile(broken, '{not json')
    assert.equal(readUpstreamConfigFile(broken), undefined)

    const list = join(root, 'list.json')
    await writeFile(list, '[]')
    assert.equal(readUpstreamConfigFile(list), undefined)

    const good = join(root, 'good.json')
    await writeFile(good, '{ "defaultMode": "ultra" }')
    assert.deepEqual(readUpstreamConfigFile(good), { defaultMode: 'ultra' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apply fails loudly on configuration it cannot honor', () => {
  const host = createHost()
  // The exported schema rejects this while the row loads; `apply` owns the same
  // check for a caller that bypasses the loader.
  const invalid = { defaultMode: { get: (): string => 'review' } } as unknown as ConfigType
  assert.throws(() => apply(host.ctx, invalid), /defaultMode must be one of off, lite, full, ultra, wenyan-lite, wenyan-full, wenyan-ultra/)

  // The size cap is a tunable, not a constant: the schema bounds it for the
  // form, and `apply` owns the same check for a caller that bypasses the loader
  // with a live reference whose value is unusable.
  assert.throws(() => Config({ maxFileSize: 0 }), /maxFileSize/)
  const unusableCap = {
    defaultMode: { get: () => undefined },
    maxFileSize: { get: () => 0 },
  } as unknown as ConfigType
  assert.throws(() => apply(host.ctx, unusableCap), /maxFileSize must be a positive number of bytes/)
  const notANumber = {
    defaultMode: { get: () => undefined },
    maxFileSize: { get: () => Number.NaN },
  } as unknown as ConfigType
  assert.throws(() => apply(host.ctx, notANumber), /maxFileSize must be a positive number of bytes/)
})

test('an absent defaultMode resolves through the documented chain', () => {
  const host = createHost()
  // The row schema declares no default, so the field carries no value and the
  // resolution chain still gets its turn. A schema default would have filled
  // `full` here and silently outranked both remaining sources.
  const row = Config({})
  assert.equal(row.maxFileSize?.get(), 500000)
  assert.equal(row.defaultMode?.get(), undefined)
  // The settings document edits only volatile fields, so both knobs are
  // volatile; a plain field here is the "has no volatile fields" failure the
  // configuration card hits.
  const dict = (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }).dict
  assert.equal(dict['defaultMode']?.meta.volatile, true)
  assert.equal(dict['maxFileSize']?.meta.volatile, true)

  const previous = process.env['CAVEMAN_DEFAULT_MODE']
  process.env['CAVEMAN_DEFAULT_MODE'] = 'wenyan-lite'
  try {
    apply(host.ctx, row)
    assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: wenyan-lite\n\n/)
  } finally {
    if (previous === undefined) delete process.env['CAVEMAN_DEFAULT_MODE']
    else process.env['CAVEMAN_DEFAULT_MODE'] = previous
  }
})

test('an aborted tool call bails out before it persists', async () => {
  const host = createHost()
  apply(host.ctx, host.config)

  await assert.rejects(
    () => callTool(host, { mode: 'ultra' }, { signal: AbortSignal.abort() } as ToolRunContext),
    /abort/i,
  )
  assert.deepEqual(host.captured.updates, [])
  assert.match(sectionText(host.captured.sections[0]), /level: full/)

  await assert.rejects(
    () => callCompressTool(host, { filepath: 'notes.md' }, { signal: AbortSignal.abort() } as ToolRunContext),
    /abort/i,
  )
})

test('the configured maxFileSize caps the compress tool', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const host = createHost()
  apply(host.ctx, Config({ defaultMode: 'full', maxFileSize: 20 }))

  const root = await mkdtemp(join(tmpdir(), 'caveman-maxsize-'))
  try {
    const target = join(root, 'notes.md')
    await writeFile(target, '# Notes\n\nYou should always make sure to run the tests before you push anything.\n')
    const outcome = await callCompressTool(host, { filepath: target }) as Record<string, unknown>
    assert.equal(outcome['ok'], false)
    assert.match(String(outcome['reason']), /File too large to compress safely \(max 20 bytes\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Let the fire-and-forget settings write settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** One durable user message event carrying `text`. */
function userEvent(text: string, kind = 'user'): SessionEventLike {
  return { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } }
}

test('a "stop caveman" message turns the level off before the turn assembles', async () => {
  const host = createHost()
  apply(host.ctx, host.config)
  assert.match(sectionText(host.captured.sections[0]), /level: full/)

  host.emit(userEvent('stop caveman'))

  // Synchronous: the turn that carried the command already assembles without
  // the ruleset, which is the whole point of watching the durable message.
  assert.equal(sectionText(host.captured.sections[0]), '')

  await settle()
  assert.deepEqual(host.captured.updates, [
    { namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { defaultMode: 'off' } },
  ])
  // The committed document, not the session-local override, now says off.
  assert.equal(sectionText(host.captured.sections[0]), '')
})

test('"normal mode" works the same way', async () => {
  const host = createHost()
  apply(host.ctx, Config({ defaultMode: 'ultra' }))

  host.emit(userEvent('  Normal Mode! '))
  assert.equal(sectionText(host.captured.sections[0]), '')

  await settle()
  assert.deepEqual(host.captured.updates, [
    { namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { defaultMode: 'off' } },
  ])
})

test('only the human\'s own words may deactivate', async () => {
  const host = createHost()
  apply(host.ctx, host.config)

  // Injected context rides the same event stream: a skill body or reference
  // that happens to read "normal mode" must not toggle the level.
  host.emit(userEvent('normal mode', 'skill-invocation'))
  // A message that merely mentions the phrase is not the command.
  host.emit(userEvent('add a normal mode toggle'))
  host.emit({ type: 'assistant/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'stop caveman' }] } })
  host.emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image' }] } })

  await settle()
  assert.deepEqual(host.captured.updates, [])
  assert.match(sectionText(host.captured.sections[0]), /level: full/)
})

test('an already-off level is not written again', async () => {
  const host = createHost()
  apply(host.ctx, Config({ defaultMode: 'off' }))

  host.emit(userEvent('stop caveman'))
  await settle()

  assert.deepEqual(host.captured.updates, [])
})

test('compress tool and command run the pipeline', async () => {
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const host = createHost()
  apply(host.ctx, host.config)

  // Skill always listed; tool and command run without any gate.
  const names = (await host.captured.providers[0]?.list())?.map((skill) => skill.name) ?? []
  assert.ok(names.includes('caveman-compress'))

  const root = await mkdtemp(join(tmpdir(), 'caveman-compress-test-'))
  try {
    const target = join(root, 'notes.md')
    await writeFile(target, '# Notes\n\nYou should always make sure to run the tests before you push anything.\n')
    const outcome = await callCompressTool(host, { filepath: target }) as Record<string, unknown>
    assert.equal(outcome['ok'], true)
    assert.match(String(await readFile(target, 'utf8')), /run tests before/)
    assert.deepEqual(await callCommand(host, target, 1), {
      kind: 'error',
      text: `Backup already exists: ${outcome['backupPath']}. Remove or rename it to proceed.`,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  await assert.rejects(() => callCompressTool(host, {}), /invalid arguments: missing required property "filepath"/)
  await assert.rejects(() => callCompressTool(host, { filepath: '' }), /needs a filepath string/)
  assert.deepEqual(await callCommand(host, '', 1), {
    kind: 'error', text: 'Usage: /caveman-compress <filepath>',
  })
})
