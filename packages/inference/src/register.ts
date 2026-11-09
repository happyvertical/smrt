/**
 * Registration into core's inference seam (#4752).
 *
 * The resolver binds nothing itself: it validates chain config (naming every
 * offender) and then defers, either to a resolver registered before this
 * package (a per-user binding resolver, #4666) or to core's built-in config
 * resolution. With no aliases and no chain targets it adds nothing, so an app
 * that imports this package without configuring chains is unchanged.
 */
import {
  builtInInferenceResolver,
  getInferenceExecutor,
  getInferenceResolver,
  type InferenceConfig,
  type InferenceResolver,
  setInferenceExecutor,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { hasInferenceChains, validateInferenceConfig } from './config.js';
import type { ChainExecutorOptions } from './executor.js';
import { createChainExecutor } from './fusion.js';

const OWN_RESOLVER = Symbol.for('smrt.inference.chainResolver');

type MarkedResolver = InferenceResolver & { [OWN_RESOLVER]?: true };

/**
 * A resolver that validates chain config before deferring to `base` (or to
 * core's built-in resolution). Validation is memoized per distinct config.
 */
export function createInferenceResolver(
  base?: InferenceResolver,
): InferenceResolver {
  let validated: string | undefined;
  const validate = (config: InferenceConfig | undefined) => {
    if (!hasInferenceChains(config)) return;
    const key = JSON.stringify(config);
    if (key === validated) return;
    validateInferenceConfig(config);
    validated = key;
  };
  const resolver: MarkedResolver = {
    async resolve(request, context) {
      validate(context.config);
      return base ? base.resolve(request, context) : undefined;
    },
  };
  // Forward the optional #4757 mode hook only when the base has one, so a
  // resolver without it keeps untiered calls free of resolver work.
  if (base && typeof base.mode === 'function') {
    const mode = base.mode.bind(base);
    resolver.mode = (request) => mode(request);
  }
  // Forward the #4800 fusion lookup the same way: stored fusions (app
  // override rows) reach the executor through core's `lookupFusion()`.
  if (base && typeof base.lookupFusion === 'function') {
    const lookupFusion = base.lookupFusion.bind(base);
    resolver.lookupFusion = (key, request, context) =>
      lookupFusion(key, request, context);
  }
  resolver[OWN_RESOLVER] = true;
  return resolver;
}

/** Options for {@link registerInference}. */
export interface RegisterInferenceOptions {
  /** Executor test seams (retry delay, sleep, clock). */
  executor?: ChainExecutorOptions;
}

/**
 * Register the chain executor and the validating resolver. Idempotent: a
 * resolver registered earlier by another package is kept as the base this
 * one defers to; re-registering replaces only this package's own pieces.
 */
export function registerInference(
  options: RegisterInferenceOptions = {},
): void {
  setInferenceExecutor(createChainExecutor(options.executor));
  const current = getInferenceResolver() as MarkedResolver;
  if (current[OWN_RESOLVER]) return;
  setInferenceResolver(
    createInferenceResolver(
      current === builtInInferenceResolver ? undefined : current,
    ),
  );
}

/** True when this package's executor is the registered one. */
export function isInferenceRegistered(): boolean {
  const executor = getInferenceExecutor();
  return !!executor && executor.kinds.includes('alias');
}
