import { getPackageConfig } from '@happyvertical/smrt-config';
import { resolveInference } from '@happyvertical/smrt-core';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import {
  getCachedPromptBase,
  getPromptCacheGeneration,
  setCachedPromptBase,
} from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { PromptRegistry } from './prompt-registry.js';
import type {
  PromptCacheValue,
  PromptPackageConfig,
  ResolvedPrompt,
  ResolvedPromptAI,
  ResolvePromptOptions,
} from './types.js';
import {
  buildResolvedAI,
  mergePromptLayers,
  mergePromptParams,
  normalizePromptLayer,
  renderPromptTemplate,
} from './utils.js';

function getPromptConfig(): PromptPackageConfig {
  return getPackageConfig<PromptPackageConfig>('prompts', {
    profiles: {},
    prompts: {},
  });
}

async function loadPromptBase(
  key: string,
  options: ResolvePromptOptions,
): Promise<PromptCacheValue> {
  const definition = PromptRegistry.get(key);
  if (!definition) {
    throw new Error(`Unknown prompt key "${key}"`);
  }

  const tenantId =
    options.tenantId !== undefined ? options.tenantId : (getTenantId() ?? null);

  let collection: PromptOverrideCollection | null = null;
  let cacheDb: ResolvePromptOptions['db'] | undefined = options.db;
  if (options.db) {
    const initializedCollection = await PromptOverrideCollection.create({
      db: options.db,
    });
    collection = initializedCollection;
    cacheDb = initializedCollection.db as ResolvePromptOptions['db'];
  }

  const cached = getCachedPromptBase(key, tenantId, cacheDb);
  if (cached) {
    return cached;
  }

  // Capture the invalidation generation before the asynchronous layer loads. A
  // write that lands while they are in flight bumps it, and the cache write
  // below is then refused rather than repopulating the key the write just
  // invalidated with the pre-write value.
  const loadedAtGeneration = getPromptCacheGeneration(key, cacheDb);

  const config = getPromptConfig();
  const layers = [
    {
      template: definition.template,
      profile: definition.ai.profile ?? null,
      model: definition.ai.model ?? null,
      params: definition.ai.params,
    },
    normalizePromptLayer(config.prompts?.[key]),
  ];

  if (collection) {
    const stored = await collection.getResolutionLayers(key, tenantId);

    if (stored.app) {
      layers.push(stored.app.toPromptLayer());
    }

    if (stored.tenant) {
      layers.push(stored.tenant.toPromptLayer());
    }
  }

  const merged = mergePromptLayers(...layers);
  const value: PromptCacheValue = {
    key,
    template: merged.template,
    ai: merged.ai,
  };

  setCachedPromptBase(key, tenantId, cacheDb, value, loadedAtGeneration);
  return value;
}

export async function resolvePrompt(
  key: string,
  options: ResolvePromptOptions = {},
): Promise<ResolvedPrompt> {
  const config = getPromptConfig();
  const base = await loadPromptBase(key, options);
  const runtimeOverride = normalizePromptLayer(options.override);
  const merged = mergePromptLayers(
    {
      template: base.template,
      profile: base.ai.profile ?? null,
      model: base.ai.model ?? null,
      params: base.ai.params,
    },
    runtimeOverride,
  );

  const ai = buildResolvedAI(merged.ai, config);
  if (ai.tier) {
    await bindPromptTier(ai, key, options);
  }

  return {
    key,
    template: merged.template,
    text: renderPromptTemplate(merged.template, options.variables),
    ai,
  };
}

/**
 * Bind a tier profile through the core inference seam (#4750). The target's
 * provider, model and params fill the resolved AI; an explicit prompt model
 * and prompt params still win. Resolver-supplied models are app bindings, so
 * `allowedModels` (a cap on prompt overrides) does not apply to them.
 */
async function bindPromptTier(
  ai: ResolvedPromptAI,
  key: string,
  options: ResolvePromptOptions,
): Promise<void> {
  const tier = ai.tier;
  if (!tier) return;
  const tenantId =
    options.tenantId !== undefined ? options.tenantId : (getTenantId() ?? null);
  const resolution = await resolveInference({
    tier,
    tenantId,
    promptKey: key,
  });
  const { target } = resolution;
  ai.tierResolved = resolution.tierResolved;
  ai.inferenceVia = resolution.via;
  if (target.provider) ai.provider = target.provider;
  if (!ai.model && target.model) ai.model = target.model;
  if (target.params) {
    const params = mergePromptParams(target.params, ai.params);
    ai.params = params;
    for (const [name, value] of Object.entries(params)) {
      if (!(name in ai)) ai[name] = value;
    }
    if (typeof params.temperature === 'number') {
      ai.temperature = params.temperature;
    }
    if (typeof params.maxTokens === 'number') ai.maxTokens = params.maxTokens;
  }
}
