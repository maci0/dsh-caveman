/**
 * The slice of the DeepSeek Harness host surface this plugin uses, declared
 * structurally.
 *
 * The plugin is installed from outside the harness checkout. It depends on the
 * published `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-skill` packages: the
 * skill domain shapes (summaries, candidates, definitions, lookup options) are
 * imported from the latter, while the services it reaches through
 * `ctx.inject([...])` are declared structurally here: the host types remain
 * authoritative, and a composition that does not mount a service simply omits
 * that capability.
 *
 * @module dsh-caveman/host
 */
export {};
