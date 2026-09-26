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
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildModeInstructions,
  isDeactivationCommand,
  normalizeCommandMode,
  normalizeMode,
  resolveDefaultMode,
  RUNTIME_MODES,
  type CavemanMode,
} from './modes.ts'
import { createSkillProvider } from './skills.ts'
import { compressFile } from './compress-pipeline.ts'
import { MAX_FILE_SIZE } from './compress-files.ts'
import { parseFrontmatter } from './frontmatter.ts'
import type {
  CommandInvocationLike,
  CommandResultLike,
  HostContext,
  ProjectionStateLike,
  SessionMessageLike,
  SessionProjectionsLike,
  SettingsServiceLike,
  ToolExecLike,
} from './host.ts'

/** Plugin name as it appears in the loader. */
export const name = 'caveman'

/**
 * Settings namespace the browser card edits — the join key between this host
 * half and `lib/client.js`. The card registers into `plugins.item`
 * under the same id, and the Plugins page pairs the two without knowing what it means.
 */
/**
 * Every accepted level as a schema union, shared by the persisted settings and
 * the plugin row so the accepted set is declared once.
 */
const ModeSchema = z.union([...RUNTIME_MODES])

/** The levels a one-shot `once` call accepts: every level but `off`. */
const ONCE_MODES = RUNTIME_MODES.filter((mode) => mode !== 'off')

/**
 * Configuration accepted from this plugin's row in a profile patch.
 *
 * The exported schema is what Cordis validates the row against before `apply`
 * runs. It deliberately declares no default for `defaultMode`: a schema default
 * would fill the field before `apply`, which would silently outrank
 * `CAVEMAN_DEFAULT_MODE` and `~/.config/caveman/config.json`. Absence flows to
 * `resolveDefaultMode`, which owns the documented chain, and `apply` still
 * validates `defaultMode` itself so a caller that bypasses the loader cannot
 * mount a bad level.
 */
export interface Config {
  /** Startup level. Absent resolves through the chain, ending at `full`. Volatile on v0.1.7. */
  readonly defaultMode?: CavemanMode | { readonly value: CavemanMode | undefined }
  /** Size cap in bytes for `/caveman-compress`; defaults to 500000. */
  readonly maxFileSize?: number
}

/**
 * Row schema: the accepted levels and the size cap live here.
 *
 * `defaultMode` is volatile, the only kind of field the settings document
 * accepts: a level change commits into the running config without remounting
 * the plugin, and the field still carries no default, so absence keeps flowing
 * to `resolveDefaultMode`.
 */
