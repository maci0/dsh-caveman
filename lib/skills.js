/**
 * The bundled caveman skills as a `ctx.skills` provider.
 *
 * Skills are read from this package's `skills/<name>/SKILL.md`, so the same
 * files stay the single source of truth for both the always-on ruleset (which
 * filters the `caveman` body per level) and the on-demand skills.
 *
 * @module dsh-caveman/skills
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill';
import { parseFrontmatterAsync } from './frontmatter.js';
/** Provider name inside the skill registry. */
const PROVIDER_NAME = 'caveman';
/** Instruction file every skill directory must carry. */
const INSTRUCTION_FILE = 'SKILL.md';
/**
 * Frontmatter keys that already have a first-class home on the summary: they
 * are projected into `name`, `description`, `whenToUse`, and `invocation`, so
 * repeating them in `metadata` would only duplicate the domain model.
 */
const PROJECTED_KEYS = new Set([
    'name',
    'description',
    'whenToUse',
    'disable-model-invocation',
    'user-invocable',
]);
/** Read a frontmatter value as a non-empty trimmed string. */
function readString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/**
 * Read and parse one skill file. Shared by discovery and direct loads so a
 * single file enforces the name/description/frontmatter rules everywhere.
 * @param path - absolute path of the `SKILL.md` file.
 * @param onWarn - optional non-fatal problem sink.
 * @param entryName - directory name fallback when frontmatter omits `name`.
 * @returns the parsed skill, or `undefined` with a warning when invalid.
 */
async function readSkillFile(path, onWarn, entryName) {
    let source;
    try {
        source = await readFile(path, 'utf8');
    }
    catch {
        return undefined;
    }
    let parsed;
    try {
        parsed = await parseFrontmatterAsync(source);
    }
    catch (error) {
        onWarn?.(`skipping ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
    const fallback = entryName ?? basename(path);
    const name = readString(parsed.data['name']) || fallback;
    const description = readString(parsed.data['description']);
    const whenToUse = readString(parsed.data['whenToUse']);
    if (!isSkillName(name)) {
        onWarn?.(`skipping ${path}: "${name}" is not a valid kebab-case skill name`);
        return undefined;
    }
    if (description === '') {
        onWarn?.(`skipping ${path}: frontmatter has no description`);
        return undefined;
    }
    const metadata = {};
    for (const [key, value] of Object.entries(parsed.data)) {
        if (!PROJECTED_KEYS.has(key))
            metadata[key] = value;
    }
    return {
        name,
        description,
        ...(whenToUse === '' ? {} : { whenToUse }),
        // The canonical keys, defaulted the documented way: only an explicit `true`
        // disables model invocation, only an explicit `false` disables user
        // invocation.
        invocation: {
            modelInvocable: parsed.data['disable-model-invocation'] !== true,
            userInvocable: parsed.data['user-invocable'] !== false,
        },
        content: parsed.body.trim(),
        metadata,
        path,
        directory: dirname(path),
    };
}
/**
 * Read every valid skill directory under `skillsDir`.
 *
 * A missing directory, a directory without `SKILL.md`, a file whose frontmatter
 * the reader refuses, and a file with a missing description are reported
 * through `onWarn` and skipped: one broken file must not cost the catalog its
 * other skills.
 * @param skillsDir - directory holding one subdirectory per skill.
 * @param onWarn - optional non-fatal problem sink.
 * @returns the parsed skills, sorted by name.
 */
export async function discoverSkills(skillsDir, onWarn) {
    let entries;
    try {
        entries = await readdir(skillsDir, { withFileTypes: true });
    }
    catch (error) {
        onWarn?.(`cannot read skills directory ${skillsDir}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
    const skills = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const path = join(skillsDir, entry.name, INSTRUCTION_FILE);
        const skill = await readSkillFile(path, onWarn, entry.name);
        if (skill !== undefined)
            skills.push(skill);
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name));
}
/**
 * Build the provider the skill registry mounts.
 * @param options - skills directory and the non-fatal problem sink.
 * @returns a provider whose candidates are summaries and whose bodies come from disk.
 */
export function createSkillProvider(options) {
    const summaryOf = (skill) => ({
        path: skill.path,
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        invocation: skill.invocation,
        source: 'bundled',
        provider: PROVIDER_NAME,
        resourceBase: { kind: 'directory', path: skill.directory },
    });
    return {
        name: PROVIDER_NAME,
        async list(lookup = {}) {
            lookup.signal?.throwIfAborted();
            const skills = await discoverSkills(options.skillsDir, options.onWarn);
            lookup.signal?.throwIfAborted();
            return skills.map((skill) => ({
                ...summaryOf(skill),
                rank: BUNDLED_SKILL_RANK,
                locator: skill.path,
                metadata: skill.metadata,
            }));
        },
        async get(candidate, lookup = {}) {
            if (typeof candidate.locator !== 'string')
                return undefined;
            lookup.signal?.throwIfAborted();
            // Read the locator directly: one file instead of a full re-discovery.
            // The name check keeps a stale candidate (path reused by another skill)
            // from loading under the wrong identity.
            const skill = await readSkillFile(candidate.locator, options.onWarn);
            lookup.signal?.throwIfAborted();
            if (skill === undefined || skill.name !== candidate.name)
                return undefined;
            return { ...summaryOf(skill), content: skill.content, metadata: skill.metadata };
        },
    };
}
