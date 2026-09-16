import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, CAVEMAN_SETTINGS_NAMESPACE, readUpstreamConfigFile } from '../src/index.ts'
import type {
  CommandDefinitionLike,
  HostContext,
  PromptSectionContribution,
  SessionEventLike,
  SettingsSectionHooksLike,
  SkillProviderLike,
  ToolDefinitionLike,
  ToolExecLike,
} from '../src/host.ts'

interface InstallRecord {
  readonly namespace: string
  readonly schema: unknown
  readonly entry: unknown
  readonly hooks: SettingsSectionHooksLike
}

interface Captured {
  readonly sections: PromptSectionContribution[]
  readonly providers: SkillProviderLike[]
  readonly tools: ToolDefinitionLike[]
  readonly commands: CommandDefinitionLike[]
  readonly installs: InstallRecord[]
  readonly updates: { namespace: string; patch: Record<string, unknown> }[]
}

/** A host that records registrations and emulates the settings document. */
function createHost(options: { failUpdate?: boolean } = {}): {
  ctx: HostContext
  captured: Captured
  emit: (event: SessionEventLike) => void
} {
  const captured: Captured = {
    sections: [], providers: [], tools: [], commands: [], installs: [], updates: [],
  }
  let base: Record<string, unknown> = {}
  let user: Record<string, unknown> = {}

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
      register: (tool: ToolDefinitionLike): (() => void) => {
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
      installSection: (
        _owner: unknown,
        namespace: string,
        schema: unknown,
        entry: unknown,
        hooks: SettingsSectionHooksLike,
      ): void => {
        base = entry as Record<string, unknown>
        captured.installs.push({ namespace, schema, entry, hooks })
        // The real service hands over a thunk reading the resolved layers.
        hooks.setSource(() => ({ ...base, ...user }))
        hooks.onChange()
      },
      update: async (namespace: string, patch: Record<string, unknown>): Promise<void> => {
        if (options.failUpdate === true) throw new Error('settings document is read-only')
        captured.updates.push({ namespace, patch })
        user = { ...user, ...patch }
      },
    },
  }

  const listeners: Array<(session: unknown, event: SessionEventLike) => void> = []

  const ctx = {
    ...services,
    inject: (_dependencies: readonly string[], callback: (scope: HostContext) => void): void => {
      callback(ctx as unknown as HostContext)
    },
    on: (_event: string, listener: (session: unknown, event: SessionEventLike) => void): (() => void) => {
      listeners.push(listener)
      return () => {}
    },
  }
  return {
    ctx: ctx as unknown as HostContext,
    captured,
    emit: (event: SessionEventLike): void => { for (const listener of listeners) listener({}, event) },
  }
}

function sectionText(section: PromptSectionContribution | undefined): string {
  assert.ok(section)
  return typeof section.text === 'function' ? section.text({}) : section.text
}

async function callTool(host: { captured: Captured }, args: unknown, exec?: ToolExecLike): Promise<unknown> {
  const tool = host.captured.tools[0]
  assert.ok(tool)
  return tool.execute(args, exec)
}

async function callCompressTool(host: { captured: Captured }, args: unknown): Promise<unknown> {
  const tool = host.captured.tools[1]
  assert.ok(tool)
  assert.equal(tool.name, 'caveman-compress')
  return tool.execute(args)
}

async function callCommand(host: { captured: Captured }, rawInput: string, index = 0) {
  const command = host.captured.commands[index]
  assert.ok(command)
  return command.handler({ rawInput })
}

