/**
 * The slice of the DeepSeek Harness host surface this plugin uses, declared
 * structurally.
 *
 * The plugin is installed from outside the harness checkout. It depends on the
 * published `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-skill` packages: the
 * skill domain shapes (summaries, candidates, definitions, lookup options) are
 * imported from the latter, while the services it reaches through
 * `ctx.inject([...])` are declared structurally here: the host types remain
 * authoritative, and a composition that does not mount a service simply omits
 * that capability.
 *
 * @module dsh-caveman/host
 */

import type { SkillCandidate, SkillDefinition, SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Disposer returned by every host registration. */
type Disposable = () => void

/** One contributed system-prompt section. */
export interface PromptSectionContribution {
  /** Unique section name across the composition. */
  readonly name: string
  /** Ascending concatenation position. */
  readonly order: number
  /** Static text, or a provider evaluated at each assembly (empty text is dropped). */
  readonly text: string | ((context: unknown) => string)
}

/**
 * The workspace-independent slice of the host's `SkillProvider` this plugin
 * implements: flat candidate arrays, and lookup options that stay optional for
 * direct callers. The packaged provider ignores `cwd` and never reports an
 * incomplete observation.
 */
export interface SkillProviderLike {
  /** Unique provider name in the registry. */
  readonly name: string
  /** List candidates for the current lookup, settling promptly on abort. */
  list(options?: SkillLookupOptions): Promise<readonly SkillCandidate[]>
  /** Load a winning candidate's body, or `undefined` when it is gone. */
  get(candidate: SkillCandidate, options?: SkillLookupOptions): Promise<SkillDefinition | undefined>
}

/** The slice of a tool execution context this plugin reads. */
export interface ToolExecLike {
  /** The agent on whose behalf the call runs. */
  readonly agent?: { readonly session?: unknown } | undefined
  /** Caller-owned cancellation for this invocation. */
  readonly signal?: AbortSignal | undefined
}

/** One session-projection unit state. */
export interface ProjectionStateLike {
  /** Cumulative provider-reported token buckets, named as the unit names them. */
  readonly totals?: {
    readonly uncachedInputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  } | undefined
}

/** The slice of the session-projections service this plugin reads. */
export interface SessionProjectionsLike {
  /** Read one unit's host state for a session, or `undefined` when absent. */
  stateOf(session: unknown, key: string): ProjectionStateLike | undefined
}

/** Invocation handed to a registered human command. */
export interface CommandInvocationLike {
  /** Text following the command name, including separator whitespace. */
  readonly rawInput: string
}

/** Direct-UI outcome of a human command. */
export type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** A plugin-owned human command. */
export interface CommandDefinitionLike {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint. */
  readonly input?: { readonly hint: string }
  /** Execute against the receiving agent without a model message. */
  handler(invocation: CommandInvocationLike): CommandResultLike | Promise<CommandResultLike>
}

/**
 * The slice of a durable session message the deactivation watcher reads.
 *
 * `source.kind === 'user'` is what separates the human's own words from the
 * context the harness injects into the same event stream (skill bodies,
 * references, replayed history).
 */
export interface SessionMessageLike {
  /** Content blocks; only `text` blocks carry words. */
  readonly content?: readonly { readonly type?: string; readonly text?: string }[] | undefined
  /** Provenance of the message. */
  readonly source?: { readonly kind?: string } | undefined
}

/** One durable session event, as `session/event` delivers it. */
export interface SessionEventLike {
  /** Event discriminator, e.g. `user/message`. */
  readonly type?: string
  /** Event payload; a {@link SessionMessageLike} for `user/message`. */
  readonly data?: unknown
}

/**
 * Structural view of the Cordis context the plugin uses.
 *
 * Members are only reached inside the matching `inject` callback, where the
 * host guarantees the service is present.
 */
export interface HostContext {
  /** Run `callback` once the named services are available. */
  inject(dependencies: readonly string[], callback: (scope: HostContext) => void): unknown
  /** Subscribe to a host event; the returned disposer removes the listener. */
  on(event: 'session/event', listener: (session: unknown, event: SessionEventLike) => void): Disposable
  on(event: 'loader/volatile-update', listener: () => void): Disposable
  /** Read one mounted service. `undefined` when that service is absent. */
  get(name: 'settings'): SettingsServiceLike | undefined
  get(name: 'sessionProjections'): SessionProjectionsLike | undefined
  /** Owning fiber, present once the loader mounted this plugin. */
  readonly fiber?: { readonly entry?: { readonly options?: { readonly id?: string } } }
  readonly systemPrompt: {
    section(section: PromptSectionContribution): Disposable
  }
  readonly skills: {
    registerProvider(create: () => SkillProviderLike): Disposable
  }
  readonly tools: {
    register(definition: ToolDefinition): Disposable
  }
  readonly commands: {
    register(definition: CommandDefinitionLike): Disposable
  }
  readonly settings: SettingsServiceLike
  readonly sessionProjections?: SessionProjectionsLike
}

/** The slice of the settings service this plugin uses. */
export interface SettingsServiceLike {
  /**
   * Merge fields into one profile entry. `ns` is the entry id, not a namespace.
   * @param ns - profile entry id.
   * @param patch - fields to merge.
   */
  update(ns: string, patch: Record<string, unknown>): Promise<void>
}
