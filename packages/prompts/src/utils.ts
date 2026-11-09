import {
  INFERENCE_TIERS,
  type InferenceLatency,
  type InferenceTierRequest,
  isInferenceTier,
  isInferenceTierRequest,
} from '@happyvertical/smrt-core';
import type {
  NormalizedPromptAI,
  PromptAIInput,
  PromptConfigOverrideInput,
  PromptDefinitionInput,
  PromptEditableConfig,
  PromptLayer,
  PromptPackageConfig,
  PromptParams,
  PromptProfileConfig,
  ResolvedPromptAI,
} from './types.js';

const DEFAULT_EDITABLE: PromptEditableConfig = {
  template: false,
  profile: false,
  model: false,
  params: false,
};

const TOP_LEVEL_RESERVED_KEYS = new Set([
  'key',
  'editable',
  'template',
  'ai',
  'profile',
  'provider',
  'model',
  'params',
  'temperature',
  'maxTokens',
]);

const AI_RESERVED_KEYS = new Set([
  'profile',
  'provider',
  'model',
  'params',
  'temperature',
  'maxTokens',
]);

// `tier` and `promptKey` come only from the resolution (an effective tier
// profile), never from tenant-editable params, so `allowedProfileNames`
// cannot be bypassed through params (#4755).
const AI_ROUTING_PARAM_KEYS = new Set([
  'profile',
  'provider',
  'type',
  'model',
  'defaultModel',
  // Inference tier routing (#4750) comes only from the validated profile;
  // a (tenant-editable) params layer can never pick or spoof it.
  'tier',
  'latency',
  'promptKey',
  // The ladder floor is read from the code default only (#4752).
  'minimumTier',
]);

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeEditableConfig(
  editable?: Partial<PromptEditableConfig>,
): PromptEditableConfig {
  return {
    template: editable?.template ?? DEFAULT_EDITABLE.template,
    profile: editable?.profile ?? DEFAULT_EDITABLE.profile,
    model: editable?.model ?? DEFAULT_EDITABLE.model,
    params: editable?.params ?? DEFAULT_EDITABLE.params,
  };
}

function extractPromptParams(
  source: Record<string, unknown>,
  reservedKeys: Set<string>,
): PromptParams {
  const params: PromptParams = {};

  if (isPlainObject(source.params)) {
    Object.assign(params, sanitizePromptParams(source.params));
  }

  if ('temperature' in source && source.temperature !== undefined) {
    params.temperature = source.temperature;
  }

  if ('maxTokens' in source && source.maxTokens !== undefined) {
    params.maxTokens = source.maxTokens;
  }

  for (const [key, value] of Object.entries(source)) {
    if (reservedKeys.has(key) || value === undefined) {
      continue;
    }
    assignPromptParam(params, key, value);
  }

  return params;
}

function assignPromptParam(
  params: PromptParams,
  key: string,
  value: unknown,
): void {
  if (AI_ROUTING_PARAM_KEYS.has(key) || value === undefined) {
    return;
  }

  params[key] = value;
}

export function sanitizePromptParams(
  params: PromptParams | null | undefined,
): PromptParams {
  const sanitized: PromptParams = {};

  if (!params) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(params)) {
    assignPromptParam(sanitized, key, value);
  }

  return sanitized;
}

export function mergePromptParams(
  ...paramLayers: Array<PromptParams | null | undefined>
): PromptParams {
  const merged: PromptParams = {};

  for (const layer of paramLayers) {
    if (!layer) {
      continue;
    }

    for (const [key, value] of Object.entries(layer)) {
      assignPromptParam(merged, key, value);
    }
  }

  return merged;
}

