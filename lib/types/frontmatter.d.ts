/**
 * YAML-frontmatter reader for the bundled `SKILL.md` files.
 *
 * The parsing is `yaml`'s (`parse`), the same library upstream's filesystem
 * skill provider depends on, so every valid YAML frontmatter form is read the
 * same way the harness reads it: plain and quoted scalars, `>`/`|` block
 * scalars in all chomping forms, and nested maps.
 *
 * A block that is not a YAML mapping at all (a bare scalar, a sequence, an
 * empty block) yields no keys and keeps the body. A block that is malformed
 * YAML throws, and `readSkillFile` turns that into a warning and a skipped
 * skill: one broken file must not cost the catalog its other skills.
 *
 * @module dsh-caveman/frontmatter
 */
/** Parsed frontmatter plus the markdown body that follows it. */
export interface Frontmatter {
    /** Frontmatter keys and their YAML values (`string`, `boolean`, map, list, …). */
    readonly data: Readonly<Record<string, unknown>>;
    /** Everything after the closing delimiter, or the whole source when absent. */
    readonly body: string;
}
/**
 * Parse leading YAML frontmatter from a markdown document.
 * @param source - full file contents.
 * @returns the parsed keys and the remaining body.
 */
export declare function parseFrontmatter(source: string): Frontmatter;
