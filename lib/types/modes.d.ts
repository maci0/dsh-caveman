/**
 * Caveman's level model: the accepted levels, their normalization, the
 * mode-specific filter over the `caveman` skill body, and the instruction
 * block the plugin injects into the system prompt.
 *
 * Levels mirror upstream (`JuliusBrussee/caveman`, MIT): lite, full, ultra
 * and the three wenyan variants. Unlike ponytail there is no session-only
 * level — every level persists. The one addition over upstream is the
 * `wenyan` shorthand for `wenyan-full`, accepted by the `/caveman` command.
 *
 * @module dsh-caveman/modes
 */
/** Every accepted level; all persist as a default. */
export declare const RUNTIME_MODES: readonly ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra'];
/** Any level the plugin accepts. */
export type CavemanMode = (typeof RUNTIME_MODES)[number];
/** Level used when neither config nor environment sets one. */
export declare const DEFAULT_MODE: CavemanMode;
/**
 * Normalize a value to a level that may be persisted as a default.
 * @param value - candidate level from a config field, environment, or command.
 * @returns the canonical runtime level, or `undefined` when unrecognized.
 */
export declare function normalizeMode(value: unknown): CavemanMode | undefined;
/**
 * Whether a whole message is a deactivation command.
 *
 * "stop caveman" / "normal mode" turn caveman off, but only as a standalone
 * command: matching the phrase anywhere in a message turned it off mid-task for
 * ordinary requests like "add a normal mode toggle", so the whole trimmed
 * message must be the command, ignoring case and trailing punctuation.
 * @param text - user message text.
 * @returns whether the message is the deactivation command.
 */
export declare function isDeactivationCommand(text: string): boolean;
/**
 * Resolve a human `/caveman` argument to a level, including the `wenyan`
 * shorthand for `wenyan-full` (upstream: `/caveman wenyan` means full 文言文).
 * @param input - trimmed, lowercased command input.
 * @returns the canonical level, or `undefined` when unrecognized.
 */
export declare function normalizeCommandMode(input: string): CavemanMode | undefined;
/** Inputs for {@link resolveDefaultMode}, all injectable for tests. */
interface DefaultModeSources {
    /** Deployment default from this plugin's config field; wins over everything. */
    readonly configured?: string | undefined;
    /** Environment lookup; defaults to `process.env`. */
    readonly env?: Record<string, string | undefined> | undefined;
    /** Parsed upstream config file (`~/.config/caveman/config.json`); lowest config priority. */
    readonly configFile?: {
        readonly defaultMode?: unknown;
    } | undefined;
}
/**
 * Resolve the level a fresh process starts in.
 *
 * Order: this plugin's config field, then `CAVEMAN_DEFAULT_MODE`, then the
 * upstream config file (`~/.config/caveman/config.json`), then `full`.
 * @param sources - injectable overrides for tests.
 * @returns the resolved startup level.
 */
export declare function resolveDefaultMode(sources?: DefaultModeSources): CavemanMode;
/**
 * Drop the intensity-table rows and worked examples that belong to other
 * levels.
 *
 * Only the intensity table rows and worked examples are mode-specific, and both
 * are keyed by a level name. A bullet whose label is not a level — e.g.
 * "Never drop not/never/no/only/except ..." — is a normal rule and stays
 * verbatim; the quoted-value requirement on examples is what keeps a rule that
 * merely starts with a level word from being dropped in every other mode.
 * @param body - markdown of the `caveman` skill, frontmatter already removed.
 * @param mode - the level to keep.
 * @returns the body with other levels' rows and examples removed.
 */
export declare function filterSkillBodyForMode(body: string, mode: CavemanMode): string;
/** Inputs for {@link buildModeInstructions}. */
interface InstructionInput {
    /** Active level. */
    readonly mode: CavemanMode;
    /** `skills/caveman/SKILL.md` body with its frontmatter already removed. */
    readonly skillBody: string;
}
/**
 * Build the exact text the system prompt carries for one level.
 * @param input - the active level and the skill body.
 * @returns the instruction block, or `''` when the level is `off`.
 */
export declare function buildModeInstructions(input: InstructionInput): string;
export {};
