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
import z from '@deepseek-ai/schemastery';
import { type CavemanMode } from './modes.ts';
import type { HostContext } from './host.ts';
/** Plugin name as it appears in the loader. */
export declare const name = "caveman";
/**
 * Settings namespace the browser card edits — the join key between this host
 * half and `lib/client.js`. The card registers into `settings.plugin.item`
 * under the same key, and the tab pairs the two without knowing what it means.
 */
export declare const CAVEMAN_SETTINGS_NAMESPACE = "caveman";
/** Persisted configuration. Every caveman level persists; there is no session-only level. */
export declare const CavemanSettings: z<Schemastery.ObjectS<{
    mode: z<"full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra", "full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra">;
}>, Schemastery.ObjectT<{
    mode: z<"full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra", "full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra">;
}>>;
/**
 * Configuration accepted from this plugin's row in a profile patch.
 *
 * The exported schema is what Cordis validates the row against before `apply`
 * runs. It deliberately declares no default for `defaultMode`: a schema default
 * would fill the field before `apply`, which would silently outrank
 * `CAVEMAN_DEFAULT_MODE` and `~/.config/caveman/config.json`. Absence flows to
 * `resolveDefaultMode`, which owns the documented chain, and `apply` still
 * validates `defaultMode` itself so a caller that bypasses the loader cannot
 * mount a bad level.
 */
export interface Config {
    /** Startup level. Absent resolves through the chain, ending at `full`. */
    readonly defaultMode?: CavemanMode;
    /** Size cap in bytes for `/caveman-compress`; defaults to 500000. */
    readonly maxFileSize?: number;
}
/** Row schema: the accepted levels and the size cap live here. */
export declare const Config: z<Config>;
/**
 * Read the upstream config file's `defaultMode`, ignoring everything that
 * would make startup fail: a missing file, an unreadable file, invalid JSON,
 * or a non-object document all mean "no file default".
 * @param path - config file path; the upstream location unless tests override it.
 * @returns the parsed document, or `undefined` when there is nothing usable.
 */
export declare function readUpstreamConfigFile(path?: string): {
    readonly defaultMode?: unknown;
} | undefined;
/**
 * Mount the plugin.
 * @param ctx - the host context.
 * @param config - optional row configuration.
 */
export declare function apply(ctx: HostContext, config?: Config): void;
