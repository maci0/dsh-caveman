/**
 * Structural validation of a compressed file against its original.
 *
 * TypeScript port of `skills/caveman-compress/scripts/validate.py` (MIT,
 * © JuliusBrussee). Same extractors, same six validators, same fail-closed
 * posture: headings/code/URLs/paths/inline-code must survive byte-identical,
 * bullets only warn on drift. The Python original is dropped.
 *
 * @module dsh-caveman/compress-validate
 */
import { maskCodeBlocks } from './compress-rules.js';
const URL_REGEX = /https?:\/\/[^\s)]+/g;
const FENCE_OPEN_REGEX = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_MARKER_LINE_REGEX = /^\s*(?:`{3,}|~{3,})[^`~]*$/;
const HEADING_REGEX = /^(#{1,6})\s+(.*)/gm;
const BULLET_REGEX = /^\s*[-*+]\s+/gm;
/**
 * Path-shaped runs: an absolute/relative prefix plus its body, or a bare
 * `dir/file`.
 *
 * The bare-path branch carries a `(?<![\w.-])` boundary: a mid-run start can
 * never produce a match the run's first character would not already produce
 * (that match is a superset, and leftmost-first wins), so the lookbehind
 * rejects the mid-word starts the engine would otherwise walk suffix by
 * suffix. Match-identical to the greedy form HEAD ships and to the lazy form
 * the previous pass introduced, on 388 inputs: the bench corpus at six sizes,
 * 381 markdown files under the plugin tree and the harness checkout, and one
 * adversarial set of slash-free long words, drive prefixes and mixed
 * separators.
 */
const PATH_REGEX = /(?:\.\/|\.\.\/|\/|[A-Za-z]:\\)[\w\-\/\\.]+|(?<![\w.-])[\w\-.]+[\/\\][\w\-\/\\.]+/g;
const DEFINITE_PATH_REGEX = /^(?:\.\/|\.\.\/|\/|[A-Za-z]:\\)|[^\/\\]*\.[A-Za-z0-9]{1,8}$/;
function invalid(errors, warnings) {
    return { isValid: errors.length === 0, errors, warnings };
}
export function extractHeadings(text) {
    const out = [];
    for (const match of text.matchAll(HEADING_REGEX)) {
        out.push([match[1] ?? '', (match[2] ?? '').trim()]);
    }
    return out;
}
function isFenceClose(line, fenceChar, fenceLen) {
    const close = FENCE_OPEN_REGEX.exec(line);
    const run = close?.[2];
    if (run === undefined)
        return false;
    return run[0] === fenceChar && run.length >= fenceLen && (close?.[3] ?? '').trim() === '';
}
/**
 * Every fenced and indented code block, in document order.
 *
 * The masker already owns the definition of "code block" for the rewriter; the
 * validator reuses it so both agree on what must survive byte-identical.
 * @param text - markdown body.
 * @returns the block texts.
 */
export function extractCodeBlocks(text) {
    return maskCodeBlocks(text).blocks;
}
export function extractUrls(text) {
    return new Set(text.match(URL_REGEX) ?? []);
}
export function extractPaths(text) {
    return new Set(text.match(PATH_REGEX) ?? []);
}
function countBullets(text) {
    return text.match(BULLET_REGEX)?.length ?? 0;
}
export function extractInlineCodes(text) {
    // Blank the fenced/marker lines in place and join once: fence bodies never
    // contribute inline spans, and the join keeps a backtick span that straddles
    // a blanked block byte-identical to the old two-pass form. One walk does both
    // blankings — it opens a span exactly where a forward fence scan would and
    // skips to the closer, then applies the marker test outside a span — instead
    // of collecting span tuples and walking the lines twice.
    const lines = text.split('\n');
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? '';
        const open = FENCE_OPEN_REGEX.exec(line);
        if (open?.[2] !== undefined) {
            const fenceChar = open[2][0] ?? '';
            const fenceLen = open[2].length;
            lines[index] = '';
            index += 1;
            while (index < lines.length) {
                const inner = lines[index] ?? '';
                const closed = isFenceClose(inner, fenceChar, fenceLen);
                lines[index] = '';
                index += 1;
                if (closed)
                    break;
            }
            continue;
        }
        if (line !== '' && FENCE_MARKER_LINE_REGEX.test(line))
            lines[index] = '';
        index += 1;
    }
    return [...lines.join('\n').matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}
function difference(left, right) {
    return new Set([...left].filter((item) => !right.has(item)));
}
/**
 * Element-wise equality of two string lists. Used where the result only needs
 * "same sequence": `JSON.stringify` would be equivalent but materializes two
 * whole serialized documents (thousands of code blocks on a large file) to
 * answer a question a length check and a loop answer with no allocation.
 * @param left - first list.
 * @param right - second list.
 * @returns true when both lists hold the same strings in the same order.
 */
function sameStrings(left, right) {
    if (left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index])
            return false;
    }
    return true;
}
/**
 * Element-wise equality of two heading lists, level and title.
 * @param left - first list.
 * @param right - second list.
 * @returns true when both hold the same pairs in the same order.
 */
