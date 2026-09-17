/**
 * dsh-caveman — Caveman terse-talk mode, as a DeepSeek Harness plugin.
 *
 * Four capabilities, all mounted through public Cordis extension points:
 *
 * - the bundled skills (`caveman`, `cavecrew`, `-commit`, `-review`,
 *   `-compress`, `-stats`, `-help`, plus six work patterns) become one
 *   `ctx.skills` provider;
 * - while a level other than `off` is active, the mode-filtered ruleset is
 *   contributed to the system prompt on every assembly;
 * - the level is switchable from the model (`caveman` tool) and the human
 *   (`/caveman` command);
 * - the `caveman` settings namespace makes the level persistent and pairs with
 *   this package's browser half, which renders the card in the Web client's
 *   Plugins → Plugin configuration tab.
 *
 * Skill content is adapted from the reference implementation
 * (https://github.com/JuliusBrussee/caveman, MIT, © JuliusBrussee). Only the
 * skill (talking-style) half is ported: the proxy, CLI verbs, and Cloud
 * engine need an external runtime the harness has no extension point for.
 *
 * @module dsh-caveman
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildModeInstructions, DEFAULT_MODE, isDeactivationCommand, normalizeCommandMode, normalizeMode, resolveDefaultMode, RUNTIME_MODES, VALID_MODES, } from './modes.js';
import { createSkillProvider } from './skills.js';
import { compressFile } from './compress-pipeline.js';
import { MAX_FILE_SIZE, setBackupRootOverride } from './compress-files.js';
import { parseFrontmatter } from './frontmatter.js';
/** Plugin name as it appears in the loader. */
export const name = 'caveman';
/**
 * Settings namespace the browser card edits — the join key between this host
 * half and `lib/client.js`. The card registers into `settings.plugin.item`
 * under the same key, and the tab pairs the two without knowing what it means.
 */
export const CAVEMAN_SETTINGS_NAMESPACE = 'caveman';
/** Persisted configuration. Every caveman level persists; there is no session-only level. */
export const CavemanSettings = z.object({
    mode: z.union([...RUNTIME_MODES]).default(DEFAULT_MODE),
    compressBackupDir: z.string().default(''),
});
/** Row schema: the accepted levels and the size cap live here. */
export const Config = z.object({
    defaultMode: z.union([...RUNTIME_MODES]),
    maxFileSize: z.number().default(MAX_FILE_SIZE),
});
/** Upstream config file, read the way upstream reads it. */
const UPSTREAM_CONFIG_PATH = join(homedir(), '.config', 'caveman', 'config.json');
/**
 * Read the upstream config file's `defaultMode`, ignoring everything that
 * would make startup fail: a missing file, an unreadable file, invalid JSON,
 * or a non-object document all mean "no file default".
 * @param path - config file path; the upstream location unless tests override it.
 * @returns the parsed document, or `undefined` when there is nothing usable.
 */
