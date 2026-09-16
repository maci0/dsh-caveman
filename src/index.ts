/**
 * dsh-caveman — Caveman terse-talk mode, as a DeepSeek Harness plugin.
 *
 * Four capabilities, all mounted through public Cordis extension points:
 *
 * - the bundled skills (`caveman`, `cavecrew`, `-commit`, `-review`,
 *   `-compress`, `-stats`, `-help`, plus six work patterns) become one
 *   `ctx.skills` provider;
 * - while a level other than `off` is active, the mode-filtered ruleset is
 *   contributed to the system prompt on every assembly;
 * - the level is switchable from the model (`caveman` tool) and the human
 *   (`/caveman` command);
 * - the `caveman` settings namespace makes the level persistent and pairs with
 *   this package's browser half, which renders the card in the Web client's
 *   Plugins → Plugin configuration tab.
 *
 * Skill content is adapted from the reference implementation
 * (https://github.com/JuliusBrussee/caveman, MIT, © JuliusBrussee). Only the
 * skill (talking-style) half is ported: the proxy, CLI verbs, and Cloud
 * engine need an external runtime the harness has no extension point for.
 *
 * @module dsh-caveman
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  buildModeInstructions,
  DEFAULT_MODE,
  isDeactivationCommand,
  normalizeCommandMode,
  normalizeMode,
  resolveDefaultMode,
  RUNTIME_MODES,
  VALID_MODES,
  type CavemanMode,
} from './modes.ts'
import { createSkillProvider } from './skills.ts'
import { compressFile } from './compress-pipeline.ts'
import { setBackupRootOverride } from './compress-files.ts'
import { parseFrontmatter } from './frontmatter.ts'
import type {
  CommandInvocationLike,
  CommandResultLike,
  HostContext,
  ProjectionStateLike,
  SessionMessageLike,
  SessionProjectionsLike,
  SettingsServiceLike,
  ToolDefinitionLike,
  ToolExecLike,
} from './host.ts'

/** Plugin name as it appears in the loader. */
export const name = 'caveman'

/**
 * Settings namespace the browser card edits — the join key between this host
 * half and `lib/client.js`. The card registers into `settings.plugin.item`
 * under the same key, and the tab pairs the two without knowing what it means.
 */
export const CAVEMAN_SETTINGS_NAMESPACE = 'caveman'

/** Persisted configuration. Every caveman level persists; there is no session-only level. */
export const CavemanSettings = z.object({
  mode: z.union([...RUNTIME_MODES]).default(DEFAULT_MODE),
  compressBackupDir: z.string().default(''),
})

/**
 * Configuration accepted from this plugin's row in a profile patch.
 *
 * No Schemastery `Config` schema is exported: the loader would require a
 * Standard Schema for it, and this plugin validates its own row instead so the
 * loader never has to. The runtime import of `@deepseek-ai/schemastery` is for
 * {@link CavemanSettings}, whose `toJSON()` the settings service serializes
 * for browser-side rehydration.
 */
export interface Config {
  /** Startup level. Defaults to `CAVEMAN_DEFAULT_MODE`, then `full`. */
  readonly defaultMode?: string
}

/** Default system-prompt position: after the persona prefix, before tool guidance. */
const DEFAULT_PROMPT_ORDER = 700

/** Section name of the injected ruleset. */
const SECTION_NAME = 'caveman'

/** Upstream config file, read the way upstream reads it. */
const UPSTREAM_CONFIG_PATH = join(homedir(), '.config', 'caveman', 'config.json')

/**
 * Read the upstream config file's `defaultMode`, ignoring everything that
 * would make startup fail: a missing file, an unreadable file, invalid JSON,
 * or a non-object document all mean "no file default".
 * @param path - config file path; the upstream location unless tests override it.
 * @returns the parsed document, or `undefined` when there is nothing usable.
 */
