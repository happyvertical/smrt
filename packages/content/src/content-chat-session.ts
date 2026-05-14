import type { ResolvedPrompt } from '@happyvertical/smrt-prompts';

type SessionContext = Record<string, unknown>;

export interface ContentChatAISelection {
  profile: string | null;
  provider: string | null;
  model: string | null;
  allowedModels: string[] | null;
  temperature: number | null;
  maxTokens: number | null;
}

export interface ContentEditorInteractionInput {
  fields?: Record<string, unknown> | null;
  currentEditorState?: unknown;
  references?: string | null;
}

const CONTENT_PROMPT_DELIMITER = 'SMRT_CONTENT_FIELD';

function readString(
  context: SessionContext,
  key: keyof ContentChatAISelection,
): string | null {
  const value = context[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(
  context: SessionContext,
  key: keyof ContentChatAISelection,
): number | null {
  const value = context[key];
  return typeof value === 'number' ? value : null;
}

export function inferProviderFromModel(model: string): string {
  const normalized = model.toLowerCase();
  const providerPrefix = normalized.match(/^([a-z0-9_-]+)\//)?.[1];
  if (providerPrefix === 'openrouter') {
    return 'openrouter';
  }
  if (providerPrefix === 'anthropic') {
    return 'anthropic';
  }
  if (providerPrefix === 'gemini' || providerPrefix === 'google') {
    return 'gemini';
  }
  if (providerPrefix === 'openai') {
    return 'openai';
  }

  const modelTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (
    modelTokens.includes('claude') ||
    modelTokens.includes('sonnet') ||
    modelTokens.includes('haiku') ||
    modelTokens.includes('opus')
  ) {
    return 'anthropic';
  }

  if (modelTokens.includes('gemini')) {
    return 'gemini';
  }

  return 'openai';
}

export function getContentChatAISelection(
  context: SessionContext,
): ContentChatAISelection {
  const allowedModels = context.allowedModels;
  return {
    profile: readString(context, 'profile'),
    provider: readString(context, 'provider'),
    model: readString(context, 'model'),
    allowedModels:
      Array.isArray(allowedModels) &&
      allowedModels.every((value) => typeof value === 'string')
        ? allowedModels
        : null,
    temperature: readNumber(context, 'temperature'),
    maxTokens: readNumber(context, 'maxTokens'),
  };
}

export function resolveContentChatModelSelection(
  context: SessionContext,
  requestedModel: string | null | undefined,
  fallbackModel: string,
): { model: string; provider: string } {
  const stored = getContentChatAISelection(context);
  const model = requestedModel || stored.model || fallbackModel;
  const provider =
    stored.provider && stored.model && model === stored.model
      ? stored.provider
      : inferProviderFromModel(model);

  return { model, provider };
}

export function buildContentChatModelUpdates(
  context: SessionContext,
  requestedModel: string | null | undefined,
  fallbackModel: string,
): Record<string, string | null> {
  const stored = getContentChatAISelection(context);
  const { model, provider } = resolveContentChatModelSelection(
    context,
    requestedModel,
    fallbackModel,
  );

  return {
    model,
    provider,
    ...(stored.profile && stored.model && model !== stored.model
      ? { profile: null }
      : {}),
  };
}

export function buildContentEditorSessionContext(
  contentId: string,
  prompt: ResolvedPrompt,
): SessionContext {
  return {
    contentId,
    ...(prompt.ai.profile ? { profile: prompt.ai.profile } : {}),
    ...(prompt.ai.provider ? { provider: prompt.ai.provider } : {}),
    ...(prompt.ai.model ? { model: prompt.ai.model } : {}),
    ...(prompt.ai.allowedModels
      ? { allowedModels: prompt.ai.allowedModels }
      : {}),
    ...(prompt.ai.temperature !== undefined
      ? { temperature: prompt.ai.temperature }
      : {}),
    ...(prompt.ai.maxTokens !== undefined
      ? { maxTokens: prompt.ai.maxTokens }
      : {}),
  };
}

function displayValue(value: unknown, fallback = '(empty)'): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}

function delimitPromptValue(name: string, value: string): string {
  return `<<<${CONTENT_PROMPT_DELIMITER} name=${name}>>>\n${value.replace(/<<<(?:END_)?SMRT_[^>]*>>>/g, '')}\n<<<END_${CONTENT_PROMPT_DELIMITER}>>>`;
}

export function buildContentEditorInteractionVariables(
  input: ContentEditorInteractionInput,
): Record<string, string> {
  const fields = input.fields ?? {};

  return {
    title: delimitPromptValue('title', displayValue(fields.title)),
    description: delimitPromptValue(
      'description',
      displayValue(fields.description),
    ),
    type: displayValue(fields.type, 'article'),
    status: displayValue(fields.status, 'draft'),
    state: displayValue(fields.state, 'active'),
    body: delimitPromptValue(
      'body',
      displayValue(fields.body ?? input.currentEditorState),
    ),
    references: input.references ?? '',
  };
}
