/**
 * Detect whether a file is natural language (compressible) or code/config.
 *
 * TypeScript port of `skills/caveman-compress/scripts/detect.py` (MIT,
 * © JuliusBrussee). The Python original is dropped: the ported pipeline runs
 * in-process with no `python3` requirement.
 *
 * @module dsh-caveman/compress-detect
 */
/** Extensions that are natural language and compressible. */
const COMPRESSIBLE_EXTENSIONS = new Set([
    '.md', '.mdc', '.txt', '.markdown', '.rst', '.typ', '.typst', '.tex',
]);
/** Extensions that are code/config and should be skipped. */
const SKIP_EXTENSIONS = new Set([
    '.py', '.js', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml',
    '.toml', '.env', '.lock', '.css', '.scss', '.html', '.xml',
    '.sql', '.sh', '.bash', '.zsh', '.go', '.rs', '.java', '.c',
    '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.kt', '.lua',
    '.dockerfile', '.makefile', '.csv', '.ini', '.cfg',
]);
/** Config extensions report as `config` rather than `code`. */
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env']);
/** Well-known build/config basenames that carry no (or a misleading) extension. */
const KNOWN_CODE_FILENAMES = new Set([
    'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'jenkinsfile',
    'vagrantfile', 'rakefile', 'gemfile', 'justfile', 'procfile', 'brewfile',
    'earthfile', 'fastfile', 'podfile',
    'cmakelists.txt',
]);
/** Patterns that indicate a line is code. */
const CODE_PATTERNS = [
    /^\s*(import |from .+ import |require\(|const |let |var )/,
    /^\s*(def |class |function |async function |export )/,
    /^\s*(if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{)/,
    /^\s*[}\]\);]+\s*$/,
    /^\s*@\w+/,
    /^\s*"[^"]+"\s*:\s*/,
    /^\s*\w+\s*=\s*[{[(["']/,
];
function isCodeLine(line) {
    return CODE_PATTERNS.some((pattern) => pattern.test(line));
}
function isJsonContent(text) {
    try {
        JSON.parse(text);
        return true;
    }
    catch {
        return false;
    }
}
function isYamlContent(lines) {
    let indicators = 0;
    for (const line of lines.slice(0, 30)) {
        const stripped = line.trim();
        if (stripped.startsWith('---'))
            indicators += 1;
        else if (/^\w[\w\s]*:\s/.test(stripped))
            indicators += 1;
        else if (stripped.startsWith('- ') && stripped.includes(':'))
            indicators += 1;
    }
    const nonEmpty = lines.slice(0, 30).filter((line) => line.trim() !== '').length;
    return nonEmpty > 0 && indicators / nonEmpty > 0.6;
}
function extensionOf(basename) {
    const dot = basename.lastIndexOf('.');
    return dot <= 0 ? '' : basename.slice(dot).toLowerCase();
}
/**
 * Classify a file as natural language, code, config, or unknown.
 * @param basename - file basename (extension rules key off this).
 * @param readText - reads the file when content sniffing is needed; throw to signal unreadable.
 * @returns the classification.
 */
export function detectFileType(basename, readText) {
    const name = basename.toLowerCase();
    const ext = extensionOf(basename);
    if (KNOWN_CODE_FILENAMES.has(name))
        return 'code';
    if (COMPRESSIBLE_EXTENSIONS.has(ext))
        return 'natural_language';
    if (SKIP_EXTENSIONS.has(ext))
        return CONFIG_EXTENSIONS.has(ext) ? 'config' : 'code';
    if (ext === '') {
        let text;
        try {
            if (readText === undefined)
                return 'unknown';
            text = readText();
        }
        catch {
            return 'unknown';
        }
        const lines = text.split('\n').slice(0, 50);
        if (text.startsWith('#!'))
            return 'code';
        if (isJsonContent(text.slice(0, 10000)))
            return 'config';
        if (isYamlContent(lines))
            return 'config';
        const nonEmpty = lines.filter((line) => line.trim() !== '');
        const codeLines = nonEmpty.filter(isCodeLine).length;
        if (nonEmpty.length > 0 && codeLines / nonEmpty.length > 0.4)
            return 'code';
        return 'natural_language';
    }
    return 'unknown';
}
/**
 * Whether the file should be compressed: it exists and is natural language.
 * Backup files are never recompressed.
 * @param basename - file basename.
 * @param isFile - whether the path is a file.
 * @param readText - content reader for extensionless sniffing.
 * @returns true when compression applies.
 */
export function shouldCompress(basename, isFile, readText) {
    if (!isFile)
        return false;
    if (basename.endsWith('.original.md'))
        return false;
    return detectFileType(basename, readText) === 'natural_language';
}