test('apply mounts the section, provider, tool, command, and settings namespace', async () => {
  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })

  assert.equal(host.captured.sections[0]?.name, 'caveman')
  assert.equal(host.captured.sections[0]?.order, 700)
  assert.equal(host.captured.tools[0]?.name, 'caveman')
  assert.equal(host.captured.tools[1]?.name, 'caveman-compress')
  assert.equal(host.captured.commands[0]?.name, 'caveman')
  assert.equal(host.captured.commands[1]?.name, 'caveman-compress')
  assert.equal(host.captured.providers.length, 1)
  assert.equal((await host.captured.providers[0]?.list())?.length, 14)

  const install = host.captured.installs[0]
  assert.ok(install)
  assert.equal(install.namespace, CAVEMAN_SETTINGS_NAMESPACE)
  assert.deepEqual(install.entry, { mode: 'full', compressBackupDir: '' })
  // The settings service serializes `schema.toJSON()` for the browser half, so
  // the namespace must carry a real schemastery schema.
  assert.equal(typeof (install.schema as { toJSON?: unknown }).toJSON, 'function')

  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: full\n\n/)
})

test('the tool persists a level through the settings document', async () => {
  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })

  assert.deepEqual(await callTool(host, {}), {
    mode: 'full', previous: 'full', changed: false, active: true,
  })

  const switched = await callTool(host, { mode: 'ultra' })
  assert.deepEqual(switched, { mode: 'ultra', previous: 'full', changed: true, active: true })
  assert.deepEqual(host.captured.updates, [{ namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { mode: 'ultra' } }])
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: ultra\n\n/)

  const off = await callTool(host, { mode: 'off' })
  assert.deepEqual(off, { mode: 'off', previous: 'ultra', changed: true, active: false })
  assert.equal(sectionText(host.captured.sections[0]), '')

  await assert.rejects(() => callTool(host, { mode: 'shrug' }), /Unknown caveman level/)
})

test('wenyan levels persist like every other level', async () => {
  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })

  const wenyan = await callTool(host, { mode: 'wenyan-full' })
  assert.deepEqual(wenyan, { mode: 'wenyan-full', previous: 'full', changed: true, active: true })
  assert.deepEqual(host.captured.updates, [
    { namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { mode: 'wenyan-full' } },
  ])
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: wenyan-full\n\n/)

  // A card write is a committed settings change: the service leaves the source
  // thunk alone and signals the commit through `onChange`.
  host.captured.installs[0]?.hooks.setSource(() => ({ mode: 'lite' }))
  host.captured.installs[0]?.hooks.onChange()
  assert.match(sectionText(host.captured.sections[0]), /^CAVEMAN MODE ACTIVE — level: lite\n\n/)
})

test('a refused settings write still applies the level for this session', async () => {
  const host = createHost({ failUpdate: true })
  apply(host.ctx, { defaultMode: 'full' })

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
  apply(host.ctx, { defaultMode: 'full' })

  assert.deepEqual(await callCommand(host, ''), { kind: 'success', text: 'Caveman level: full.' })
  assert.deepEqual(await callCommand(host, ' lite '), {
    kind: 'success', text: 'Caveman level: lite (was full).',
  })
  assert.deepEqual(host.captured.updates, [{ namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { mode: 'lite' } }])

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
  apply(host.ctx, { defaultMode: 'lite' })
  const tool = host.captured.tools[0]
  assert.ok(tool)

  const value = await tool.execute({ mode: 'full' })
  assert.deepEqual(tool.output.render({ mode: 'full' }, value), [
    { type: 'text', text: 'Caveman level: full (was lite). The ruleset is injected into every request.' },
  ])

  assert.deepEqual(tool.output.render({}, { mode: 'off', previous: 'full', changed: true, active: false }), [
    { type: 'text', text: 'Caveman off (was full). Normal behavior.' },
  ])
})

test('the tool answers a one-shot level without persisting it', async () => {
  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })

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

  await assert.rejects(() => callTool(host, { once: 'shrug' }), /Unknown caveman level/)
  await assert.rejects(() => callTool(host, { once: 'off' }), /not a reply style/)
})