function normalizeAIInput(ai?: PromptAIInput | null): NormalizedPromptAI {
  if (!isPlainObject(ai)) {
    return { params: {} };
  }

  const profile =
    typeof ai.profile === 'string' || ai.profile === null
      ? ai.profile
      : undefined;
  const model =
    typeof ai.model === 'string' || ai.model === null ? ai.model : undefined;
  if (ai.minimumTier !== undefined && !isInferenceTier(ai.minimumTier)) {
    throw new Error(
      `Prompt ai.minimumTier must be one of ${INFERENCE_TIERS.join(', ')}; got "${String(ai.minimumTier)}".`,
    );
  }

  const latency =
    ai.latency === 'interactive' || ai.latency === 'background'
      ? ai.latency
      : undefined;

  return {
    profile: profile ?? undefined,
    model: model ?? undefined,
    ...(latency ? { latency } : {}),
    ...(ai.minimumTier ? { minimumTier: ai.minimumTier } : {}),
    params: extractPromptParams(ai, AI_RESERVED_KEYS),
  };
}

export function normalizePromptDefinitionInput(input: PromptDefinitionInput): {
  key: string;
  template: string;
  description: string;
  ai: NormalizedPromptAI;
  editable: PromptEditableConfig;
} {
  return {
    key: input.key,
    template: input.template,
    description: input.description ?? '',
    ai: normalizeAIInput(input.ai),
    editable: normalizeEditableConfig(input.editable),
  };
}

export function normalizePromptLayer(
  input?: PromptConfigOverrideInput | null,
): PromptLayer {
  if (!isPlainObject(input)) {
    return {};
  }

  const nestedAi = isPlainObject(input.ai)
    ? normalizeAIInput(input.ai)
    : { params: {} };
  const topLevelParams = extractPromptParams(input, TOP_LEVEL_RESERVED_KEYS);

  return {
    template:
      input.template === undefined
        ? undefined
        : input.template === null
          ? null
          : String(input.template),
    profile:
      input.profile === undefined
        ? nestedAi.profile
        : input.profile === null
          ? null
          : String(input.profile),
    model:
      input.model === undefined
        ? nestedAi.model
        : input.model === null
          ? null
          : String(input.model),
    params: mergePromptParams(topLevelParams, nestedAi.params),
  };
}

export function mergePromptLayers(
  ...layers: Array<PromptLayer | null | undefined>
): {
  template: string;
  ai: NormalizedPromptAI;
} {
  let template = '';
  let profile: string | undefined;
  let model: string | undefined;
  let params: PromptParams = {};

  for (const layer of layers) {
    if (!layer) {
      continue;
    }

    if (layer.template !== undefined && layer.template !== null) {
      template = layer.template;
    }

    if (layer.profile !== undefined && layer.profile !== null) {
      profile = layer.profile;
    }

    if (layer.model !== undefined && layer.model !== null) {
      model = layer.model;
    }

    if (layer.params !== undefined && layer.params !== null) {
      params = mergePromptParams(params, layer.params);
    }
  }

  return {
    template,
    ai: {
      profile,
      model,
      params,
    },
  };
}

export function normalizeProfileConfig(profile: PromptProfileConfig): {
  provider: string;
  model: string;
  params: PromptParams;
} {
  const source = isPlainObject(profile) ? profile : {};
  const params = extractPromptParams(source, new Set(['provider', 'model']));

  return {
    provider: String(profile.provider),
    model: String(profile.model),
    params,
  };
}

export function validateProfileName(
  profileName: string,
  config: PromptPackageConfig,
): void {
  if (profileName.trim() === '') {
    throw new Error('Prompt profile names cannot be empty');
  }

  const allowedProfileNames = config.allowedProfileNames;
  if (
    Array.isArray(allowedProfileNames) &&
    !allowedProfileNames.includes(profileName)
  ) {
    throw new Error(
      `Prompt profile "${profileName}" is not in the allowed profile list`,
    );
  }

  // Tier names (and `auto`) are reserved profile names that resolve through
  // the core inference seam (#4750); a same-named configured profile wins.
  if (!config.profiles?.[profileName] && !isInferenceTierRequest(profileName)) {
    throw new Error(`Prompt profile "${profileName}" is not configured`);
  }
}

export function validateModelName(
  modelName: string,
  config: PromptPackageConfig,
): void {
  if (modelName.trim() === '') {
    throw new Error('Prompt model overrides cannot be empty');
  }

  const allowedModels = config.allowedModels;
  if (Array.isArray(allowedModels) && !allowedModels.includes(modelName)) {
    throw new Error(
      `Prompt model "${modelName}" is not in the allowed model list`,
    );
  }
}

