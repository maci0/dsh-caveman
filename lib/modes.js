/**
 * Caveman's level model: the accepted levels, their normalization, the
 * mode-specific filter over the `caveman` skill body, and the instruction
 * block the plugin injects into the system prompt.
 *
 * Levels mirror upstream (`JuliusBrussee/caveman`, MIT): lite, full, ultra
 * and the three wenyan variants. Unlike ponytail there is no session-only
 * level: every level persists. The one addition over upstream is the
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
/** Characters that survive `trim()` but are invisible in an input box. */
const INVISIBLE_INPUT = /[\u200b-\u200d\u2060\ufeff\u00a0]/g;
/** Collapse case, invisible characters, and whitespace into one token. */
function cleanCommandInput(input) {
    return String(input ?? '')
        .replace(INVISIBLE_INPUT, ' ')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}
/**
 * Resolve a human `/caveman` argument to a level, including the `wenyan`
 * shorthand for `wenyan-full` (upstream: `/caveman wenyan` means full 文言文).
 *
 * The input is cleaned first: zero-width characters and non-breaking spaces are
 * invisible in a chat box but would otherwise make an exact match fail, and the
 * hyphenated level is also accepted with a space or underscore separator.
 * @param input - raw command input.
 * @returns the canonical level, or `undefined` when unrecognized.
 */
export function normalizeCommandMode(input) {
    const cleaned = cleanCommandInput(input);
    if (cleaned === 'wenyan')
        return 'wenyan-full';
    return normalizeMode(cleaned) ?? normalizeMode(cleaned.replace(/[\s_]+/g, '-'));
}
/**
 * Split a `/caveman` argument into the level it names and the text after it.
 *
 * The command box sends everything after `/caveman` as one string, so a human
 * who types `/caveman ultra explain this` means "set ultra" and then a message.
 * The whole argument is tried first (the accepted spellings normalize as one
 * value); failing that, the longest leading run of words that still names a
 * level wins, so multi-word spellings (`wenyan full`) and the two-word
 * deactivation phrases (`normal mode`, `stop caveman`) beat their prefixes.
 * @param input - raw command input.
 * @returns the level and the untouched remaining text, or `undefined` when no
 * level leads the argument.
 */
export function splitModeCommand(input) {
    const trimmed = String(input ?? '').replace(INVISIBLE_INPUT, ' ').trim();
    if (trimmed === '')
        return undefined;
    if (isDeactivationCommand(trimmed))
        return { mode: 'off', rest: '' };
    const whole = normalizeCommandMode(trimmed);
    if (whole !== undefined)
        return { mode: whole, rest: '' };
    const words = trimmed.split(/\s+/).filter(Boolean);
    for (let count = Math.min(words.length, 3); count > 0; count -= 1) {
        const candidate = words.slice(0, count).join(' ');
        if (isDeactivationCommand(candidate))
            return { mode: 'off', rest: words.slice(count).join(' ') };
        const mode = normalizeCommandMode(candidate);
        if (mode !== undefined)
            return { mode, rest: words.slice(count).join(' ') };
    }
    return undefined;
}
/**
 * Resolve the configured level and the source that decided it.
 *
 * Order: this plugin's config field, then `CAVEMAN_DEFAULT_MODE`, then the
 * upstream config file (`~/.config/caveman/config.json`), then `full`.
 * @param sources - injectable overrides for tests.
 * @returns the level and its source.
 */
export function resolveDefaultMode(sources = {}) {
    const configured = normalizeMode(sources.configured);
    if (configured !== undefined)
        return { mode: configured, source: 'settings' };
    const envMode = normalizeMode((sources.env ?? process.env)['CAVEMAN_DEFAULT_MODE']);
    if (envMode !== undefined)
        return { mode: envMode, source: 'env' };
    const fileMode = normalizeMode(sources.configFile?.defaultMode);
    if (fileMode !== undefined)
        return { mode: fileMode, source: 'config-file' };
    return { mode: DEFAULT_MODE, source: 'default' };
}
/**
 * Drop the intensity-table rows and worked examples that belong to other
 * levels.
 *
 * Only the intensity table rows and worked examples are mode-specific, and both
 * are keyed by a level name. A bullet whose label is not a level (e.g.
 * "Never drop not/never/no/only/except ...") is a normal rule and stays
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
 * Build the exact text the system prompt carries for one level.
 * @param input - the active level and the skill body.
 * @returns the instruction block, or `''` when the level is `off`.
 */
export function buildModeInstructions(input) {
    const { mode } = input;
    if (mode === 'off')
        return '';
    const effective = normalizeMode(mode) ?? DEFAULT_MODE;
    return `CAVEMAN MODE ACTIVE — level: ${effective}\n\n${filterSkillBodyForMode(input.skillBody, effective)}`;
}
