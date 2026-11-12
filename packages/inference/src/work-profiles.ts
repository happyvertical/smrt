import type { InferenceEngineId } from './engine-id.js';

/** Host-selected intelligence and budget; never tool authority. */
export type WorkProfileName = 'design' | 'assist' | 'background';
export type WorkReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface WorkProfileBudgets {
  maxSteps: number;
  maxTokens: number;
  maxTurnTokens: number;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  maxRunTokens: number;
  runTimeoutMs: number;
  passes: number;
  repairRetries: number;
  toolResultChars: number;
}
export interface WorkProfileSettings {
  engine?: InferenceEngineId;
  model?: string;
  effort?: WorkReasoningEffort;
  budgets?: Partial<WorkProfileBudgets>;
  autoEscalate?: boolean;
  previewBeforeApply?: boolean;
}
export interface ResolvedWorkProfile {
  name: WorkProfileName;
  engine: InferenceEngineId;
  model?: string;
  effort: WorkReasoningEffort;
  tier: 'best' | 'good' | 'cheap';
  budgets: WorkProfileBudgets;
  autoEscalate: boolean;
  previewBeforeApply: boolean;
  /** Derived display evidence only; model remains the immutable requested selection. */
  modelSelection?: {
    kind: 'strongest' | 'custom' | 'configured' | 'fallback';
    requestedModel?: string;
    resolvedModel?: string;
  };
}
export interface WorkModelCatalogEntry {
  id: string;
  label?: string;
  /** Host/catalog intelligence order, larger is stronger. */
  intelligenceRank?: number;
}
export interface WorkRunMetadata {
  profile: WorkProfileName;
  engine: InferenceEngineId;
  model?: string;
  effort: WorkReasoningEffort;
  /** Explicit alias/selection sent to the engine. model is provider-reported. */
  requestedModel?: string;
  durationMs: number;
  tokens?: number;
  toolCalls: number;
  fallback?: { from: string; to: string; reason: 'plan-model-refused' };
}

/** New objects on each call: owner edits cannot mutate recommended defaults. */
export function recommendedWorkProfile(
  name: WorkProfileName,
): WorkProfileSettings & {
  effort: WorkReasoningEffort;
  budgets: WorkProfileBudgets;
  autoEscalate: boolean;
  previewBeforeApply: boolean;
} {
  const design = name === 'design';
  const background = name === 'background';
  return {
    effort: design ? 'max' : background ? 'low' : 'high',
    autoEscalate: true,
    previewBeforeApply: true,
    budgets: {
      maxSteps: design ? 64 : background ? 4 : 24,
      maxTokens: design ? 32_768 : background ? 2_048 : 16_384,
      maxTurnTokens: design ? 400_000 : background ? 8_000 : 160_000,
      requestTimeoutMs: design ? 600_000 : background ? 60_000 : 180_000,
      turnTimeoutMs: design ? 1_800_000 : background ? 120_000 : 600_000,
      maxRunTokens: design ? 2_000_000 : background ? 8_000 : 160_000,
      runTimeoutMs: design ? 7_200_000 : background ? 120_000 : 600_000,
      passes: design ? 4 : 1,
      repairRetries: design ? 2 : 1,
      toolResultChars: design ? 120_000 : background ? 12_000 : 40_000,
    },
  };
}