export function readUpstreamConfigFile(path = UPSTREAM_CONFIG_PATH) {
    let source;
    try {
        if (!existsSync(path))
            return undefined;
        source = readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    return parsed;
}
/**
 * Mount the plugin.
 * @param ctx - the host context.
 * @param config - optional row configuration.
 */
export function apply(ctx, config = {}) {
    // Reject configuration that would silently do the wrong thing.
    if (config.defaultMode !== undefined && normalizeMode(config.defaultMode) === undefined) {
        throw new Error(`[caveman] defaultMode must be one of ${RUNTIME_MODES.join(', ')}; got ${JSON.stringify(config.defaultMode)}`);
    }
    const maxFileSize = config.maxFileSize ?? MAX_FILE_SIZE;
    if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) {
        throw new Error(`[caveman] maxFileSize must be a positive number of bytes; got ${JSON.stringify(config.maxFileSize)}`);
    }
    // `<package>/skills`, resolved from this module's own location.
    const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
    const startup = resolveDefaultMode({
        configured: config.defaultMode,
        configFile: readUpstreamConfigFile(),
    });
    // Parsed once, at load: the ruleset is filtered per assembly, so the
    // frontmatter must not have to be re-read for every request. A missing body
    // means a broken install: fail while loading rather than injecting a silently
    // truncated ruleset.
    const skillBody = parseFrontmatter(readFileSync(join(skillsDir, 'caveman', 'SKILL.md'), 'utf8')).body.trimStart();
    const warn = (message) => {
        console.warn(`[caveman] ${message}`);
    };
    /** Session-local level, used when the settings document cannot hold the write. */
    let override;
    /** Authoritative configuration source: the settings scope once attached, else the row. */
    let source = () => ({ mode: startup });
    let settings;
    const configuredMode = () => {
        const value = source();
        if (value === null || typeof value !== 'object')
            return undefined;
        return normalizeMode(value.mode);
    };
    /** Sync the backup-dir override from settings before each compress run. */
    const syncBackupDir = () => {
        const value = source();
        const dir = value !== null && typeof value === 'object'
            ? value.compressBackupDir
            : undefined;
        setBackupRootOverride(typeof dir === 'string' ? dir : '');
    };
    const activeMode = () => override ?? configuredMode() ?? startup;
    /**
     * Persist a level through the settings document; false when it cannot hold it.
     * @param next - the level to write.
     * @param signal - cancels the write when the calling tool was cancelled.
     */
    const persist = async (next, signal) => {
        if (settings === undefined || normalizeMode(next) === undefined)
            return false;
        signal?.throwIfAborted();
        let persisted;
        try {
            await settings.update(CAVEMAN_SETTINGS_NAMESPACE, { mode: next });
            persisted = true;
        }
        catch (error) {
            warn(`could not persist level "${next}": ${error instanceof Error ? error.message : String(error)}`);
            persisted = false;
        }
        // Outside the try: an abort is not a persistence failure to be swallowed.
        signal?.throwIfAborted();
        return persisted;
    };
    const setMode = async (next, signal) => {
        const previous = activeMode();
        override = (await persist(next, signal)) ? undefined : next;
        const mode = activeMode();
        return { previous, mode, changed: mode !== previous };
    };
    /**
     * Turn the level off because the human's own message was a deactivation
     * command.
     *
     * The override is set before the settings write is awaited: the durable
     * `user/message` event arrives before the turn's prompt is assembled, and
     * awaiting the document would let that same turn assemble with the ruleset
     * still injected — the one turn the user just asked to end. A committed
     * document then becomes the source of truth again, so the card and the
     * prompt cannot disagree.
     */
    const deactivateFromMessage = () => {
        if (activeMode() === 'off')
            return;
        override = 'off';
        void persist('off').then((persisted) => {
            if (persisted)
                override = undefined;
        });
    };
    ctx.inject(['settings'], (scope) => {
        settings = scope.settings;
        settings.installSection(ctx, CAVEMAN_SETTINGS_NAMESPACE, CavemanSettings, { mode: startup, compressBackupDir: '' }, {
            setSource: (current) => {
                source = current;
            },
            // Fires at attach and after every committed change. A settings change
            // supersedes a session-local override; the ruleset itself is re-read at
            // each assembly, so there is nothing else to re-judge here.
            onChange: () => {
                override = undefined;
            },
        });
    });
    ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
            name: 'caveman',
            order: 700, // after the persona prefix, before tool guidance
            // Evaluated at each assembly, so a level change lands on the next request.
            // `off` returns empty text, which assembly drops.
            text: () => buildModeInstructions({ mode: activeMode(), skillBody }),
        });
    });
    ctx.inject(['skills'], (scope) => {
        scope.skills.registerProvider(() => createSkillProvider({ skillsDir, onWarn: warn }));
    });
    ctx.inject(['tools'], (scope) => {
        scope.tools.register(createModeTool(activeMode, setMode, (exec) => readSessionUsage(scope, exec)));
        scope.tools.register(createCompressTool(syncBackupDir, maxFileSize));
    });
    ctx.inject(['commands'], (scope) => {
        scope.commands.register({
            name: 'caveman',
            description: '🪨 Set the caveman level (lite, full, ultra, wenyan-*, off) or report the current one.',
            input: { hint: 'lite | full | ultra | wenyan-lite | wenyan-full | wenyan-ultra | off' },
            handler: async (invocation) => handleModeCommand(invocation, activeMode, setMode),
        });
        scope.commands.register({
            name: 'caveman-compress',
            description: '🗜 Compress a memory file with local rules (backup kept).',
            input: { hint: '<filepath>' },
            handler: async (invocation) => handleCompressCommand(invocation, syncBackupDir, maxFileSize),
        });
    });
    // "stop caveman" / "normal mode" typed as an ordinary message, given the
    // same effect as `/caveman off`. The command path is unaffected: this only
    // claims messages that are exactly the command and come from the human.
    ctx.on('session/event', (_session, event) => {
        if (event.type !== 'user/message')
            return;
        const text = userMessageText(event.data);
        if (text === undefined || !isDeactivationCommand(text))
            return;
        deactivateFromMessage();
    });
}
/**
 * Read the plain text of a genuine user message.
 *
 * Injected context (skill bodies, file references, replayed history) rides the
 * same event stream, so a message only counts when the harness marks it as the
 * user's own; an injected instruction that happened to read "normal mode" must
 * never toggle the level.
 * @param data - the `user/message` event payload.
 * @returns the concatenated text blocks, or `undefined` when this is not the
 * human's own text.
 */
