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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  buildModeInstructions,
  DEFAULT_MODE,
  isDeactivationCommand,
  normalizeCommandMode,
  normalizeConfigMode,
  normalizeMode,
  resolveDefaultMode,
  RUNTIME_MODES,
  VALID_MODES,
  type CavemanMode,
} from './modes.ts'
import { createSkillProvider } from './skills.ts'
import { parseFrontmatter } from './frontmatter.ts'
import type {
  CommandInvocationLike,
  CommandResultLike,
  HostContext,
  SessionMessageLike,
  SettingsServiceLike,
  ToolDefinitionLike,
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
  const startup = resolveDefaultMode({ configured: config.defaultMode })
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
      { mode: startup },
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
    scope.tools.register(createModeTool(activeMode, setMode))
  })

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'caveman',
      description: '🪨 Set the caveman level (lite, full, ultra, wenyan-*, off) or report the current one.',
      input: { hint: 'lite | full | ultra | wenyan-lite | wenyan-full | wenyan-ultra | off' },
      handler: async (invocation) => handleModeCommand(invocation, activeMode, setMode),
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
 * Build the model-facing level tool.
 * @param getMode - reads the active level.
 * @param setMode - applies and persists a level.
 * @returns the raw tool definition.
 */
function createModeTool(
  getMode: () => CavemanMode,
  setMode: (next: CavemanMode) => Promise<{ previous: CavemanMode; mode: CavemanMode; changed: boolean }>,
): ToolDefinitionLike {
  return {
    name: 'caveman',
    // The `enum` below already names every level, and the injected ruleset
    // explains what each one does; repeating both here only costs tokens.
    description:
      'Set or report the caveman level, which governs how terse replies are. '
      + 'The level persists in the user settings document. '
      + 'Call with no arguments to report the current level.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: [...VALID_MODES],
          description: 'Level to activate. Omit to report the current level.',
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
        },
        required: ['mode', 'previous', 'changed', 'active'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderModeResult(value) }],
    },
    async execute(args) {
      const requested = readModeArgument(args)
      const previous = getMode()
      if (requested === undefined) {
        return { mode: previous, previous, changed: false, active: previous !== 'off' }
      }

      const applied = await setMode(requested)
      return {
        mode: applied.mode,
        previous: applied.previous,
        changed: applied.changed,
        active: applied.mode !== 'off',
      }
    },
  }
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

  const mode = normalizeConfigMode(raw)
  if (mode === undefined) {
    throw new Error(
      `Unknown caveman level ${JSON.stringify(raw)}. Use one of: ${VALID_MODES.join(', ')}.`,
    )
  }
  return mode
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

  if (!changed && !active) return 'Caveman is off. Normal behavior.'
  const sentence = modeSentence(mode, previous, changed)
  return active ? `${sentence} The ruleset is injected into every request.` : sentence
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