test('the tool reports session usage only when asked and available', async () => {
  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })
  const tool = host.captured.tools[0]
  assert.ok(tool)

  // No projections service: no usage field, even when asked.
  assert.deepEqual(await callTool(host, { usage: true }), {
    mode: 'full', previous: 'full', changed: false, active: true,
  })

  // With a projections service, usage rides the exec's session.
  const session = { id: 's1' }
  const exec = { agent: { session } }
  const totals = { input: 100, output: 40, cacheRead: 500, cacheWrite: 10 }
  const projectionsHost = createProjectionsHost(totals)
  apply(projectionsHost.ctx, { defaultMode: 'full' })
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
  assert.deepEqual(await using.execute({ usage: true }), {
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
function createProjectionsHost(totals: { input: number; output: number; cacheRead: number; cacheWrite: number }): {
  ctx: HostContext
  captured: Captured
} {
  const host = createHost()
  const ctx = {
    ...(host.ctx as unknown as Record<string, unknown>),
    inject: (_dependencies: readonly string[], callback: (scope: HostContext) => void): void => {
      const scope = {
        ...(host.ctx as unknown as Record<string, unknown>),
        sessionProjections: {
          stateOf: (session: unknown, key: string): unknown =>
            key === 'tokenUsage' && (session as { id?: string })?.id === 's1' ? { totals } : undefined,
        },
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
  assert.throws(() => apply(host.ctx, { defaultMode: 'review' }), /defaultMode must be one of off, lite, full, ultra, wenyan-lite, wenyan-full, wenyan-ultra/)
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
  apply(host.ctx, { defaultMode: 'full' })
  assert.match(sectionText(host.captured.sections[0]), /level: full/)

  host.emit(userEvent('stop caveman'))

  // Synchronous: the turn that carried the command already assembles without
  // the ruleset, which is the whole point of watching the durable message.
  assert.equal(sectionText(host.captured.sections[0]), '')

  await settle()
  assert.deepEqual(host.captured.updates, [
    { namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { mode: 'off' } },
  ])
  // The committed document, not the session-local override, now says off.
  assert.equal(sectionText(host.captured.sections[0]), '')
})

test('"normal mode" works the same way', async () => {
  const host = createHost()
  apply(host.ctx, { defaultMode: 'ultra' })

  host.emit(userEvent('  Normal Mode! '))
  assert.equal(sectionText(host.captured.sections[0]), '')

  await settle()
  assert.deepEqual(host.captured.updates, [
    { namespace: CAVEMAN_SETTINGS_NAMESPACE, patch: { mode: 'off' } },
  ])
})

test('only the human\'s own words may deactivate', async () => {
  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })

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
  apply(host.ctx, { defaultMode: 'off' })

  host.emit(userEvent('stop caveman'))
  await settle()

  assert.deepEqual(host.captured.updates, [])
})

test('compress tool and command run the pipeline and honor the backup dir', async () => {
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })

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

  await assert.rejects(() => callCompressTool(host, {}), /needs a filepath string/)
  assert.deepEqual(await callCommand(host, '', 1), {
    kind: 'error', text: 'Usage: /caveman-compress <filepath>',
  })
})

test('backup dir override routes backups through settings', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const host = createHost()
  apply(host.ctx, { defaultMode: 'full' })
  host.captured.installs[0]?.hooks.setSource(() => ({ mode: 'full', compressBackupDir: 'vault-dir' }))
  host.captured.installs[0]?.hooks.onChange()

  const root = await mkdtemp(join(tmpdir(), 'caveman-backupdir-'))
  const cwd = process.cwd()
  try {
    process.chdir(root)
    await writeFile('note.md', '# N\n\nYou should always test thoroughly.\n')
    const outcome = await callCompressTool(host, { filepath: 'note.md' }) as Record<string, unknown>
    assert.equal(outcome['ok'], true)
    assert.match(String(outcome['backupPath']), /vault-dir/)
  } finally {
    process.chdir(cwd)
    await rm(root, { recursive: true, force: true })
  }
})
