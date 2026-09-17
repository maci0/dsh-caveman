/**
 * The slice of the DeepSeek Harness host surface this plugin uses, declared
 * structurally.
 *
 * The plugin is installed from outside the harness checkout. It depends on the
 * published `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-skill` packages, but
 * the services it reaches through `ctx.inject([...])` are declared structurally
 * here: the host types remain authoritative, and a composition that does not
 * mount a service simply omits that capability.
 *
 * @module dsh-caveman/host
 */

/** Disposer returned by every host registration. */
export type Disposable = () => void

/** One contributed system-prompt section. */
export interface PromptSectionContribution {
  /** Unique section name across the composition. */
  readonly name: string
  /** Ascending concatenation position. */
  readonly order: number
  /** Static text, or a provider evaluated at each assembly (empty text is dropped). */
  readonly text: string | ((context: unknown) => string)
}

/** Invocation controls carried by every skill summary. */
export interface SkillInvocationPolicyLike {
  /** Whether model-facing catalogs and the `skill` tool include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs include this skill. */
  readonly userInvocable: boolean
}

/** Invocation-neutral skill metadata. */
export interface SkillSummaryLike {
  /** Absolute instruction file path, when the provider has one. */
  readonly path?: string
  /** Kebab-case identifier. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved invocation controls. */
  readonly invocation: SkillInvocationPolicyLike
  /** Discovery source bucket. */
  readonly source: string
  /** Owning provider name. */
  readonly provider: string
  /** Base for resources referenced by the loaded body. */
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string }
}

/**
 * Per-lookup options the registry hands a provider.
 *
 * Only the cancellation half is read: packaged skills are workspace-independent,
 * so `cwd` cannot select anything here.
 */
export interface SkillLookupOptionsLike {
  /** Aborts discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}

/** Provider catalog entry the registry merges and later loads. */
export interface SkillCandidateLike extends SkillSummaryLike {
  /** Lower ranks win duplicate names before provider registration order. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `get()`. */
  readonly locator: unknown
  /** Parsed provider-specific frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Complete skill definition including the loaded body. */
export interface SkillDefinitionLike extends SkillSummaryLike {
  /** Instruction body after frontmatter removal. */
  readonly content: string
  /** Parsed provider-specific frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** One source of skills. */
export interface SkillProviderLike {
  /** Unique provider name in the registry. */
  readonly name: string
  /** List candidates for the current lookup, settling promptly on abort. */
  list(options?: SkillLookupOptionsLike): Promise<readonly SkillCandidateLike[]>
  /** Load a winning candidate's body, or `undefined` when it is gone. */
  get(candidate: SkillCandidateLike, options?: SkillLookupOptionsLike): Promise<SkillDefinitionLike | undefined>
}

/** Model-facing content block. */
export interface ContentBlockLike {
  /** Block discriminator; this plugin only ever produces `text`. */
  readonly type: string
  /** Rendered text, present on the text blocks this plugin returns. */
  readonly text?: string
}

/** Canonical output declaration of a registered tool. */
export interface ToolOutputLike {
  /** Raw JSON Schema enforced against the canonical value. */
  readonly schema: object
  /** Pure projection from arguments and value to model-facing content. */
  render(args: unknown, value: unknown): ContentBlockLike[]
}

/** A registered tool: schema plus body. */
export interface ToolDefinitionLike {
  /** Model-facing tool name. */
  readonly name: string
  /** Model-facing purpose. */
  readonly description: string
  /** Raw JSON Schema of the arguments. */
  readonly parameters: Record<string, unknown>
  /** Canonical output declaration. */
  readonly output: ToolOutputLike
  /**
   * Run one accepted call; the raw definition owns its input validation.
   *
   * The harness passes the execution context (carrying the calling agent and
   * its session) as the second argument.
   */
  execute(args: unknown, exec?: ToolExecLike): Promise<unknown>
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
  on(
    event: 'session/event',
    listener: (session: unknown, event: SessionEventLike) => void,
  ): Disposable
  readonly systemPrompt: {
    section(section: PromptSectionContribution): Disposable
  }
  readonly skills: {
    registerProvider(create: () => SkillProviderLike): Disposable
  }
  readonly tools: {
    register(definition: ToolDefinitionLike): Disposable
  }
  readonly commands: {
    register(definition: CommandDefinitionLike): Disposable
  }
  readonly settings: SettingsServiceLike
  readonly sessionProjections?: SessionProjectionsLike
}

/** Hooks a consumer hands to `settings.installSection`. */
export interface SettingsSectionHooksLike {
  /**
   * Receive the active configuration source: the resolved settings scope while
   * one is attached, the composition entry otherwise. Called before the
   * matching `onChange` at attach and at detach.
   */
  setSource(current: () => unknown): void
  /** Re-judge anything derived from the source after an attach, detach, or commit. */
  onChange(): void
}

/** The slice of the settings service this plugin uses. */
export interface SettingsServiceLike {
  /**
   * Register a namespace with the plugin's composition entry as the `base`
   * layer, falling back to that entry when no provider is mounted.
   */
  installSection(
    owner: unknown,
    namespace: string,
    schema: unknown,
    entry: unknown,
    hooks: SettingsSectionHooksLike,
  ): void
  /**
   * Deep-merge a plain-object patch into the namespace's user layer and persist it.
   * @param namespace - a namespace this plugin registered.
   * @param patch - fields to write; only the user layer is touched.
   */
  update(namespace: string, patch: Record<string, unknown>): Promise<void>
}
