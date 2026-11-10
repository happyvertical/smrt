/**
 * Process registry for code-defined fusions (#4753), on `globalThis` so it
 * survives HMR and duplicate package copies like core's registries. Storage
 * only: `defineFusion()` (fusion.ts) validates before it stores.
 */
import type {
  InferenceConfig,
  InferenceFusionDefinition,
} from '@happyvertical/smrt-core';

const STORE_KEY = Symbol.for('smrt.inference.fusions');

type StoreHolder = {
  [STORE_KEY]?: Map<string, InferenceFusionDefinition>;
};

/** The registry map (created on first use). */
export function fusionStore(): Map<string, InferenceFusionDefinition> {
  const holder = globalThis as StoreHolder;
  holder[STORE_KEY] ??= new Map();
  return holder[STORE_KEY];
}

/**
 * The definition a fusion key runs: `inference.fusions.<key>` from config
 * when present (the app's layer wins), else the `defineFusion()` one.
 */
export function lookupFusion(
  key: string,
  config: InferenceConfig | undefined,
): InferenceFusionDefinition | undefined {
  const fromConfig = config?.fusions;
  if (fromConfig && Object.hasOwn(fromConfig, key)) return fromConfig[key];
  return fusionStore().get(key);
}

/** True when the smrt-prompts process registry holds `key`. */
export function isPromptRegistered(key: string): boolean {
  const registry = (globalThis as { __smrtPromptRegistry?: unknown })
    .__smrtPromptRegistry;
  return registry instanceof Map && registry.has(key);
}
