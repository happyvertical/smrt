/**
 * The hand-over between the server bundle and the package's build entries
 * (#5546). `hooks.server.ts` runs inside the SvelteKit server bundle, and
 * `build/embed.js` / `build/index.js` sit beside it as separate modules, so a
 * module-level import cannot reach the bundle's copy of the shell state. The
 * bundle publishes its drain under a registry symbol and the entries read it
 * back after the handler has initialised. Nothing else uses this slot.
 */
import type { Drain } from './shutdown';

/** `Symbol.for` key shared with `tools/embed-entry.js`. */
export const EMBED_SLOT = Symbol.for('@happyvertical/smrt-app-shell/embed');

export interface EmbedSlot {
  drain: Drain;
  /**
   * The operator commands (`operator.ts`), for `build/operator.js` only
   * (#5193): the exit code of one command line, run inside the bundle's shell.
   */
  operator?: {
    run(argv: readonly string[]): Promise<number>;
  };
}

export function registerEmbeddedDrain(
  drain: Drain,
  operator?: EmbedSlot['operator'],
): void {
  (globalThis as Record<symbol, unknown>)[EMBED_SLOT] = {
    drain,
    ...(operator ? { operator } : {}),
  } satisfies EmbedSlot;
}
