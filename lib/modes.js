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
export const RUNTIME_MODES = [
    'off',
    'lite',
    'full',
    'ultra',
    'wenyan-lite',
    'wenyan-full',
    'wenyan-ultra',
];
/** Every accepted level. All caveman levels persist, so this equals {@link RUNTIME_MODES}. */
export const VALID_MODES = RUNTIME_MODES;
/** Level used when neither config nor environment sets one. */
export const DEFAULT_MODE = 'full';
/**
 * Normalize a value to a level that may be persisted as a default.
 * @param value - candidate level from a config field, environment, or command.
 * @returns the canonical runtime level, or `undefined` when unrecognized.
 */
export function normalizeMode(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim().toLowerCase();
    return RUNTIME_MODES.find((mode) => mode === normalized);
}
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
export function isDeactivationCommand(text) {
    const normalized = String(text ?? '').trim().toLowerCase().replace(/[.!?\s]+$/, '');
    return normalized === 'stop caveman' || normalized === 'normal mode';
}
/**
 * Resolve a human `/caveman` argument to a level, including the `wenyan`
 * shorthand for `wenyan-full` (upstream: `/caveman wenyan` means full 文言文).
 * @param input - trimmed, lowercased command input.
 * @returns the canonical level, or `undefined` when unrecognized.
 */
export function normalizeCommandMode(input) {
    if (input === 'wenyan')
        return 'wenyan-full';
    return normalizeMode(input);
}
/**
 * Resolve the level a fresh process starts in.
 *
 * Order: this plugin's config field, then `CAVEMAN_DEFAULT_MODE`, then the
 * upstream config file (`~/.config/caveman/config.json`), then `full`.
 * @param sources - injectable overrides for tests.
 * @returns the resolved startup level.
 */
export function resolveDefaultMode(sources = {}) {
    const configured = normalizeMode(sources.configured);
    if (configured !== undefined)
        return configured;
    const envMode = normalizeMode((sources.env ?? process.env)['CAVEMAN_DEFAULT_MODE']);
    if (envMode !== undefined)
        return envMode;
    const fileMode = normalizeMode(sources.configFile?.defaultMode);
    if (fileMode !== undefined)
        return fileMode;
    return DEFAULT_MODE;
}
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
export function filterSkillBodyForMode(body, mode) {
    const effective = normalizeMode(mode) ?? DEFAULT_MODE;
    return String(body ?? '')
        .split(/\r?\n/)
        .filter((line) => {
        const tableLabel = /^\|\s*\*\*(.+?)\*\*\s*\|/.exec(line);
        if (tableLabel?.[1] !== undefined) {
            const labelMode = normalizeMode(tableLabel[1].trim());
            if (labelMode !== undefined)
                return labelMode === effective;
        }
        const exampleLabel = /^-\s*([^:]+):\s*"/.exec(line);
        if (exampleLabel?.[1] !== undefined) {
            const labelMode = normalizeMode(exampleLabel[1].trim());
            if (labelMode !== undefined)
                return labelMode === effective;
        }
        return true;
    })
        .join('\n');
}
/**
 * Cache of built instruction blocks. The skill body is parsed once at load
 * and the level set is fixed, so at most seven entries ever exist; assembly
 * reads the same block every request instead of re-filtering lines.
 */
const instructionCache = new Map();
/**
 * Build the exact text the system prompt carries for one level.
 * @param input - the active level and the skill body.
 * @returns the instruction block, or `''` when the level is `off`.
 */
export function buildModeInstructions(input) {
    const { mode } = input;
    if (mode === 'off')
        return '';
    const effective = normalizeMode(mode) ?? DEFAULT_MODE;
    const cached = instructionCache.get(effective);
    if (cached !== undefined)
        return cached;
    const built = `CAVEMAN MODE ACTIVE — level: ${effective}\n\n${filterSkillBodyForMode(input.skillBody, effective)}`;
    instructionCache.set(effective, built);
    return built;
}
