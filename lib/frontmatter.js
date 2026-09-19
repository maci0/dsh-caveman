/**
 * Frontmatter reader for the bundled `SKILL.md` files and the compress
 * pipeline.
 *
 * The fast path is a local reader for the flat subset those files use:
 * `key: value` with a plain, single-quoted, or double-quoted scalar, and `>`/`|`
 * block scalars in all three chomping forms. It claims only forms it can prove
 * — a nested map, a list, a flow collection, a key form it does not recognise,
 * or any other shape it is not sure about falls through to `yaml`.
 *
 * "Prove" is the whole contract, so the claimed subset is deliberately narrow:
 * every line of the block must be a blank line, a column-0 comment, or
 * `SIMPLE_KEY: value` with a key the YAML core schema leaves a string and no
 * repeated key; a block that is anything else (a bare scalar, a sequence, an
 * explicit `?` key, an indented continuation) is refused rather than guessed.
 * {@link NON_STRING} is the YAML core schema's own resolution set copied out of
 * `yaml/dist/schema/core`, so a value it does not match is provably a string,
 * and a value it does match falls back instead of being read as one.
 *
 * The fallback is the contract, not an afterthought: `yaml` is never imported
 * at module scope, so a catalog of flat files (every bundled skill) never pays
 * the library's module-load cost. {@link parseFrontmatterAsync} loads it with a
 * dynamic `import('yaml')`; the synchronous {@link parseFrontmatter} loads it
 * with a lazy `createRequire` for the callers that cannot await.
 *
 * Behaviour matches the previous `yaml`-only reader: a block that is not a YAML
 * mapping at all (a bare scalar, a sequence, an empty block) yields no keys and
 * keeps the body, and a block that is malformed YAML throws, which
 * `readSkillFile` turns into a warning and a skipped skill.
 *
 * @module dsh-caveman/frontmatter
 */
import { createRequire } from 'node:module';
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** The only key form the fast path claims to understand. */
const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/**
 * The plain scalars the YAML core schema resolves to something other than a
 * string.
 *
 * This is the union of the core schema's own tests, copied from
 * `yaml/dist/schema/core` (`int`, `intOct`, `intHex`, `float`, `floatExp`,
 * `floatNaN`, `bool`, `null`). A plain scalar that matches none of them is
 * provably a `tag:yaml.org,2002:str`, which is the only thing the fast path may
 * read as one. Anything it does match — including leading-zero integers such as
 * `01`, which the schema's bare `[-+]?[0-9]+` reads as `1` — falls back.
 */