/** Safe as a single CLI option value as well as a provider model identifier. */
export function validateWorkModel(model: string): string {
  if (
    typeof model !== 'string' ||
    model.length === 0 ||
    model.length > 200 ||
    /^-|\s/.test(model) ||
    [...model].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid work profile model.');
  return model;
}

/** Reviewed 2026-11-12 against https://learn.chatgpt.com/docs/models#recommended-models.
 * App recommendation data, NOT catalog response order or inferred model-name sorting.
 * Availability still comes from the signed-in account; unknown IDs stay unranked.
 */
export const OPENAI_WORK_MODEL_RANKS: Readonly<Record<string, number>> =
  Object.freeze({
    'gpt-6-astra': 4,
    'gpt-6.1-sol': 3,
    'gpt-6.1-terra': 2,
    'gpt-6-luna': 1,
  });

export function rankOpenAIWorkModels<T extends WorkModelCatalogEntry>(
  catalog: readonly T[],
): T[] {
  return catalog.map((model) => {
    const rank = Number.isFinite(model.intelligenceRank)
      ? model.intelligenceRank
      : OPENAI_WORK_MODEL_RANKS[model.id];
    return {
      ...model,
      ...(rank === undefined ? {} : { intelligenceRank: rank }),
    };
  });
}

/** One lower verified recommendation, never another connection or unknown model. */
export function nextWorkModel(
  catalog: readonly WorkModelCatalogEntry[],
  requested?: string,
): string | undefined {
  const rank = catalog.find(
    (model) => model.id === requested,
  )?.intelligenceRank;
  return rank === undefined
    ? undefined
    : strongestWorkModel(
        catalog.filter((model) => (model.intelligenceRank ?? Infinity) < rank),
      );
}

/** Only explicit intelligence metadata establishes strength; catalog order is not quality. */
export function strongestWorkModel(
  catalog: readonly WorkModelCatalogEntry[],
): string | undefined {
  return [...catalog]
    .filter((model) => Number.isFinite(model.intelligenceRank))
    .sort((a, b) => (b.intelligenceRank ?? 0) - (a.intelligenceRank ?? 0))[0]
    ?.id;
}

export function resolveWorkProfile(input: {
  profile?: WorkProfileName;
  engine: InferenceEngineId;
  settings?: WorkProfileSettings;
  catalog?: readonly WorkModelCatalogEntry[];
  claudeModels?: readonly string[];
}): ResolvedWorkProfile {
  const name = input.profile ?? 'assist';
  const defaults = recommendedWorkProfile(name);
  const settings = input.settings ?? {};
  const engine = settings.engine ?? input.engine;
  const budgets = { ...defaults.budgets, ...settings.budgets };
  for (const [key, value] of Object.entries(budgets)) {
    if (
      !Number.isSafeInteger(value) ||
      value < (key === 'repairRetries' ? 0 : 1)
    )
      throw new RangeError(`Invalid work profile budget: ${key}`);
  }
  const claudeModels = input.claudeModels ?? ['fable', 'opus', 'sonnet'];
  const claude = ['fable', 'opus', 'sonnet'].find((model) =>
    claudeModels.includes(model),
  );
  const strongest = strongestWorkModel(
    input.catalog ??
      (engine === 'codex'
        ? rankOpenAIWorkModels(
            Object.keys(OPENAI_WORK_MODEL_RANKS).map((id) => ({ id })),
          )
        : []),
  );
  const model =
    settings.model ??
    (engine === 'api'
      ? undefined
      : (strongest ??
        (engine === 'claude-code'
          ? name === 'background' && claudeModels.includes('sonnet')
            ? 'sonnet'
            : claude
          : undefined)));
  if (model !== undefined) validateWorkModel(model);
  if (engine !== 'api' && !model)
    throw new Error('The connected engine has no available model.');
  return {
    name,
    engine,
    ...(model ? { model } : {}),
    effort: settings.effort ?? defaults.effort,
    tier: name === 'background' ? 'cheap' : 'best',
    budgets,
    autoEscalate: settings.autoEscalate ?? defaults.autoEscalate,
    previewBeforeApply:
      settings.previewBeforeApply ?? defaults.previewBeforeApply,
    modelSelection: {
      kind:
        settings.model !== undefined
          ? 'custom'
          : model !== undefined &&
              (model === strongest ||
                (engine === 'claude-code' && model === 'fable'))
            ? 'strongest'
            : 'configured',
      ...(model ? { requestedModel: model, resolvedModel: model } : {}),
    },
  };
}

/** Fixed shared words: never interpolate vendor error text. */
export const WORK_MODEL_FALLBACK_MESSAGE =
  'Your plan does not include the strongest model. I’m using the next strongest model on the same connection.';

export interface WorkModelFallbackStore {
  read(
    ownerId: string,
    engine: InferenceEngineId,
    requestedModel: string,
    connectionKey: string,
  ): Promise<string | undefined>;
  write(
    ownerId: string,
    engine: InferenceEngineId,
    requestedModel: string,
    connectionKey: string,
    model: string,
  ): Promise<void>;
}

/** Read-only Settings projection over the execution memo, without changing its request key. */
export async function projectWorkModelSelection(input: {
  ownerId: string;
  connectionKey: string;
  profile: ResolvedWorkProfile;
  store: Pick<WorkModelFallbackStore, 'read'>;
}): Promise<ResolvedWorkProfile> {
  const requested = input.profile.model;
  if (!requested) return input.profile;
  validateWorkModel(requested);
  const remembered = await input.store.read(
    input.ownerId,
    input.profile.engine,
    requested,
    input.connectionKey,
  );
  if (remembered === undefined || remembered === requested)
    return input.profile;
  return {
    ...input.profile,
    modelSelection: {
      kind: 'fallback',
      requestedModel: requested,
      resolvedModel: validateWorkModel(remembered),
    },
  };
}

/** One step only, only a classified plan refusal before any output or tool execution. */
export async function runWorkModelWithFallback<T>(input: {
  ownerId: string;
  /** Changes when account/catalog or the owner selection changes. */
  connectionKey: string;
  profile: ResolvedWorkProfile;
  nextModel?: string;
  store: WorkModelFallbackStore;
  /** Must report effects before publishing text or executing any tool. */
  execute(
    model: string,
    activity: { markOutput(): void; markToolExecution(): void },
  ): Promise<T>;
  isPlanModelRefusal(error: unknown): boolean;
  notify(message: string): void;
}): Promise<{
  result: T;
  model: string;
  fallback?: WorkRunMetadata['fallback'];
}> {
  if (!input.profile.model) throw new Error('A model is required.');
  validateWorkModel(input.profile.model);
  if (input.nextModel !== undefined) validateWorkModel(input.nextModel);
  const remembered = await input.store.read(
    input.ownerId,
    input.profile.engine,
    input.profile.model,
    input.connectionKey,
  );
  const model = validateWorkModel(remembered ?? input.profile.model);
  let emittedOrExecuted = false;
  const activity = {
    markOutput() {
      emittedOrExecuted = true;
    },
    markToolExecution() {
      emittedOrExecuted = true;
    },
  };
  try {
    return { result: await input.execute(model, activity), model };
  } catch (error) {
    if (
      emittedOrExecuted ||
      remembered ||
      !input.nextModel ||
      input.nextModel === model ||
      !input.isPlanModelRefusal(error)
    )
      throw error;
    const result = await input.execute(input.nextModel, activity);
    await input.store.write(
      input.ownerId,
      input.profile.engine,
      input.profile.model,
      input.connectionKey,
      input.nextModel,
    );
    input.notify(WORK_MODEL_FALLBACK_MESSAGE);
    return {
      result,
      model: input.nextModel,
      fallback: {
        from: model,
        to: input.nextModel,
        reason: 'plan-model-refused',
      },
    };
  }
}
