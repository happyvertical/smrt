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
}

export function registerEmbeddedDrain(drain: Drain): void {
  (globalThis as Record<symbol, unknown>)[EMBED_SLOT] = {
    drain,
  } satisfies EmbedSlot;
}
