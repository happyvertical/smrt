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

const AI_ROUTING_PARAM_KEYS = new Set([
  'profile',
  'provider',
  'type',
  'model',
  'defaultModel',
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

  return {
    profile: profile ?? undefined,
    model: model ?? undefined,
    params: extractPromptParams(ai, AI_RESERVED_KEYS),
  };
}

export function normalizePromptDefinitionInput(input: PromptDefinitionInput): {
  key: string;
  template: string;
  ai: NormalizedPromptAI;
  editable: PromptEditableConfig;
} {
  return {
    key: input.key,
    template: input.template,
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

  if (!config.profiles?.[profileName]) {
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
): ResolvedPromptAI {
  let provider: string | undefined;
  let model = ai.model;
  let params = ai.params;

  if (ai.profile) {
    validateProfileName(ai.profile, config);
    const configuredProfile = config.profiles?.[ai.profile];
    if (!configuredProfile) {
      throw new Error(`Prompt profile "${ai.profile}" is not configured`);
    }
    const profileConfig = normalizeProfileConfig(configuredProfile);
    provider = profileConfig.provider;
    model = model ?? profileConfig.model;
    params = mergePromptParams(profileConfig.params, params);
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