export const Config = z.object({
  defaultMode: ModeSchema.volatile(),
  maxFileSize: z.number().default(MAX_FILE_SIZE),
})

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
  const configured = plainMode(config.defaultMode)
  if (configured !== undefined && normalizeMode(configured) === undefined) {
    throw new Error(
      `[caveman] defaultMode must be one of ${RUNTIME_MODES.join(', ')}; got ${JSON.stringify(config.defaultMode)}`,
    )
  }
  const maxFileSize = config.maxFileSize ?? MAX_FILE_SIZE
  if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) {
    throw new Error(
      `[caveman] maxFileSize must be a positive number of bytes; got ${JSON.stringify(config.maxFileSize)}`,
    )
  }

  // `<package>/skills`, resolved from this module's own location.
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  const startup = resolveDefaultMode({
    configured,
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

  /** Session-local level, used when the profile write cannot hold the level. */
  let override: CavemanMode | undefined
  /** Live row. v0.1.7 updates volatile fields in place. */
  const source = (): unknown => config

  const configuredMode = (): CavemanMode | undefined => {
    const value = source()
    if (value === null || typeof value !== 'object') return undefined
    return normalizeMode(plainMode((value as { defaultMode?: unknown }).defaultMode))
  }

  const activeMode = (): CavemanMode => override ?? configuredMode() ?? startup

  /**
   * Persist a level through the settings document; false when it cannot hold it.
   * @param next - the level to write.
   * @param signal - cancels the write when the calling tool was cancelled.
   */
  const persist = async (next: CavemanMode, signal?: AbortSignal): Promise<boolean> => {
    const settings = ctx.get('settings') as SettingsServiceLike | undefined
    const entryId = ctx.fiber?.entry?.options?.id
    if (settings === undefined || typeof entryId !== 'string' || normalizeMode(next) === undefined) return false
    signal?.throwIfAborted()
    let persisted: boolean
    try {
      await settings.update(entryId, { defaultMode: next })
      persisted = true
    } catch (error) {
      warn(`could not persist level "${next}": ${error instanceof Error ? error.message : String(error)}`)
      persisted = false
    }
    // Outside the try: an abort is not a persistence failure to be swallowed.
    signal?.throwIfAborted()
    return persisted
  }

  const setMode = async (
    next: CavemanMode,
    signal?: AbortSignal,
  ): Promise<{ previous: CavemanMode; mode: CavemanMode; changed: boolean }> => {
    const previous = activeMode()
    override = (await persist(next, signal)) ? undefined : next
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

  ctx.on('loader/volatile-update', () => {
    override = undefined
  })

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'caveman',
      order: 700, // after the persona prefix, before tool guidance
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
    scope.tools.register(createCompressTool(maxFileSize))
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
      handler: async (invocation) => handleCompressCommand(invocation, maxFileSize),
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
  // The unit's own bucket names, mapped to this plugin's labels.
  return {
    input: totals.uncachedInputTokens ?? 0,
    output: totals.outputTokens ?? 0,
    cacheRead: totals.cacheReadTokens ?? 0,
    cacheWrite: totals.cacheWriteTokens ?? 0,
  }
}

/**
 * Build the model-facing level tool.
 * @param getMode - reads the active level.
 * @param setMode - applies and persists a level.
 * @param getUsage - reads this session's provider-reported usage, when available.
 * @returns the registered tool definition.
 */
function createModeTool(
  getMode: () => CavemanMode,
  setMode: (
    next: CavemanMode,
    signal?: AbortSignal,
  ) => Promise<{ previous: CavemanMode; mode: CavemanMode; changed: boolean }>,
  getUsage?: (exec: ToolExecLike | undefined) => SessionUsage | undefined,
) {
  return defineTool({
    name: 'caveman',
    // The `enum` below already names every level, and the injected ruleset
    // explains what each one does; repeating both here only costs tokens.
    description:
      'Set or report the caveman level, which governs how terse replies are. '
      + 'The level persists in the user settings document. '
      + 'Call with no arguments to report the current level. '
      + 'A per-call `mode` applies to this call only and is not persisted.',
    parameters: {
      mode: {
        type: 'string',
        enum: [...RUNTIME_MODES],
        description: 'Level to activate and persist. Omit to report the current level.',
      },
      once: {
        type: 'string',
        enum: [...ONCE_MODES],
        description: 'Level for this call only. Not persisted; `mode` wins when both are given.',
      },
      usage: {
        type: 'boolean',
        description: 'Include this session’s provider-reported token totals (input, output, cache read/write). Never a saving.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: [...RUNTIME_MODES], required: true },
          previous: { type: 'string', enum: [...RUNTIME_MODES], required: true },
          changed: { type: 'boolean', required: true },
          active: { type: 'boolean', required: true },
          once: { type: 'string', enum: [...ONCE_MODES] },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input: { type: 'number', required: true },
              output: { type: 'number', required: true },
              cacheRead: { type: 'number', required: true },
              cacheWrite: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderModeResult(value) }],
    },
    async execute(args, exec) {
      // A cancelled call must not start, and must not persist a level it can
      // no longer report.
      exec?.signal?.throwIfAborted()
      const once = args.once
      const previous = getMode()
      if (args.mode === undefined) {
        return {
          mode: once ?? previous,
          previous,
          changed: false,
          active: (once ?? previous) !== 'off',
          ...(once !== undefined ? { once } : {}),
          ...usageField(args, exec, getUsage),
        }
      }

      const applied = await setMode(args.mode, exec?.signal)
      return {
        mode: applied.mode,
        previous: applied.previous,
        changed: applied.changed,
        active: applied.mode !== 'off',
        ...(once !== undefined ? { once } : {}),
        ...usageField(args, exec, getUsage),
      }
    },
  })
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
 * @param maxFileSize - configured size cap in bytes.
 * @returns the registered tool definition.
 */
function createCompressTool(maxFileSize: number) {
  return defineTool({
    name: 'caveman-compress',
    description:
      'Compress a natural-language file (memory file, todo list) with local '
      + 'caveman rules. Code, URLs, paths, and headings are preserved; the '
      + 'original is backed up out-of-tree.',
    parameters: {
      filepath: {
        type: 'string',
        required: true,
        description: 'Absolute path of the file to compress.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          backupPath: { type: 'string' },
          originalChars: { type: 'number' },
          compressedChars: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCompressResult(value) }],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted()
      // The schema owns the type; an empty path is the one shape it cannot see.
      if (args.filepath.trim() === '') {
        throw new Error('caveman-compress needs a filepath string.')
      }
      const outcome = compressFile(args.filepath, maxFileSize)
      // The write is atomic but not free; a cancelled call must not claim it.
      exec?.signal?.throwIfAborted()
      return outcome
    },
  })
}

/**
 * Phrase one successful compression. Shared by the model-facing tool and the
 * human command, which report the same three numbers.
 * @param originalChars - body length before compression.
 * @param compressedChars - body length after compression.
 * @param backupPath - out-of-tree backup file path.
 * @returns the sentence both surfaces report.
 */
function compressSentence(originalChars: number, compressedChars: number, backupPath: string): string {
  return `Compressed ${originalChars} to ${compressedChars} chars. Original backed up at ${backupPath}.`
}

/**
 * Render the canonical compress value for the model.
 * @param value - the canonical value returned by `execute`.
 * @returns model-facing prose.
 */
function renderCompressResult(value: unknown): string {
  const record = (value ?? {}) as Record<string, unknown>
  if (record['ok'] !== true) {
    return typeof record['reason'] === 'string' ? record['reason'] : 'compression failed'
  }
  return compressSentence(
    typeof record['originalChars'] === 'number' ? record['originalChars'] : 0,
    typeof record['compressedChars'] === 'number' ? record['compressedChars'] : 0,
    typeof record['backupPath'] === 'string' ? record['backupPath'] : 'unknown',
  )
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
      text: `Unknown caveman level "${invocation.rawInput.trim()}". Use one of: ${RUNTIME_MODES.join(', ')}.`,
    }
  }

  const { previous, mode, changed } = await setMode(requested)
  return { kind: 'success', text: modeSentence(mode, previous, changed) }
}

/**
 * Handle the human `/caveman-compress <filepath>` command.
 * @param invocation - the command invocation.
 * @returns the direct-UI result.
 */
async function handleCompressCommand(
  invocation: CommandInvocationLike,
  maxFileSize: number,
): Promise<CommandResultLike> {
  const filepath = invocation.rawInput.trim()
  if (filepath === '') {
    return { kind: 'error', text: 'Usage: /caveman-compress <filepath>' }
  }
  const outcome = compressFile(filepath, maxFileSize)
  if (!outcome.ok) return { kind: 'error', text: outcome.reason }
  return {
    kind: 'success',
    text: compressSentence(outcome.originalChars, outcome.compressedChars, outcome.backupPath),
  }
}

/** Unwrap a v0.1.7 volatile ref. A plain value passes through. */
function plainMode(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get: () => unknown }).get()
  }
  return value
}