function userMessageText(data) {
    if (data === null || typeof data !== 'object')
        return undefined;
    const message = data;
    if (message.source?.kind !== 'user')
        return undefined;
    if (!Array.isArray(message.content))
        return undefined;
    const text = message.content
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('\n');
    return text.trim() === '' ? undefined : text;
}
/**
 * Read this session's cumulative provider-reported usage through the
 * token-meter `tokenUsage` projection, when the host mounts it.
 *
 * Counts only what the provider reported — never a saving, a percentage, or
 * a cost. `undefined` when the service, the session, or the unit is absent.
 * @param scope - the tools-callback scope, which may carry `sessionProjections`.
 * @param exec - the tool execution, carrying the calling agent's session.
 * @returns the usage totals, or `undefined`.
 */
function readSessionUsage(scope, exec) {
    const projections = scope.sessionProjections;
    const session = exec?.agent?.session;
    if (projections === undefined || session === undefined)
        return undefined;
    let state;
    try {
        state = projections.stateOf(session, 'tokenUsage');
    }
    catch {
        return undefined;
    }
    const totals = state?.totals;
    if (totals === undefined)
        return undefined;
    // The unit's own bucket names, mapped to this plugin's labels.
    return {
        input: totals.uncachedInputTokens ?? 0,
        output: totals.outputTokens ?? 0,
        cacheRead: totals.cacheReadTokens ?? 0,
        cacheWrite: totals.cacheWriteTokens ?? 0,
    };
}
/**
 * Build the model-facing level tool.
 * @param getMode - reads the active level.
 * @param setMode - applies and persists a level.
 * @param getUsage - reads this session's provider-reported usage, when available.
 * @returns the registered tool definition.
 */
