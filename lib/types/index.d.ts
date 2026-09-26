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
import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type CavemanMode } from './modes.ts';
import type { HostContext } from './host.ts';
/** Plugin name as it appears in the loader. */
export declare const name = "caveman";
/**
 * Configuration received by the plugin, as the loader resolved this row
 * against the schema below: every ordinary field carries its default, and every
 * volatile field arrives as the live reference the settings document writes
 * through. Read `.get()` when starting an operation.
 */
export interface Config {
    /** Startup level. Absent resolves through the chain, ending at `full`. */
    readonly defaultMode: Volatile<CavemanMode | undefined>;
    /** Size cap in bytes for `/caveman-compress`; defaults to 500000. */
    readonly maxFileSize: number;
}
/**
 * Row schema: the accepted levels and the size cap live here.
 *
 * `defaultMode` is volatile, the only kind of field the settings document
 * accepts: a level change commits into the running config without remounting
 * the plugin, and the field still carries no default, so absence keeps flowing
 * to `resolveDefaultMode`. A schema default would fill the field before `apply`,
 * which would silently outrank `CAVEMAN_DEFAULT_MODE` and
 * `~/.config/caveman/config.json`.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    defaultMode: z<"full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra", "full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra", "volatile">;
    maxFileSize: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    defaultMode: z<"full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra", "full" | "lite" | "off" | "ultra" | "wenyan-full" | "wenyan-lite" | "wenyan-ultra", "volatile">;
    maxFileSize: z<number, number, "defined">;
}>>, "plain">;
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
 * @param config - the schema-resolved row configuration.
 */
export declare function apply(ctx: HostContext, config: Config): void;