const NON_STRING = /^(?:~|[Nn]ull|NULL|[Tt]rue|TRUE|[Ff]alse|FALSE|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+(?:[eE][-+]?[0-9]+)?|[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?|[0-9]+[eE][-+]?[0-9]+)|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
/** Line starts that make a block something other than a plain scalar. */
const INDICATOR = '#,[]{}&*!|>\'"%@`';
/**
 * Characters `String.prototype.trim` strips that YAML does not count as
 * whitespace, so it keeps them as content.
 *
 * YAML's separation space is only space and tab. Every other code point below
 * is content to `yaml` but blank to `trim`/`trimStart`, which is enough to move
 * a block scalar's indentation (`description: |` followed by `\uFEFFname: x` is
 * a key to `yaml`, not body text) or to hide trailing text after a closing
 * quote. Any line carrying one falls back rather than being read either way.
 */
const JS_ONLY_SPACE = /[\v\f\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;
let syncYaml;
let asyncYaml;
/**
 * Load `yaml` synchronously. Only reached by a block the fast path refused, so
 * a catalog of flat files never gets here.
 */
function loadYamlSync() {
    if (syncYaml === undefined) {
        const require = createRequire(import.meta.url);
        syncYaml = require('yaml');
    }
    return syncYaml;
}
/**
 * Load `yaml` with a dynamic import, cached for later fallbacks.
 */
function loadYaml() {
    asyncYaml ??= import('yaml');
    return asyncYaml;
}
/** Add one key without letting a `__proto__` key reach the prototype. */
function define(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
/** Read a `"…"` scalar, or `undefined` when YAML could read the text differently. */
function readDoubleQuoted(text) {
    let out = '';
    let index = 1;
    while (index < text.length) {
        const char = text[index];
        if (char === '"') {
            if (text.slice(index + 1).trim() !== '')
                return undefined;
            return out;
        }
        if (char === '\\') {
            const escape = text[index + 1];
            if (escape === '\\' || escape === '"')
                out += escape;
            else if (escape === 'n')
                out += '\n';
            else if (escape === 't')
                out += '\t';
            else if (escape === 'r')
                out += '\r';
            else if (escape === '0')
                out += '\0';
            else
                return undefined;
            index += 2;
            continue;
        }
        out += char;
        index += 1;
    }
    return undefined;
}
/** Read a `'…'` scalar, or `undefined` when YAML could read the text differently. */
function readSingleQuoted(text) {
    let out = '';
    let index = 1;
    while (index < text.length) {
        const char = text[index];
        if (char === "'") {
            if (text[index + 1] === "'") {
                out += "'";
                index += 2;
                continue;
            }
            if (text.slice(index + 1).trim() !== '')
                return undefined;
            return out;
        }
        out += char;
        index += 1;
    }
    return undefined;
}
/** Read a plain scalar, or `undefined` when YAML could resolve it to anything else. */
function readPlain(text) {
    if (text === '' || NON_STRING.test(text))
        return undefined;
    if (text.includes('\t') || text.includes(': ') || text.endsWith(':'))
        return undefined;
    if (text.includes(' #'))
        return undefined;
    for (const char of '[]{}')
        if (text.includes(char))
            return undefined;
    if (INDICATOR.includes(text[0] ?? ''))
        return undefined;
    const first = text[0];
    if ((first === '-' || first === '?' || first === ':') && (text.length === 1 || text[1] === ' '))
        return undefined;
    return text;
}
/** Read one inline value: block-scalar header, quoted scalar, or plain scalar. */
function readInline(text, lines, index) {
    const header = /^([|>])([+-]?)$/.exec(text);
    if (header !== null)
        return readBlockScalar(lines, index, header[1] === '>', header[2] ?? '');
    if (text.startsWith('"')) {
        const value = readDoubleQuoted(text);
        return value === undefined ? undefined : { value, next: index + 1 };
    }
    if (text.startsWith("'")) {
        const value = readSingleQuoted(text);
        return value === undefined ? undefined : { value, next: index + 1 };
    }
    const value = readPlain(text);
    return value === undefined ? undefined : { value, next: index + 1 };
}
function foldLines(core) {
    let out = '';
    let blanks = 0;
    for (const line of core) {
        if (line === '') {
            blanks += 1;
            continue;
        }
        if (out === '')
            out = line;
        else
            out += (blanks === 0 ? ' ' : '\n'.repeat(blanks)) + line;
        blanks = 0;
    }
    return out;
}
/**
 * Read a `>`/`|` block scalar starting after its header line.
 * @param folded - `true` for `>`, `false` for `|`.
 * @param chomp - `''` (clip), `'-'` (strip), or `'+'` (keep).
 * @returns the scalar and the index after the block, or `undefined` when unsure.
 */
function readBlockScalar(lines, headerIndex, folded, chomp) {
    const content = [];
    let indent = -1;
    let index = headerIndex + 1;
    for (; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === '') {
            content.push('');
            continue;
        }
        // A whitespace-only line is blank to YAML but its residual spaces are
        // content, and a line that is only spaces is not provably one or the other.
        if (line.trim() === '')
            return undefined;
        if (line.includes('\t') || /[ ]$/.test(line))
            return undefined;
        const lead = line.length - line.trimStart().length;
        if (indent === -1) {
            if (lead === 0)
                break;
            indent = lead;
        }
        else if (lead < indent) {
            break;
        }
        else if (lead > indent) {
            return undefined;
        }
        content.push(line.slice(indent));
    }
    let trailing = 0;
    while (content.length > trailing && content[content.length - 1 - trailing] === '')
        trailing += 1;
    const core = content.slice(0, content.length - trailing);
    if (core[0] === '')
        return undefined;
    const body = folded ? foldLines(core) : core.join('\n');
    if (core.length === 0)
        return { value: chomp === '+' ? '\n'.repeat(trailing) : '', next: index };
    if (chomp === '-')
        return { value: body, next: index };
    if (chomp === '+')
        return { value: body + '\n'.repeat(trailing + 1), next: index };
    return { value: `${body}\n`, next: index };
}
/**
 * Parse a frontmatter block the fast path can prove it understands.
 *
 * The claim is `SIMPLE_KEY: value` for every non-blank, non-comment line, with
 * a unique key the core schema leaves a string and a value {@link readInline}
 * accepts. Every other shape — a bare scalar, a sequence, an explicit `?` key,
 * an indented line, a whitespace-only line — returns `undefined` so the caller
 * runs the real parser. A block of nothing but blanks and comments is the one
 * non-mapping shape still claimed: `yaml` resolves it to `null`, which the
 * reader reports as no keys.
 * @returns the keys, or `undefined` when the caller must fall back to `yaml`.
 */
function parseFlat(block) {
    const lines = block.split(/\r\n|\n/);
    // The block never ends with the line terminator it was cut at: a trailing
    // '\n' terminates its last line rather than opening a blank one.
    if (block.endsWith('\n'))
        lines.pop();
    // A bare '\r' is a line break `yaml` may fold in ways this reader does not,
    // and a non-YAML space would make `trim` disagree with `yaml` about content.
    if (JS_ONLY_SPACE.test(block))
        return undefined;
    for (const line of lines)
        if (line.includes('\r'))
            return undefined;
    const data = {};
    let mapping = false;
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (line === '') {
            index += 1;
            continue;
        }
        // Whitespace-only lines are not provably equivalent to empty ones here.
        if (line.trim() === '')
            return undefined;
        if (line.startsWith('#')) {
            index += 1;
            continue;
        }
        const colon = line.indexOf(':');
        const key = colon === -1 ? '' : line.slice(0, colon);
        const spaced = colon !== -1 && (line[colon + 1] === ' ' || line[colon + 1] === '\t');
        // A key the core schema resolves to a bool or null lands in the object
        // under a different name, and a repeated key makes `yaml` throw.
        if (key === '' || !SIMPLE_KEY.test(key) || NON_STRING.test(key) || !spaced)
            return undefined;
        if (Object.hasOwn(data, key))
            return undefined;
        mapping = true;
        const read = readInline(line.slice(colon + 1).trim(), lines, index);
        if (read === undefined)
            return undefined;
        define(data, key, read.value);
        index = read.next;
    }
    return mapping ? data : {};
}
function splitFrontmatter(source) {
    const text = source.replace(/^\uFEFF/, '');
    const match = FRONTMATTER_BLOCK.exec(text);
    if (match === null)
        return { raw: '', block: '', body: text, present: false };
    const raw = match[0];
    // The body keeps its own bytes apart from line terminators, which are
    // normalized the way the previous line-split reader normalized them.
    return { raw, block: match[1] ?? '', body: text.slice(raw.length).replace(/\r\n/g, '\n'), present: true };
}
function fromParsed(raw, body, parsed) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { raw, data: {}, body };
    }
    return { raw, data: parsed, body };
}
/**
 * Parse leading YAML frontmatter from a markdown document.
 *
 * For callers that cannot await. A block the fast path refuses loads `yaml`
 * synchronously; use {@link parseFrontmatterAsync} on paths where deferring the
 * library to a dynamic import matters.
 * @param source - full file contents.
 * @returns the verbatim block, the parsed keys, and the remaining body.
 */
export function parseFrontmatter(source) {
    const parts = splitFrontmatter(source);
    if (!parts.present)
        return { raw: '', data: {}, body: parts.body };
    const flat = parseFlat(parts.block);
    return fromParsed(parts.raw, parts.body, flat ?? loadYamlSync().parse(parts.block));
}
/**
 * Parse leading YAML frontmatter, loading `yaml` with a dynamic import only
 * when the fast path refuses the block.
 * @param source - full file contents.
 * @returns the verbatim block, the parsed keys, and the remaining body.
 */
export async function parseFrontmatterAsync(source) {
    const parts = splitFrontmatter(source);
    if (!parts.present)
        return { raw: '', data: {}, body: parts.body };
    const flat = parseFlat(parts.block);
    if (flat !== undefined)
        return fromParsed(parts.raw, parts.body, flat);
    const { parse } = await loadYaml();
    return fromParsed(parts.raw, parts.body, parse(parts.block));
}