function createModeTool(getMode, setMode, getUsage) {
    return defineTool({
        name: 'caveman',
        // The `enum` below already names every level, and the injected ruleset
        // explains what each one does; repeating both here only costs tokens.
        description: 'Set or report the caveman level, which governs how terse replies are. '
            + 'The level persists in the user settings document. '
            + 'Call with no arguments to report the current level. '
            + 'A per-call `mode` applies to this call only and is not persisted.',
        parameters: {
            mode: {
                type: 'string',
                enum: [...VALID_MODES],
                description: 'Level to activate and persist. Omit to report the current level.',
            },
            once: {
                type: 'string',
                enum: [...VALID_MODES.filter((mode) => mode !== 'off')],
                description: 'Level for this call only. Not persisted; `mode` wins when both are given.',
            },
            usage: {
                type: 'boolean',
                description: 'Include this session’s provider-reported token totals (input, output, cache read/write). Never a saving.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    mode: { type: 'string', enum: [...VALID_MODES], required: true },
                    previous: { type: 'string', enum: [...VALID_MODES], required: true },
                    changed: { type: 'boolean', required: true },
                    active: { type: 'boolean', required: true },
                    once: { type: 'string', enum: [...VALID_MODES.filter((mode) => mode !== 'off')] },
                    usage: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            input: { type: 'number', required: true },
                            output: { type: 'number', required: true },
                            cacheRead: { type: 'number', required: true },
                            cacheWrite: { type: 'number', required: true },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderModeResult(value) }],
        },
        async execute(args, exec) {
            // A cancelled call must not start, and must not persist a level it can
            // no longer report.
            exec?.signal?.throwIfAborted();
            const once = args.once;
            const previous = getMode();
            if (args.mode === undefined) {
                return {
                    mode: once ?? previous,
                    previous,
                    changed: false,
                    active: (once ?? previous) !== 'off',
                    ...(once !== undefined ? { once } : {}),
                    ...usageField(args, exec, getUsage),
                };
            }
            const applied = await setMode(args.mode, exec?.signal);
            return {
                mode: applied.mode,
                previous: applied.previous,
                changed: applied.changed,
                active: applied.mode !== 'off',
                ...(once !== undefined ? { once } : {}),
                ...usageField(args, exec, getUsage),
            };
        },
    });
}
/**
 * Read the optional `usage` flag's field: the session totals when asked and
 * available, otherwise nothing. Savings are never inferred — the log has no
 * unbuilt baseline to subtract.
 */
function usageField(args, exec, getUsage) {
    if (getUsage === undefined)
        return {};
    if (args === null || typeof args !== 'object')
        return {};
    if (args['usage'] !== true)
        return {};
    const usage = getUsage(exec);
    return usage === undefined ? {} : { usage };
}
/**
 * Build the model-facing compress tool. Local deterministic rules only —
 * no model call, no bytes leave the machine.
 * @param syncBackupDir - applies the backup-dir override before each run.
 * @param maxFileSize - configured size cap in bytes.
 * @returns the registered tool definition.
 */
function createCompressTool(syncBackupDir, maxFileSize) {
    return defineTool({
        name: 'caveman-compress',
        description: 'Compress a natural-language file (memory file, todo list) with local '
            + 'caveman rules. Code, URLs, paths, and headings are preserved; the '
            + 'original is backed up out-of-tree.',
        parameters: {
            filepath: {
                type: 'string',
                required: true,
                description: 'Absolute path of the file to compress.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    reason: { type: 'string' },
                    backupPath: { type: 'string' },
                    originalChars: { type: 'number' },
                    compressedChars: { type: 'number' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderCompressResult(value) }],
        },
        async execute(args, exec) {
            exec?.signal?.throwIfAborted();
            // The schema owns the type; an empty path is the one shape it cannot see.
            if (args.filepath.trim() === '') {
                throw new Error('caveman-compress needs a filepath string.');
            }
            syncBackupDir();
            const outcome = compressFile(args.filepath, maxFileSize);
            // The write is atomic but not free; a cancelled call must not claim it.
            exec?.signal?.throwIfAborted();
            return outcome;
        },
    });
}
/**
 * Render the canonical compress value for the model.
 * @param value - the canonical value returned by `execute`.
 * @returns model-facing prose.
 */
