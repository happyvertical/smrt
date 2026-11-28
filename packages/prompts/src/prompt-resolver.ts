import { getPackageConfig } from '@happyvertical/smrt-config';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import {
  getCachedPromptBase,
  getPromptCacheGeneration,
  setCachedPromptBase,
} from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { PromptRegistry } from './prompt-registry.js';
import {
  getScopedPromptOverride,
  runWithScopedOverrides,
  scopedOverridesPropagate,
} from './scoped-overrides.js';
import type {
  PromptCacheValue,
  PromptConfigOverrideInput,
  PromptLayer,
  PromptPackageConfig,
  PromptSourceLayer,
  ResolvedPrompt,
  ResolvePromptOptions,
} from './types.js';
import {
  buildResolvedAI,
  mergePromptLayers,
  normalizePromptLayer,
  promptTemplateHash,
  renderPromptTemplate,
} from './utils.js';

/** True when `layer` sets the template (null and undefined inherit). */
function suppliesTemplate(layer: PromptLayer | null | undefined): boolean {
  return layer?.template !== undefined && layer.template !== null;
}

/** True when `layer` sets the profile (null and undefined inherit). */
function suppliesProfile(layer: PromptLayer | null | undefined): boolean {
  return layer?.profile !== undefined && layer.profile !== null;
}

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
  // Each layer is named so the resolution can report which one supplied the
  // effective template (the `promptLayer` usage tag, #4751).
  const layers: Array<{
    name: PromptCacheValue['templateLayer'];
    layer: PromptLayer;
  }> = [
    {
      name: 'default',
      layer: {
        template: definition.template,
        profile: definition.ai.profile ?? null,
        model: definition.ai.model ?? null,
        effort: definition.ai.effort ?? null,
        params: definition.ai.params,
      },
    },
    { name: 'config', layer: normalizePromptLayer(config.prompts?.[key]) },
  ];

  if (collection) {
    const stored = await collection.getResolutionLayers(key, tenantId);

    if (stored.app) {
      layers.push({ name: 'app', layer: stored.app.toPromptLayer() });
    }

    if (stored.tenant) {
      layers.push({ name: 'tenant', layer: stored.tenant.toPromptLayer() });
    }
  }

  const merged = mergePromptLayers(...layers.map(({ layer }) => layer));
  let templateLayer: PromptCacheValue['templateLayer'] = 'default';
  let profileLayer: PromptCacheValue['profileLayer'] = 'default';
  for (const { name, layer } of layers) {
    if (suppliesTemplate(layer)) templateLayer = name;
    if (suppliesProfile(layer)) profileLayer = name;
  }
  const value: PromptCacheValue = {
    key,
    template: merged.template,
    templateLayer,
    profileLayer,
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
  // The ambient layer (#5065) is applied here, after the cached base, so a
  // draft never reaches the prompt cache. The explicit override sits above it.
  const ambientOverride = normalizePromptLayer(getScopedPromptOverride(key));
  const explicitOverride = normalizePromptLayer(options.override);
  const merged = mergePromptLayers(
    {
      template: base.template,
      profile: base.ai.profile ?? null,
      model: base.ai.model ?? null,
      effort: base.ai.effort ?? null,
      params: base.ai.params,
    },
    ambientOverride,
    explicitOverride,
  );

  const promptLayer: PromptSourceLayer =
    suppliesTemplate(ambientOverride) || suppliesTemplate(explicitOverride)
      ? 'runtime'
      : base.templateLayer;
  // Only a profile the code default itself supplied is exempt from
  // `allowedProfileNames`; any config, stored or runtime layer that sets one
  // (even the same tier again) is a choice the allow-list governs.
  const profileFromDefault =
    base.profileLayer === 'default' &&
    !suppliesProfile(ambientOverride) &&
    !suppliesProfile(explicitOverride);
  const ai = buildResolvedAI(merged.ai, config, {
    defaultProfile: profileFromDefault
      ? PromptRegistry.get(key)?.ai.profile
      : undefined,
  });
  if (ai.tier) {
    // The tier binds once, at call time, through the core inference seam
    // (`SmrtObject.prepareAiOperation()` / `getAiClient(tier)`), with this
    // key so prompt-scoped bindings apply (#4750).
    ai.promptKey = key;
    // The latency hint belongs to the call site, so only the code default
    // declares it (#4755).
    const latency = PromptRegistry.get(key)?.ai.latency;
    if (latency) ai.latency = latency;
    // The degradation floor is the code default's alone (#4752).
    const minimumTier = PromptRegistry.get(key)?.ai.minimumTier;
    if (minimumTier) ai.minimumTier = minimumTier;
  }

  return {
    key,
    template: merged.template,
    text: renderPromptTemplate(merged.template, options.variables),
    ai: {
      ...ai,
      usageTags: {
        promptKey: key,
        promptLayer,
        templateHash: await promptTemplateHash(merged.template),
      },
    },
  };
}

/**
 * Run `fn` with prompt overrides keyed by prompt key (#5065), so real call
 * sites that never forward `override` resolve a draft:
 *
 * ```ts
 * await withPromptOverrides(
 *   { 'content.review': { template: draft, profile: 'cheap' } },
 *   () => content.review(),
 * );
 * ```
 *
 * The layer sits above stored overrides and below an explicit
 * `resolvePrompt(key, { override })`, is tagged `promptLayer: 'runtime'`, and
 * never enters the prompt cache. Nested scopes: the inner wins per key, outer
 * keys stay visible. It follows `await` in the same async tree, not work
 * enqueued as a job. Throws unless the host set `allowScopedOverrides: true`
 * in the prompts config, when the runtime cannot propagate async context
 * (browsers: a silent no-op would run, and record, the live template), or
 * when an override is invalid (effort).
 */
export function withPromptOverrides<T>(
  overrides: Readonly<Record<string, PromptConfigOverrideInput>>,
  fn: () => T,
): T {
  if (getPromptConfig().allowScopedOverrides !== true) {
    throw new Error(
      'withPromptOverrides() is disabled: set `allowScopedOverrides: true` in the "prompts" package config to opt in',
    );
  }
  if (!scopedOverridesPropagate()) {
    throw new Error(
      'withPromptOverrides() needs async context that survives await, which this runtime does not provide',
    );
  }
  for (const override of Object.values(overrides)) {
    normalizePromptLayer(override);
  }
  return runWithScopedOverrides(overrides, fn);
}
