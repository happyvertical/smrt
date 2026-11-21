import {
  type AsyncContext,
  createAsyncContext,
} from '@happyvertical/smrt-core';
import type { PromptConfigOverrideInput } from './types.js';

/**
 * Request-scoped ambient prompt overrides (#5065).
 *
 * The store sits on a `globalThis` key, like the prompt registry and tenancy's
 * context, so duplicated module instances share one scope stack.
 */
type ScopedOverrides = ReadonlyMap<string, PromptConfigOverrideInput>;

const STORAGE = Symbol.for('smrt.prompts.scopedOverrides');
const shared = globalThis as unknown as Record<symbol, unknown>;

function context(): AsyncContext<ScopedOverrides> {
  shared[STORAGE] ??= createAsyncContext<ScopedOverrides>();
  return shared[STORAGE] as AsyncContext<ScopedOverrides>;
}

/** Whether an ambient scope can reach async work started inside it. */
export function scopedOverridesPropagate(): boolean {
  return context().propagatesAcrossAwait;
}

/** Run `fn` with `overrides` layered over any enclosing scope (inner wins per key). */
export function runWithScopedOverrides<T>(
  overrides: Readonly<Record<string, PromptConfigOverrideInput>>,
  fn: () => T,
): T {
  const merged = new Map(context().getStore());
  for (const [key, override] of Object.entries(overrides)) {
    merged.set(key, { ...override });
  }
  return context().run(merged, fn);
}

/** The ambient override for `key` in the current async scope, if any. */
export function getScopedPromptOverride(
  key: string,
): PromptConfigOverrideInput | undefined {
  return context().getStore()?.get(key);
}
