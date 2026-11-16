/**
 * One step down the engine's tier binding order when a plan refuses a model
 * (#5005): never another connection, never after output or a tool ran.
 * Browser-safe.
 */
import type { ReasoningEffort } from '@happyvertical/smrt-core';
import type { InferenceEngineId } from './engine-id.js';
import { validateModelId } from './engine-tiers.js';

/**
 * What one engine execution did: the engine, the requested and the
 * provider-reported model, the effort, time, tokens and tool calls. A host
 * reads it through `recordExecution`; it is never stored on a chat message.
 */
export interface EngineExecution {
  engine: InferenceEngineId;
  /** Provider-reported; unknown when the engine omits it. */
  model?: string;
  /** The model sent to the engine. */
  requestedModel?: string;
  effort?: ReasoningEffort;
  durationMs: number;
  tokens?: number;
  toolCalls: number;
  fallback?: { from: string; to: string; reason: 'plan-model-refused' };
}

/** Fixed shared words: never interpolate vendor error text. */
export const MODEL_FALLBACK_MESSAGE =
  'Your plan does not include the strongest model. I’m using the next strongest model on the same connection.';

/** Remembers, per owner and connection, the model a refusal stepped to. */
export interface ModelFallbackStore {
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

/** One step only, only a classified plan refusal before any output or tool execution. */
export async function runWithModelFallback<T>(input: {
  ownerId: string;
  /** Changes when the account, its catalog or the engine changes. */
  connectionKey: string;
  engine: InferenceEngineId;
  /** The model the tier binding chose. */
  model: string;
  nextModel?: string;
  store: ModelFallbackStore;
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
  fallback?: EngineExecution['fallback'];
}> {
  validateModelId(input.model);
  if (input.nextModel !== undefined) validateModelId(input.nextModel);
  const remembered = await input.store.read(
    input.ownerId,
    input.engine,
    input.model,
    input.connectionKey,
  );
  const model = validateModelId(remembered ?? input.model);
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
      input.engine,
      input.model,
      input.connectionKey,
      input.nextModel,
    );
    input.notify(MODEL_FALLBACK_MESSAGE);
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
