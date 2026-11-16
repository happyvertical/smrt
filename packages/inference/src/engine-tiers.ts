/**
 * The default tier binding of an engine that is not an API key (#5005).
 *
 * An API key binds tiers through core's resolver (config, stored bindings).
 * A local agent CLI (Claude Code, Codex) and a ChatGPT plan sign-in have no
 * stored tier binding: their tiers bind to the engine's own models, ranked
 * strongest first. The tier a prompt asks for picks the model:
 *
 * | Tier            | Model                                  |
 * |-----------------|----------------------------------------|
 * | `best`, `great` | the strongest ranked model             |
 * | `good`          | the next strongest (else the strongest) |
 * | `cheap`         | the lowest ranked model                |
 * | `auto`          | the app's `defaultTier` (else `good`), as core resolves it |
 *
 * Ranks: Claude Code `fable` > `opus` > `sonnet`; Codex and ChatGPT
 * {@link OPENAI_MODEL_RANKS}. A ChatGPT plan ranks only the models its
 * signed-in catalog offers. Browser-safe: no `node:` import.
 */
import {
  getInferenceConfig,
  type InferenceTier,
  type InferenceTierRequest,
  isReasoningEffort,
  type ReasoningEffort,
  resolveAutoTier,
} from '@happyvertical/smrt-core';
import type { InferenceEngineId } from './engine-id.js';

/** A model an engine offers; only `intelligenceRank` orders strength. */
export interface RankedModel {
  id: string;
  label?: string;
  /** Larger is stronger. Catalog order is never strength. */
  intelligenceRank?: number;
}

/**
 * Reviewed 2026-11-12 against
 * https://learn.chatgpt.com/docs/models#recommended-models. App
 * recommendation data, NOT catalog response order or inferred name sorting.
 * Availability still comes from the signed-in account; unknown IDs stay
 * unranked.
 */
export const OPENAI_MODEL_RANKS: Readonly<Record<string, number>> =
  Object.freeze({
    'gpt-6-astra': 4,
    'gpt-6.1-sol': 3,
    'gpt-6.1-terra': 2,
    'gpt-6-luna': 1,
  });

/** Claude Code's model aliases, larger is stronger. */
export const CLAUDE_MODEL_RANKS: Readonly<Record<string, number>> =
  Object.freeze({ fable: 3, opus: 2, sonnet: 1 });

/** A catalog with OpenAI's recommendation ranks filled in where missing. */
export function rankOpenAIModels<T extends RankedModel>(
  catalog: readonly T[],
): T[] {
  return catalog.map((model) => {
    const rank = Number.isFinite(model.intelligenceRank)
      ? model.intelligenceRank
      : OPENAI_MODEL_RANKS[model.id];
    return {
      ...model,
      ...(rank === undefined ? {} : { intelligenceRank: rank }),
    };
  });
}

/** Ranked models only, strongest first. */
function ranked(catalog: readonly RankedModel[]): RankedModel[] {
  return catalog
    .filter((model) => Number.isFinite(model.intelligenceRank))
    .sort((a, b) => (b.intelligenceRank ?? 0) - (a.intelligenceRank ?? 0));
}

/** The strongest ranked model; explicit rank alone establishes strength. */
export function strongestModel(
  catalog: readonly RankedModel[],
): string | undefined {
  return ranked(catalog)[0]?.id;
}

/** The lowest ranked model. */
export function weakestModel(
  catalog: readonly RankedModel[],
): string | undefined {
  return ranked(catalog).at(-1)?.id;
}

/** The model one rank below `requested`, never an unknown or unranked one. */
export function nextModel(
  catalog: readonly RankedModel[],
  requested?: string,
): string | undefined {
  const rank = catalog.find(
    (model) => model.id === requested,
  )?.intelligenceRank;
  return rank === undefined
    ? undefined
    : strongestModel(
        catalog.filter((model) => (model.intelligenceRank ?? Infinity) < rank),
      );
}

/**
 * The ranked models an engine binds tiers to: Claude Code's aliases, Codex's
 * recommendation list, or a ChatGPT plan's signed-in catalog (ranked by
 * {@link OPENAI_MODEL_RANKS}). An API key has none: core binds its tiers.
 */
