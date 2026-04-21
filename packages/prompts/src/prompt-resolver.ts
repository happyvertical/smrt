import { getPackageConfig } from '@happyvertical/smrt-config';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { getCachedPromptBase, setCachedPromptBase } from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { PromptRegistry } from './prompt-registry.js';
import type {
  PromptCacheValue,
  PromptPackageConfig,
  ResolvedPrompt,
  ResolvePromptOptions,
} from './types.js';
import {
  buildResolvedAI,
  mergePromptLayers,
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
  const cached = getCachedPromptBase(key, tenantId, options.db);
  if (cached) {
    return cached;
  }

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

  if (options.db) {
    const collection = await (PromptOverrideCollection as any).create({
      db: options.db,
    });
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

  setCachedPromptBase(key, tenantId, options.db, value);
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

  return {
    key,
    template: merged.template,
    text: renderPromptTemplate(merged.template, options.variables),
    ai: buildResolvedAI(merged.ai, config),
  };
}