export function readUpstreamConfigFile(
  path: string = UPSTREAM_CONFIG_PATH,
): { readonly defaultMode?: unknown } | undefined {
  let source: string
  try {
    if (!existsSync(path)) return undefined
    source = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as { readonly defaultMode?: unknown }
}

/**
 * Mount the plugin.
 * @param ctx - the host context.
 * @param config - optional row configuration.
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  // Reject configuration that would silently do the wrong thing.
  if (config.defaultMode !== undefined && normalizeMode(config.defaultMode) === undefined) {
    throw new Error(
      `[caveman] defaultMode must be one of ${RUNTIME_MODES.join(', ')}; got ${JSON.stringify(config.defaultMode)}`,
    )
  }

  // `<package>/skills`, resolved from this module's own location.
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  const startup = resolveDefaultMode({
    configured: config.defaultMode,
    configFile: readUpstreamConfigFile(),
  })
  // Parsed once, at load: the ruleset is filtered per assembly, so the
  // frontmatter must not have to be re-read for every request. A missing body
  // means a broken install: fail while loading rather than injecting a silently
  // truncated ruleset.
  const skillBody = parseFrontmatter(readFileSync(join(skillsDir, 'caveman', 'SKILL.md'), 'utf8')).body.trimStart()

  const warn = (message: string): void => {
    console.warn(`[caveman] ${message}`)
  }

  /** Session-local level, used when the settings document cannot hold the write. */
  let override: CavemanMode | undefined
  /** Authoritative configuration source: the settings scope once attached, else the row. */
  let source: () => unknown = () => ({ mode: startup })
  let settings: SettingsServiceLike | undefined

  const configuredMode = (): CavemanMode | undefined => {
    const value = source()
    if (value === null || typeof value !== 'object') return undefined
    return normalizeMode((value as { mode?: unknown }).mode)
  }

  /** Sync the backup-dir override from settings before each compress run. */
  const syncBackupDir = (): void => {
    const value = source()
    const dir = value !== null && typeof value === 'object'
      ? (value as { compressBackupDir?: unknown }).compressBackupDir
      : undefined
    setBackupRootOverride(typeof dir === 'string' ? dir : '')
  }

  const activeMode = (): CavemanMode => override ?? configuredMode() ?? startup

  /** Persist a level through the settings document; false when it cannot hold it. */
  const persist = async (next: CavemanMode): Promise<boolean> => {
    if (settings === undefined || normalizeMode(next) === undefined) return false
    try {
      await settings.update(CAVEMAN_SETTINGS_NAMESPACE, { mode: next })
      return true
    } catch (error) {
      warn(`could not persist level "${next}": ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  const setMode = async (
    next: CavemanMode,
  ): Promise<{ previous: CavemanMode; mode: CavemanMode; changed: boolean }> => {
    const previous = activeMode()
    override = (await persist(next)) ? undefined : next
    const mode = activeMode()
    return { previous, mode, changed: mode !== previous }
  }

  /**
   * Turn the level off because the human's own message was a deactivation
   * command.
   *
   * The override is set before the settings write is awaited: the durable
   * `user/message` event arrives before the turn's prompt is assembled, and
   * awaiting the document would let that same turn assemble with the ruleset
   * still injected — the one turn the user just asked to end. A committed
   * document then becomes the source of truth again, so the card and the
   * prompt cannot disagree.
   */
  const deactivateFromMessage = (): void => {
    if (activeMode() === 'off') return
    override = 'off'
    void persist('off').then((persisted) => {
      if (persisted) override = undefined
    })
  }

  ctx.inject(['settings'], (scope) => {
    settings = scope.settings
    settings.installSection(
      ctx,
      CAVEMAN_SETTINGS_NAMESPACE,
      CavemanSettings,
      { mode: startup, compressBackupDir: '' },
      {
        setSource: (current) => {
          source = current
        },
        // Fires at attach and after every committed change. A settings change
        // supersedes a session-local override; the ruleset itself is re-read at
        // each assembly, so there is nothing else to re-judge here.
        onChange: () => {
          override = undefined
        },
      },
    )
  })

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: SECTION_NAME,
      order: DEFAULT_PROMPT_ORDER,
      // Evaluated at each assembly, so a level change lands on the next request.
      // `off` returns empty text, which assembly drops.
      text: () => buildModeInstructions({ mode: activeMode(), skillBody }),
    })
  })

  ctx.inject(['skills'], (scope) => {
    scope.skills.registerProvider(() =>
      createSkillProvider({ skillsDir, onWarn: warn }),
    )
  })

  ctx.inject(['tools'], (scope) => {
    scope.tools.register(createModeTool(activeMode, setMode, (exec) => readSessionUsage(scope, exec)))
    scope.tools.register(createCompressTool(syncBackupDir))
  })

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'caveman',
      description: '🪨 Set the caveman level (lite, full, ultra, wenyan-*, off) or report the current one.',
      input: { hint: 'lite | full | ultra | wenyan-lite | wenyan-full | wenyan-ultra | off' },
      handler: async (invocation) => handleModeCommand(invocation, activeMode, setMode),
    })
    scope.commands.register({
      name: 'caveman-compress',
      description: '🗜 Compress a memory file with local rules (backup kept).',
      input: { hint: '<filepath>' },
      handler: async (invocation) => handleCompressCommand(invocation, syncBackupDir),
    })
  })

  // "stop caveman" / "normal mode" typed as an ordinary message, given the
  // same effect as `/caveman off`. The command path is unaffected: this only
  // claims messages that are exactly the command and come from the human.
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'user/message') return
    const text = userMessageText(event.data)
    if (text === undefined || !isDeactivationCommand(text)) return
    deactivateFromMessage()
  })
}

/**
 * Read the plain text of a genuine user message.
 *
 * Injected context (skill bodies, file references, replayed history) rides the
 * same event stream, so a message only counts when the harness marks it as the
 * user's own; an injected instruction that happened to read "normal mode" must
 * never toggle the level.
 * @param data - the `user/message` event payload.
 * @returns the concatenated text blocks, or `undefined` when this is not the
 * human's own text.
 */
function userMessageText(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined

  const message = data as SessionMessageLike
  if (message.source?.kind !== 'user') return undefined
  if (!Array.isArray(message.content)) return undefined

  const text = message.content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
  return text.trim() === '' ? undefined : text
}

/**
 * Read this session's cumulative provider-reported usage through the
 * token-meter `tokenUsage` projection, when the host mounts it.
 *
 * Counts only what the provider reported — never a saving, a percentage, or
 * a cost. `undefined` when the service, the session, or the unit is absent.
 * @param scope - the tools-callback scope, which may carry `sessionProjections`.
 * @param exec - the tool execution, carrying the calling agent's session.
 * @returns the usage totals, or `undefined`.
 */
function readSessionUsage(
  scope: HostContext,
  exec: ToolExecLike | undefined,
): SessionUsage | undefined {
  const projections: SessionProjectionsLike | undefined = scope.sessionProjections
  const session: unknown = exec?.agent?.session
  if (projections === undefined || session === undefined) return undefined
  let state: ProjectionStateLike | undefined
  try {
    state = projections.stateOf(session, 'tokenUsage')
  } catch {
    return undefined
  }
  const totals = state?.totals
  if (totals === undefined) return undefined
  return {
    input: totals.input ?? 0,
    output: totals.output ?? 0,
    cacheRead: totals.cacheRead ?? 0,
    cacheWrite: totals.cacheWrite ?? 0,
  }
}

/**
 * Build the model-facing level tool.
 * @param getMode - reads the active level.
 * @param setMode - applies and persists a level.
 * @param getUsage - reads this session's provider-reported usage, when available.
 * @returns the raw tool definition.
 */
function createModeTool(
  getMode: () => CavemanMode,
  setMode: (next: CavemanMode) => Promise<{ previous: CavemanMode; mode: CavemanMode; changed: boolean }>,
  getUsage?: (exec: ToolExecLike | undefined) => SessionUsage | undefined,
): ToolDefinitionLike {
  return {
    name: 'caveman',
    // The `enum` below already names every level, and the injected ruleset
    // explains what each one does; repeating both here only costs tokens.
    description:
      'Set or report the caveman level, which governs how terse replies are. '
      + 'The level persists in the user settings document. '
      + 'Call with no arguments to report the current level. '
      + 'A per-call `mode` applies to this call only and is not persisted.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: [...VALID_MODES],
          description: 'Level to activate and persist. Omit to report the current level.',
        },
        once: {
          type: 'string',
          enum: [...VALID_MODES.filter((mode) => mode !== 'off')],
          description: 'Level for this call only. Not persisted; `mode` wins when both are given.',
        },
        usage: {
          type: 'boolean',
          description: 'Include this session’s provider-reported token totals (input, output, cache read/write). Never a saving.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...VALID_MODES] },
          previous: { type: 'string', enum: [...VALID_MODES] },
          changed: { type: 'boolean' },
          active: { type: 'boolean' },
          once: { type: 'string', enum: [...VALID_MODES.filter((mode) => mode !== 'off')] },
          usage: {
            type: 'object',
            properties: {
              input: { type: 'number' },
              output: { type: 'number' },
              cacheRead: { type: 'number' },
              cacheWrite: { type: 'number' },
            },
            required: ['input', 'output', 'cacheRead', 'cacheWrite'],
            additionalProperties: false,
          },
        },
        required: ['mode', 'previous', 'changed', 'active'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderModeResult(value) }],
    },
    async execute(args, exec) {
      const requested = readModeArgument(args)
      const once = readOnceArgument(args)
      const previous = getMode()
      if (requested === undefined) {
        return {
          mode: once ?? previous,
          previous,
          changed: false,
          active: (once ?? previous) !== 'off',
          ...(once !== undefined ? { once } : {}),
          ...usageField(args, exec, getUsage),
        }
      }

      const applied = await setMode(requested)
      return {
        mode: applied.mode,
        previous: applied.previous,
        changed: applied.changed,
        active: applied.mode !== 'off',
        ...(once !== undefined ? { once } : {}),
        ...usageField(args, exec, getUsage),
      }
    },
  }
}

/** This session's provider-reported usage, or `undefined` when unavailable. */
interface SessionUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * Read the optional `usage` flag's field: the session totals when asked and
 * available, otherwise nothing. Savings are never inferred — the log has no
 * unbuilt baseline to subtract.
 */
function usageField(
  args: unknown,
  exec: ToolExecLike | undefined,
  getUsage: ((exec: ToolExecLike | undefined) => SessionUsage | undefined) | undefined,
): { readonly usage?: SessionUsage } {
  if (getUsage === undefined) return {}
  if (args === null || typeof args !== 'object') return {}
  if ((args as Record<string, unknown>)['usage'] !== true) return {}
  const usage = getUsage(exec)
  return usage === undefined ? {} : { usage }
}

/**
 * Build the model-facing compress tool. Local deterministic rules only —
 * no model call, no bytes leave the machine.
 * @param syncBackupDir - applies the backup-dir override before each run.
 * @returns the raw tool definition.
 */
function createCompressTool(syncBackupDir: () => void): ToolDefinitionLike {
  return {
    name: 'caveman-compress',
    description:
      'Compress a natural-language file (memory file, todo list) with local '
      + 'caveman rules. Code, URLs, paths, and headings are preserved; the '
      + 'original is backed up out-of-tree.',
    parameters: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Absolute path of the file to compress.',
        },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          backupPath: { type: 'string' },
          originalChars: { type: 'number' },
          compressedChars: { type: 'number' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderCompressResult(value) }],
    },
    async execute(args) {
      if (args === null || typeof args !== 'object') {
        throw new Error('caveman-compress needs a filepath string.')
      }
      const filepath = (args as Record<string, unknown>)['filepath']
      if (typeof filepath !== 'string' || filepath.trim() === '') {
        throw new Error('caveman-compress needs a filepath string.')
      }
      syncBackupDir()
      return compressFile(filepath)
    },
  }
}

/**
 * Render the canonical compress value for the model.
 * @param value - the canonical value returned by `execute`.
 * @returns model-facing prose.
 */
function renderCompressResult(value: unknown): string {
  const record = (value ?? {}) as Record<string, unknown>
  if (record['ok'] !== true) {
    const reason = typeof record['reason'] === 'string' ? record['reason'] : 'compression failed'
    return reason
  }
  const backup = typeof record['backupPath'] === 'string' ? record['backupPath'] : 'unknown'
  const before = typeof record['originalChars'] === 'number' ? record['originalChars'] : 0
  const after = typeof record['compressedChars'] === 'number' ? record['compressedChars'] : 0
  return `Compressed ${before} to ${after} chars. Original backed up at ${backup}.`
}

/**
 * Read the optional `mode` argument, validating it because raw definitions own
 * their input validation.
 * @param args - losslessly snapshotted model arguments.
 * @returns the requested level, or `undefined` for a status query.
 */
function readModeArgument(args: unknown): CavemanMode | undefined {
  if (args === null || typeof args !== 'object') return undefined

  const raw = (args as Record<string, unknown>)['mode']
  if (raw === undefined || raw === null || raw === '') return undefined

  const mode = normalizeMode(raw)
  if (mode === undefined) {
    throw new Error(
      `Unknown caveman level ${JSON.stringify(raw)}. Use one of: ${VALID_MODES.join(', ')}.`,
    )
  }
  return mode
}

/**
 * Read the optional per-call `once` argument. It applies to the reply being
 * composed only and is never persisted — upstream's stateless `/caveman <mode>`
 * prefix behavior, without a flag file.
 * @param args - losslessly snapshotted model arguments.
 * @returns the one-shot level, or `undefined` when not asked.
 */
function readOnceArgument(args: unknown): CavemanMode | undefined {
  if (args === null || typeof args !== 'object') return undefined

  const raw = (args as Record<string, unknown>)['once']
  if (raw === undefined || raw === null || raw === '') return undefined

  const once = normalizeMode(raw)
  if (once === undefined) {
    throw new Error(
      `Unknown caveman level ${JSON.stringify(raw)}. Use one of: ${VALID_MODES.filter((mode) => mode !== 'off').join(', ')}.`,
    )
  }
  if (once === 'off') {
    throw new Error('`once: "off"` is not a reply style; omit `once` or pick a level.')
  }
  return once
}

/**
 * Phrase one level outcome. Shared by the model-facing tool and the human
 * command, which report the same three transitions.
 * @param mode - the level now active.
 * @param previous - the level before the call.
 * @param changed - whether the call moved the level.
 * @returns the sentence both surfaces start from.
 */
function modeSentence(mode: string, previous: string, changed: boolean): string {
  if (!changed) return `Caveman level: ${mode}.`
  return mode === 'off'
    ? `Caveman off (was ${previous}). Normal behavior.`
    : `Caveman level: ${mode} (was ${previous}).`
}

/**
 * Render the canonical tool value for the model.
 * @param value - the canonical value returned by `execute`.
 * @returns model-facing prose.
 */
function renderModeResult(value: unknown): string {
  const record = (value ?? {}) as Record<string, unknown>
  const mode = typeof record['mode'] === 'string' ? record['mode'] : 'unknown'
  const previous = typeof record['previous'] === 'string' ? record['previous'] : mode
  const changed = record['changed'] === true
  const active = record['active'] === true
  const once = typeof record['once'] === 'string' ? record['once'] : undefined
  const usage = record['usage'] as Record<string, unknown> | undefined

  const core = (!changed && !active)
    ? 'Caveman is off. Normal behavior.'
    : active
      ? `${modeSentence(mode, previous, changed)} The ruleset is injected into every request.`
      : modeSentence(mode, previous, changed)
  const onceLine = once !== undefined ? ` Reply to this call in ${once}; the persisted level is unchanged.` : ''
  if (usage === undefined) return `${core}${onceLine}`
  const line = (name: string): number => typeof usage[name] === 'number' ? usage[name] as number : 0
  return `${core}${onceLine} Session usage so far — input ${line('input')}, output ${line('output')}, cache read ${line('cacheRead')}, cache write ${line('cacheWrite')}. Savings unknown without a measured comparison.`
}

/**
 * Handle the human `/caveman [level]` command.
 * @param invocation - the command invocation.
 * @param getMode - reads the active level.
 * @param setMode - applies and persists a level.
 * @returns the direct-UI result.
 */
async function handleModeCommand(
  invocation: CommandInvocationLike,
  getMode: () => CavemanMode,
  setMode: (next: CavemanMode) => Promise<{ previous: CavemanMode; mode: CavemanMode; changed: boolean }>,
): Promise<CommandResultLike> {
  const input = invocation.rawInput.trim().toLowerCase()

  if (input === '') return { kind: 'success', text: modeSentence(getMode(), getMode(), false) }

  const requested = isDeactivationCommand(input) ? 'off' : normalizeCommandMode(input)
  if (requested === undefined) {
    return {
      kind: 'error',
      text: `Unknown caveman level "${invocation.rawInput.trim()}". Use one of: ${VALID_MODES.join(', ')}.`,
    }
  }

  const { previous, mode, changed } = await setMode(requested)
  return { kind: 'success', text: modeSentence(mode, previous, changed) }
}

/**
 * Handle the human `/caveman-compress <filepath>` command.
 * @param invocation - the command invocation.
 * @param syncBackupDir - applies the backup-dir override before each run.
 * @returns the direct-UI result.
 */
async function handleCompressCommand(
  invocation: CommandInvocationLike,
  syncBackupDir: () => void,
): Promise<CommandResultLike> {
  const filepath = invocation.rawInput.trim()
  if (filepath === '') {
    return { kind: 'error', text: 'Usage: /caveman-compress <filepath>' }
  }
  syncBackupDir()
  const outcome = compressFile(filepath)
  if (!outcome.ok) return { kind: 'error', text: outcome.reason }
  return {
    kind: 'success',
    text: `Compressed ${outcome.originalChars} to ${outcome.compressedChars} chars. Original backed up at ${outcome.backupPath}.`,
  }
}