export function engineModels(
  engine: InferenceEngineId,
  catalog?: readonly RankedModel[],
): RankedModel[] {
  if (engine === 'claude-code')
    return (
      catalog ??
      Object.entries(CLAUDE_MODEL_RANKS).map(([id, intelligenceRank]) => ({
        id,
        intelligenceRank,
      }))
    ).map((model) => ({
      ...model,
      ...(Number.isFinite(model.intelligenceRank)
        ? {}
        : CLAUDE_MODEL_RANKS[model.id] === undefined
          ? {}
          : { intelligenceRank: CLAUDE_MODEL_RANKS[model.id] }),
    }));
  if (engine === 'codex')
    return rankOpenAIModels(
      catalog ?? Object.keys(OPENAI_MODEL_RANKS).map((id) => ({ id })),
    );
  if (engine === 'chatgpt') return rankOpenAIModels(catalog ?? []);
  return [];
}

/**
 * The tier `auto` stands for, as core resolves it: `defaultTier` when given,
 * else the app's `inference.defaultTier`, else `good`.
 */
export function concreteTier(
  tier: InferenceTierRequest,
  defaultTier?: InferenceTier,
): InferenceTier {
  if (tier !== 'auto') return tier;
  return defaultTier ?? resolveAutoTier(getInferenceConfig());
}

/**
 * The model an engine's default tier binding gives `tier` (table above).
 * `undefined` for an API key, or an engine with no ranked model.
 */
export function engineTierModel(input: {
  engine: InferenceEngineId;
  tier: InferenceTierRequest;
  /** The app's `inference.defaultTier`, for `auto`. */
  defaultTier?: InferenceTier;
  /** The models available; default the engine's own list. */
  catalog?: readonly RankedModel[];
}): string | undefined {
  const models = ranked(engineModels(input.engine, input.catalog));
  if (models.length === 0) return undefined;
  const tier = concreteTier(input.tier, input.defaultTier);
  if (tier === 'cheap') return models.at(-1)?.id;
  if (tier === 'good') return (models[1] ?? models[0]).id;
  return models[0].id;
}

/**
 * The next model in the engine's tier binding order after `model`: the step
 * taken when a plan refuses a model before any output.
 */
export function nextEngineModel(input: {
  engine: InferenceEngineId;
  model: string;
  catalog?: readonly RankedModel[];
}): string | undefined {
  return nextModel(engineModels(input.engine, input.catalog), input.model);
}

/**
 * How an engine takes a reasoning effort: Claude Code's `--effort` and an API
 * call's `reasoning.effort` take every value; Codex's
 * `model_reasoning_effort` has no `max` (sent as `xhigh`). A ChatGPT plan
 * sign-in records the effort but does not send it (its provider rejects
 * reasoning options), so this returns `undefined` for it.
 */
export function engineReasoningEffort(
  engine: InferenceEngineId,
  effort: ReasoningEffort | undefined,
): string | undefined {
  if (!effort || engine === 'chatgpt') return undefined;
  if (engine === 'codex' && effort === 'max') return 'xhigh';
  return effort;
}

/**
 * The effort an engine turn runs with. Precedence, high to low: the caller's
 * option, the prompt's `effort`, the tier binding's `params.reasoning.effort`
 * (the app's `inference.tiers` config; a value outside the validated set is
 * ignored), then none: the engine's own default. Nothing here defaults it.
 */
export function resolveEngineEffort(input: {
  caller?: ReasoningEffort;
  prompt?: ReasoningEffort;
  tier?: InferenceTierRequest;
}): ReasoningEffort | undefined {
  if (input.caller) return input.caller;
  if (input.prompt) return input.prompt;
  if (!input.tier) return undefined;
  const tiers = getInferenceConfig()?.tiers as
    | Partial<Record<InferenceTier, { params?: Record<string, unknown> }>>
    | undefined;
  const reasoning = tiers?.[concreteTier(input.tier)]?.params?.reasoning as
    | { effort?: unknown }
    | undefined;
  return isReasoningEffort(reasoning?.effort) ? reasoning.effort : undefined;
}

/** Safe as a single CLI option value as well as a provider model identifier. */
export function validateModelId(model: string): string {
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
    throw new Error('Invalid model id.');
  return model;
}