function sameHeadings(left, right) {
    if (left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index += 1) {
        const pair = left[index];
        const other = right[index];
        if (pair === undefined || other === undefined || pair[0] !== other[0] || pair[1] !== other[1])
            return false;
    }
    return true;
}
function renderSpans(spans) {
    const rendered = [...spans]
        .map((span) => span.replaceAll('\n', '\\n'))
        .map((flat) => (flat.length > 60 ? `${flat.slice(0, 60)}…` : flat))
        .map((flat) => JSON.stringify(flat))
        .sort();
    return `{${rendered.join(', ')}}`;
}
/**
 * Validate a compressed candidate against its original.
 * @param original - original file text.
 * @param compressed - compressed candidate text.
 * @returns errors (fail-closed) and warnings (drift notes).
 */
export function validate(original, compressed) {
    const errors = [];
    const warnings = [];
    const headingsOriginal = extractHeadings(original);
    const headingsCompressed = extractHeadings(compressed);
    if (headingsOriginal.length !== headingsCompressed.length) {
        errors.push(`Heading count mismatch: ${headingsOriginal.length} vs ${headingsCompressed.length}`);
    }
    else {
        const titlesOriginal = headingsOriginal.map(([, title]) => title);
        const titlesCompressed = headingsCompressed.map(([, title]) => title);
        if (!sameStrings(titlesOriginal, titlesCompressed)) {
            const lost = titlesOriginal.filter((title) => !titlesCompressed.includes(title));
            const added = titlesCompressed.filter((title) => !titlesOriginal.includes(title));
            errors.push(`Heading text/order changed: lost=${JSON.stringify(lost)}, added=${JSON.stringify(added)}`);
        }
        else if (!sameHeadings(headingsOriginal, headingsCompressed)) {
            warnings.push('Heading levels changed');
        }
    }
    const codeOriginal = extractCodeBlocks(original);
    const codeCompressed = extractCodeBlocks(compressed);
    if (!sameStrings(codeOriginal, codeCompressed)) {
        errors.push('Code blocks not preserved exactly');
    }
    const urlsOriginal = extractUrls(original);
    const urlsCompressed = extractUrls(compressed);
    const urlsLost = difference(urlsOriginal, urlsCompressed);
    const urlsAdded = difference(urlsCompressed, urlsOriginal);
    if (urlsLost.size > 0 || urlsAdded.size > 0) {
        errors.push(`URL mismatch: lost=${JSON.stringify([...urlsLost])}, added=${JSON.stringify([...urlsAdded])}`);
    }
    const pathsOriginal = extractPaths(original);
    const pathsCompressed = extractPaths(compressed);
    const pathsLost = difference(pathsOriginal, pathsCompressed);
    const pathsAdded = difference(pathsCompressed, pathsOriginal);
    const definite = [...pathsLost].filter((path) => DEFINITE_PATH_REGEX.test(path));
    if (definite.length > 0)
        errors.push(`File paths lost: ${JSON.stringify(definite.sort())}`);
    const indefinite = [...pathsLost].filter((path) => !DEFINITE_PATH_REGEX.test(path));
    if (indefinite.length > 0 || pathsAdded.size > 0) {
        warnings.push(`Path mismatch: lost=${JSON.stringify([...pathsLost].sort())}, added=${JSON.stringify([...pathsAdded].sort())}`);
    }
    const bulletsOriginal = countBullets(original);
    const bulletsCompressed = countBullets(compressed);
    if (bulletsOriginal > 0 && Math.abs(bulletsOriginal - bulletsCompressed) / bulletsOriginal > 0.15) {
        warnings.push(`Bullet count changed too much: ${bulletsOriginal} -> ${bulletsCompressed}`);
    }
    const codesOriginal = extractInlineCodes(original);
    const codesCompressed = extractInlineCodes(compressed);
    const countOriginal = new Map();
    for (const span of codesOriginal)
        countOriginal.set(span, (countOriginal.get(span) ?? 0) + 1);
    const countCompressed = new Map();
    for (const span of codesCompressed)
        countCompressed.set(span, (countCompressed.get(span) ?? 0) + 1);
    const lostSpans = new Set();
    const addedSpans = new Set();
    for (const [span, count] of countOriginal) {
        const have = countCompressed.get(span) ?? 0;
        if (have < count)
            lostSpans.add(have === 0 ? span : `${span} (lost ${count - have} of ${count} occurrences)`);
    }
    for (const span of countCompressed.keys()) {
        if (!countOriginal.has(span))
            addedSpans.add(span);
    }
    if (lostSpans.size > 0)
        errors.push(`Inline code lost: ${renderSpans(lostSpans)}`);
    if (addedSpans.size > 0)
        warnings.push(`Inline code added: ${renderSpans(addedSpans)}`);
    return invalid(errors, warnings);
}
