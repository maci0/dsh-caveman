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
import { parse } from 'yaml';
const DELIMITER = /^---[ \t]*$/;
/**
 * Parse leading YAML frontmatter from a markdown document.
 * @param source - full file contents.
 * @returns the parsed keys and the remaining body.
 */
export function parseFrontmatter(source) {
    const text = source.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    if (lines[0] === undefined || !DELIMITER.test(lines[0])) {
        return { data: {}, body: text };
    }
    let closing = -1;
    for (let index = 1; index < lines.length; index += 1) {
        if (DELIMITER.test(lines[index] ?? '')) {
            closing = index;
            break;
        }
    }
    if (closing === -1) {
        return { data: {}, body: text };
    }
    const body = lines.slice(closing + 1).join('\n');
    const parsed = parse(lines.slice(1, closing).join('\n'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { data: {}, body };
    }
    return { data: parsed, body };
}