export function buildResolvedAI(
  ai: NormalizedPromptAI,
  config: PromptPackageConfig,
  options: {
    /**
     * The registered code default's profile (`definePrompt({ ai })`), passed
     * only when no config, stored or runtime layer set a profile.
     */
    defaultProfile?: string;
  } = {},
): ResolvedPromptAI {
  let provider: string | undefined;
  let model = ai.model;
  let params = ai.params;
  let tier: ResolvedPromptAI['tier'];

  if (ai.profile) {
    // `allowedProfileNames` limits what config and stored overrides may
    // select. A tier the code default itself declares (#4755) is not such a
    // choice, so an app's allow-list cannot break framework prompts.
    const codeDefaultTier =
      ai.profile === options.defaultProfile &&
      !config.profiles?.[ai.profile] &&
      isInferenceTierRequest(ai.profile);
    if (!codeDefaultTier) validateProfileName(ai.profile, config);
    const configuredProfile = config.profiles?.[ai.profile];
    if (configuredProfile) {
      const profileConfig = normalizeProfileConfig(configuredProfile);
      provider = profileConfig.provider;
      model = model ?? profileConfig.model;
      params = mergePromptParams(profileConfig.params, params);
    } else if (isInferenceTierRequest(ai.profile)) {
      // Bound later through the core inference seam by `resolvePrompt()`.
      tier = ai.profile;
    } else {
      throw new Error(`Prompt profile "${ai.profile}" is not configured`);
    }
  }

  if (ai.model) {
    validateModelName(ai.model, config);
  }

  if (ai.model && !ai.profile) {
    throw new Error(
      'Direct prompt model overrides require an effective prompt profile',
    );
  }

  if (model && !ai.model && config.allowedModels) {
    validateModelName(model, config);
  }

  const resolved: ResolvedPromptAI = {
    ...params,
    profile: ai.profile,
    provider,
    model,
    ...(tier ? { tier } : {}),
    ...(config.allowedModels
      ? { allowedModels: [...config.allowedModels] }
      : {}),
    params,
  };

  if (typeof params.temperature === 'number') {
    resolved.temperature = params.temperature;
  }

  if (typeof params.maxTokens === 'number') {
    resolved.maxTokens = params.maxTokens;
  }

  return resolved;
}

const TEMPLATE_HASH_LENGTH = 12;

/**
 * Short SHA-256 fingerprint of an effective (unrendered) prompt template: the
 * first 12 lowercase hex characters. Recorded as the `templateHash` usage tag
 * so an override edit starts a new usage series (#4751).
 *
 * Uses Web Crypto (`globalThis.crypto.subtle`), available in Node and every
 * browser, so the package root stays free of `node:crypto`.
 */
export async function promptTemplateHash(template: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(template),
  );
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
    if (hex.length >= TEMPLATE_HASH_LENGTH) break;
  }
  return hex.slice(0, TEMPLATE_HASH_LENGTH);
}

/** The `ai.message()` options {@link promptMessageOptions} returns. */
export interface PromptMessageOptions extends PromptParams {
  model?: string;
  /**
   * Inference tier of a tier profile (#4750). Object call sites pass these
   * options through `SmrtObject.prepareAiOperation()`, which picks the tier
   * client and strips `tier`/`promptKey` before the provider sees them.
   */
  tier?: InferenceTierRequest;
  /** Set with `tier`: the prompt key for the call-time resolver request. */
  promptKey?: string;
  /** Set with `tier`: the code default's `ai.latency` hint (#4755). */
  latency?: InferenceLatency;
  temperature?: number;
  maxTokens?: number;
  /** Degradation floor sent with `tier` (#4752). */
  minimumTier?: ResolvedPromptAI['minimumTier'];
  usageTags?: Record<string, string>;
}