function renderCompressResult(value) {
    const record = (value ?? {});
    if (record['ok'] !== true) {
        const reason = typeof record['reason'] === 'string' ? record['reason'] : 'compression failed';
        return reason;
    }
    const backup = typeof record['backupPath'] === 'string' ? record['backupPath'] : 'unknown';
    const before = typeof record['originalChars'] === 'number' ? record['originalChars'] : 0;
    const after = typeof record['compressedChars'] === 'number' ? record['compressedChars'] : 0;
    return `Compressed ${before} to ${after} chars. Original backed up at ${backup}.`;
}
/**
 * Phrase one level outcome. Shared by the model-facing tool and the human
 * command, which report the same three transitions.
 * @param mode - the level now active.
 * @param previous - the level before the call.
 * @param changed - whether the call moved the level.
 * @returns the sentence both surfaces start from.
 */
function modeSentence(mode, previous, changed) {
    if (!changed)
        return `Caveman level: ${mode}.`;
    return mode === 'off'
        ? `Caveman off (was ${previous}). Normal behavior.`
        : `Caveman level: ${mode} (was ${previous}).`;
}
/**
 * Render the canonical tool value for the model.
 * @param value - the canonical value returned by `execute`.
 * @returns model-facing prose.
 */
function renderModeResult(value) {
    const record = (value ?? {});
    const mode = typeof record['mode'] === 'string' ? record['mode'] : 'unknown';
    const previous = typeof record['previous'] === 'string' ? record['previous'] : mode;
    const changed = record['changed'] === true;
    const active = record['active'] === true;
    const once = typeof record['once'] === 'string' ? record['once'] : undefined;
    const usage = record['usage'];
    const core = (!changed && !active)
        ? 'Caveman is off. Normal behavior.'
        : active
            ? `${modeSentence(mode, previous, changed)} The ruleset is injected into every request.`
            : modeSentence(mode, previous, changed);
    const onceLine = once !== undefined ? ` Reply to this call in ${once}; the persisted level is unchanged.` : '';
    if (usage === undefined)
        return `${core}${onceLine}`;
    const line = (name) => typeof usage[name] === 'number' ? usage[name] : 0;
    return `${core}${onceLine} Session usage so far — input ${line('input')}, output ${line('output')}, cache read ${line('cacheRead')}, cache write ${line('cacheWrite')}. Savings unknown without a measured comparison.`;
}
/**
 * Handle the human `/caveman [level]` command.
 * @param invocation - the command invocation.
 * @param getMode - reads the active level.
 * @param setMode - applies and persists a level.
 * @returns the direct-UI result.
 */
async function handleModeCommand(invocation, getMode, setMode) {
    const input = invocation.rawInput.trim().toLowerCase();
    if (input === '')
        return { kind: 'success', text: modeSentence(getMode(), getMode(), false) };
    const requested = isDeactivationCommand(input) ? 'off' : normalizeCommandMode(input);
    if (requested === undefined) {
        return {
            kind: 'error',
            text: `Unknown caveman level "${invocation.rawInput.trim()}". Use one of: ${VALID_MODES.join(', ')}.`,
        };
    }
    const { previous, mode, changed } = await setMode(requested);
    return { kind: 'success', text: modeSentence(mode, previous, changed) };
}
/**
 * Handle the human `/caveman-compress <filepath>` command.
 * @param invocation - the command invocation.
 * @param syncBackupDir - applies the backup-dir override before each run.
 * @returns the direct-UI result.
 */
async function handleCompressCommand(invocation, syncBackupDir, maxFileSize) {
    const filepath = invocation.rawInput.trim();
    if (filepath === '') {
        return { kind: 'error', text: 'Usage: /caveman-compress <filepath>' };
    }
    syncBackupDir();
    const outcome = compressFile(filepath, maxFileSize);
    if (!outcome.ok)
        return { kind: 'error', text: outcome.reason };
    return {
        kind: 'success',
        text: `Compressed ${outcome.originalChars} to ${outcome.compressedChars} chars. Original backed up at ${outcome.backupPath}.`,
    };
}
