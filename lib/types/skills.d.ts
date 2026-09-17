/**
 * The bundled caveman skills as a `ctx.skills` provider.
 *
 * Skills are read from this package's `skills/<name>/SKILL.md`, so the same
 * files stay the single source of truth for both the always-on ruleset (which
 * filters the `caveman` body per level) and the on-demand skills.
 *
 * @module dsh-caveman/skills
 */
import type { SkillInvocationPolicyLike, SkillProviderLike } from './host.ts';
/** One parsed bundled skill. */
export interface CavemanSkill {
    /** Kebab-case skill name from frontmatter, or the directory name. */
    readonly name: string;
    /** Routing description from frontmatter. */
    readonly description: string;
    /** Optional extra routing guidance from `whenToUse`. */
    readonly whenToUse?: string;
    /** Resolved invocation controls from the two canonical frontmatter keys. */
    readonly invocation: SkillInvocationPolicyLike;
    /** Instruction body with frontmatter removed. */
    readonly content: string;
    /** Frontmatter keys this provider does not project (`license`, `tools`, …). */
    readonly metadata: Readonly<Record<string, unknown>>;
    /** Absolute path of the instruction file. */
    readonly path: string;
    /** Absolute path of the skill directory, used as the resource base. */
    readonly directory: string;
}
/** Options for {@link createSkillProvider}. */
export interface SkillProviderOptions {
    /** Directory holding one subdirectory per skill. */
    readonly skillsDir: string;
    /** Receives non-fatal discovery problems instead of throwing. */
    readonly onWarn?: (message: string) => void;
}
/**
 * Read and parse one skill file. Shared by discovery and direct loads so a
 * single file enforces the name/description/frontmatter rules everywhere.
 * @param path - absolute path of the `SKILL.md` file.
 * @param onWarn - optional non-fatal problem sink.
 * @param entryName - directory name fallback when frontmatter omits `name`.
 * @returns the parsed skill, or `undefined` with a warning when invalid.
 */
export declare function readSkillFile(path: string, onWarn?: (message: string) => void, entryName?: string): Promise<CavemanSkill | undefined>;
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
export declare function discoverSkills(skillsDir: string, onWarn?: (message: string) => void): Promise<readonly CavemanSkill[]>;
/**
 * Build the provider the skill registry mounts.
 * @param options - skills directory and the non-fatal problem sink.
 * @returns a provider whose candidates are summaries and whose bodies come from disk.
 */
export declare function createSkillProvider(options: SkillProviderOptions): SkillProviderLike;