/** Extra call options merged by {@link promptMessageOptions}. */
export interface PromptMessageOptionsExtra {
  /** The caller's own usage tags; they win over the resolution's tags. */
  usageTags?: Record<string, string>;
  /**
   * `false` omits `tier`/`promptKey` for a call site that sends the options
   * straight to a client it already holds (no `prepareAiOperation()`), so
   * the tier keys never reach a provider; the call runs on that client.
   * Default `true`.
   */
  routeTier?: boolean;
}

/**
 * Turn a resolved prompt's AI settings into `ai.message()` call options:
 * params, `model`, `temperature`, `maxTokens`, the resolution's
 * `usageTags` (`promptKey`, `promptLayer`, `templateHash`) and, for a tier
 * profile, `tier` + `promptKey` (#4750). Send them through
 * `SmrtObject.prepareAiOperation()` so the tier keys never reach a provider.
 *
 * Tag precedence, low to high: a `usageTags` object carried in the prompt's
 * params (tenant-editable: reserved tags such as runId or tier tags are
 * dropped from it), the resolution's identity tags, then `extra.usageTags`.
 */
export function promptMessageOptions(
  ai: ResolvedPromptAI,
  extra: PromptMessageOptionsExtra = {},
): PromptMessageOptions {
  // Tier routing keys never ride in on params, even for a hand-built object.
  const {
    tier: _tier,
    latency: _latency,
    promptKey: _promptKey,
    // Never spread raw: only the sanitized copy below may reach the call.
    usageTags: paramTags,
    ...params
  } = ai.params || {};
  const routeTier = extra.routeTier !== false;
  const usageTags = {
    ...paramUsageTags(paramTags),
    ...(ai.usageTags ?? {}),
    ...(extra.usageTags ?? {}),
  };
  return {
    ...params,
    ...(ai.model ? { model: ai.model } : {}),
    ...(routeTier && ai.tier ? { tier: ai.tier } : {}),
    ...(routeTier && ai.tier && ai.promptKey
      ? { promptKey: ai.promptKey }
      : {}),
    ...(routeTier && ai.tier && ai.latency ? { latency: ai.latency } : {}),
    ...(routeTier && ai.tier && ai.minimumTier
      ? { minimumTier: ai.minimumTier }
      : {}),
    ...(typeof ai.temperature === 'number'
      ? { temperature: ai.temperature }
      : {}),
    ...(typeof ai.maxTokens === 'number' ? { maxTokens: ai.maxTokens } : {}),
    ...(Object.keys(usageTags).length > 0 ? { usageTags } : {}),
  };
}

/**
 * Usage tags that feed indexed columns, tenant checks or report accounting
 * (#4751, #4750, #4752, #4753). A tenant-editable params layer must never
 * set them: a forged `runId` could make another tenant's run look shared and
 * block its outcome labels, and forged tier or substitution tags would skew
 * the report. Only the resolution and the calling code may set these.
 */
const RESERVED_USAGE_TAGS = new Set([
  'promptKey',
  'promptLayer',
  'templateHash',
  'runId',
  'tierRequested',
  'tierResolved',
  'substitutions',
  'fusionKey',
]);

/** Free-form tags from params, minus the reserved ones. */
function paramUsageTags(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const tags: Record<string, string> = {};
  for (const [key, tag] of Object.entries(value)) {
    if (RESERVED_USAGE_TAGS.has(key)) continue;
    if (tag !== undefined && tag !== null) tags[key] = String(tag);
  }
  return tags;
}

export function renderPromptTemplate(
  template: string,
  variables?: Record<string, unknown>,
): string {
  if (!variables || Object.keys(variables).length === 0) {
    return template;
  }

  return template.replace(/\{([^{}]+)\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const value = variables[key];

    if (value === undefined || value === null) {
      return '';
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value) || isPlainObject(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }

    return String(value);
  });
}

export function parsePromptParams(
  raw: string | null | undefined,
): PromptParams {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? sanitizePromptParams(parsed) : {};
  } catch {
    return {};
  }
}

export function serializePromptParams(
  params: PromptParams | null | undefined,
): string | null {
  if (params === null || params === undefined) {
    return null;
  }

  return JSON.stringify(sanitizePromptParams(params));
}
