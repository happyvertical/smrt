import type { ResolvedPrompt } from '@happyvertical/smrt-prompts';

type SessionContext = Record<string, unknown>;

export interface ContentChatAISelection {
  profile: string | null;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
}

export interface ContentEditorInteractionInput {
  fields?: Record<string, unknown> | null;
  currentEditorState?: unknown;
  references?: string | null;
}

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
  if (model.includes('claude')) {
    return 'anthropic';
  }

  if (model.includes('gemini')) {
    return 'gemini';
  }

  return 'openai';
}

export function getContentChatAISelection(
  context: SessionContext,
): ContentChatAISelection {
  return {
    profile: readString(context, 'profile'),
    provider: readString(context, 'provider'),
    model: readString(context, 'model'),
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

export function buildContentEditorInteractionVariables(
  input: ContentEditorInteractionInput,
): Record<string, string> {
  const fields = input.fields ?? {};

  return {
    title: displayValue(fields.title),
    description: displayValue(fields.description),
    type: displayValue(fields.type, 'article'),
    status: displayValue(fields.status, 'draft'),
    state: displayValue(fields.state, 'active'),
    body: displayValue(fields.body ?? input.currentEditorState),
    references: input.references ?? '',
  };
}
