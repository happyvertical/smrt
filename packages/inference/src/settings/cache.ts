/**
 * Process-wide write generation for `_smrt_inference_overrides` (#4754).
 * Every save or delete of an override row bumps it, so the override
 * resolver's short-lived layer cache never serves a value read before a
 * write in the same process. Kept on `globalThis` so duplicate module copies
 * (HMR, two bundles) share it, like core's resolver registration.
 */
const GENERATION_KEY = Symbol.for('smrt.inference.overrideGeneration');

type GenerationHolder = { [GENERATION_KEY]?: number };

/** The current write generation. */
export function getInferenceOverrideGeneration(): number {
  return (globalThis as GenerationHolder)[GENERATION_KEY] ?? 0;
}

/** Record a write: cached layers read before it are stale. */
export function bumpInferenceOverrideGeneration(): void {
  const holder = globalThis as GenerationHolder;
  holder[GENERATION_KEY] = (holder[GENERATION_KEY] ?? 0) + 1;
}
