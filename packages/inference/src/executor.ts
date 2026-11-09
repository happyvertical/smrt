/**
 * The chain executor (#4752): runs `alias` and `candidates` tier targets.
 *
 * Per call it expands the resolved target into ordered candidates and tries
 * them in turn. A failure is classified (`classify.ts`); `transient` retries
 * the same candidate once after a jittered delay, every class then advances.
 * When a tier's chain is spent and `inference.degrade !== false`, the walk
 * moves down the ladder (never up), stopping at `minimumTier`. Each move is
 * a substitution `{ from, to, reason }` carried in the answering call's
 * `substitutions` usage tag with `tierResolved` set to the tier that
 * answered; a call that never answered records one zero-token row through
 * core's usage pipeline and throws {@link InferenceExhaustedError}.
 *
 * Text already streamed to the caller is never extended by another
 * candidate: a candidate that emitted text and then failed ends the walk
 * with a `partial` substitution (the caller gets the error unless
 * `allowPartial`).
 *
 * Before calling a candidate the walk checks its capabilities (#4758,
 * `context.capabilitiesFor()`) against the request: JSON mode for a
 * `responseFormat`, tool calling for `tools`. A mismatch the caller permits
 * a fallback for (`capabilityFallback`) runs the candidate without the
 * feature, tagged `capabilityFallback`; any other mismatch is a
 * `missing-capability` substitution and the walk advances without a call.
 *
 * The executor imports no SDK: it drives the clients core builds through
 * `context.clientFor()`, so tests run it with fake clients.
 */
import {
  compareInferenceTiers,
  INFERENCE_TIERS,
  type InferenceCallOptions,
  type InferenceCapabilityFallbackOption,
  type InferenceExecutionContext,
  type InferenceModelClient,
  type InferenceTarget,
  type InferenceTier,
  isInferenceUnavailableError,
} from '@happyvertical/smrt-core';
import { classifyInferenceFailure, isInferenceAbort } from './classify.js';
import {
  type ChainStep,
  expandTarget,
  validateInferenceConfig,
  validateInferenceTarget,
} from './config.js';
import { InferenceExhaustedError } from './errors.js';
import type {
  InferenceFailureClass,
  InferenceSubstitution,
  InferenceSubstitutionReason,
} from './types.js';

/** Test seams for the executor; production uses the defaults. */
export interface ChainExecutorOptions {
  /** Delay before the one transient retry. Default 200–500 ms, jittered. */
  retryDelayMs?: () => number;
  /** Sleep implementation. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the failure row's duration. */
  now?: () => number;
}

type Outcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      cls: InferenceFailureClass | undefined;
      error: unknown;
      emitted: string;
    };

/** A refusal that arrived as a finish reason, not an error. */
class RefusalSignal extends Error {
  readonly code = 'CONTENT_FILTERED';
}

/** A candidate skipped before its call for a missing capability (#4758). */
class MissingCapabilitySignal extends Error {
  readonly code = 'MISSING_CAPABILITY';
  constructor(
    label: string,
    readonly missing: string[],
    readonly source: string,
  ) {
    super(`${label} lacks ${missing.join(' and ')} (capabilities: ${source})`);
    this.name = 'MissingCapabilitySignal';
  }
}

/** How one candidate's call is reshaped for its capabilities. */
interface CapabilityAdjustment {
  dropJson?: boolean;
  dropTools?: boolean;
  /** `capabilityFallback` tag values. */
  fallbacks: string[];
}

type CapabilityFit =
  | { ok: true; adjust?: CapabilityAdjustment }
  | { ok: false; error: MissingCapabilitySignal };

function wantsJson(options: InferenceCallOptions): boolean {
  const type = (options.responseFormat as { type?: unknown } | undefined)?.type;
  return type === 'json_object' || type === 'json_schema';
}

function wantsTools(options: InferenceCallOptions): boolean {
  return Array.isArray(options.tools) && options.tools.length > 0;
}

const REFUSAL_FINISH = new Set(['refusal', 'content_filter']);

function lowerTier(tier: InferenceTier): InferenceTier | undefined {
  const index = INFERENCE_TIERS.indexOf(tier);
  return index > 0 ? INFERENCE_TIERS[index - 1] : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Invoke<T> = (
  client: InferenceModelClient,
  options: InferenceCallOptions,
  emit: (chunk: string) => void,
) => Promise<T>;

function method(
  client: InferenceModelClient,
  name: string,
): (...args: unknown[]) => unknown {
  const fn = client[name];
  if (typeof fn !== 'function') {
    throw new TypeError(`Inference client does not implement ${name}().`);
  }
  return (fn as (...args: unknown[]) => unknown).bind(client);
}

class ChainCall {
  private readonly started: number;
  private readonly substitutions: InferenceSubstitution[] = [];
  private lastStep: ChainStep | undefined;

  constructor(
    private readonly context: InferenceExecutionContext,
    private readonly options: Required<ChainExecutorOptions>,
    private readonly operation: string,
    private readonly callerOptions: InferenceCallOptions,
  ) {
    this.started = options.now();
  }

  private get tierRequested(): string {
    return (
      this.callerOptions.usageTags?.tierRequested ?? this.context.request.tier
    );
  }

  /**
   * Check a candidate's capabilities against the request before calling it
   * (#4758). Without a detector (older core) or a requirement, it fits.
   */
  private async capabilityFit(step: ChainStep): Promise<CapabilityFit> {
    // The options the candidate would receive: its params under the caller's.
    const effective: InferenceCallOptions = {
      ...(step.params ?? {}),
      ...this.callerOptions,
    };
    const json = wantsJson(effective);
    const tools = wantsTools(effective);
    if ((!json && !tools) || !this.context.capabilitiesFor) return { ok: true };
    let capabilities: Awaited<
      ReturnType<NonNullable<InferenceExecutionContext['capabilitiesFor']>>
    >;
    try {
      capabilities = await this.context.capabilitiesFor(step.target);
    } catch {
      // Detection never decides a failure: the call itself will surface a
      // real problem (an unbound key, an unreachable endpoint), classified.
      return { ok: true };
    }
    const fallback: InferenceCapabilityFallbackOption =
      this.callerOptions.capabilityFallback ?? {};
    const adjust: CapabilityAdjustment = { fallbacks: [] };
    const missing: string[] = [];
    if (json && !capabilities.json) {
      if (fallback.json === 'text') {
        adjust.dropJson = true;
        adjust.fallbacks.push('json→text');
      } else missing.push('json');
    }
    if (tools && !capabilities.tools) {
      if (fallback.tools === 'drop') {
        adjust.dropTools = true;
        adjust.fallbacks.push('tools→none');
      } else missing.push('tools');
    }
    if (missing.length > 0) {
      return {
        ok: false,
        error: new MissingCapabilitySignal(
          step.label,
          missing,
          capabilities.source,
        ),
      };
    }
    return adjust.fallbacks.length > 0 ? { ok: true, adjust } : { ok: true };
  }

  private callOptions(
    step: ChainStep,
    emit: (chunk: string) => void,
    finish: { reason?: string; replay: Array<() => void> },
    adjust?: CapabilityAdjustment,
  ): InferenceCallOptions {
    const {
      usageTags: callerTags,
      onProgress,
      onFinishReason,
      onRefusal,
      // Executor-only: never reaches a provider.
      capabilityFallback: _capabilityFallback,
      ...rest
    } = this.callerOptions as InferenceCallOptions & {
      onProgress?: (chunk: string) => void;
      onFinishReason?: (reason: string) => void;
      onRefusal?: (refusal: unknown) => void;
    };
    const model =
      typeof step.target.model === 'string' ? step.target.model : undefined;
    const options: InferenceCallOptions = {
      ...(step.params ?? {}),
      ...rest,
      // A candidate names its own model; a caller model cannot follow the
      // call onto another provider.
      ...(model ? { model } : {}),
      usageTags: {
        ...(callerTags ?? {}),
        // The candidate's own binding origin wins over the chain's (#4760):
        // a hosted candidate's spend must meter as hosted.
        ...(typeof step.target.source === 'string' && step.target.source
          ? { source: step.target.source }
          : {}),
        tierRequested: this.tierRequested,
        tierResolved: step.tier,
        ...(this.substitutions.length > 0
          ? { substitutions: JSON.stringify(this.substitutions) }
          : {}),
        ...(adjust && adjust.fallbacks.length > 0
          ? { capabilityFallback: adjust.fallbacks.join(',') }
          : {}),
      },
      ...(onProgress
        ? {
            onProgress: (chunk: string) => {
              emit(chunk);
              onProgress(chunk);
            },
          }
        : {}),
      // Finish callbacks are held until this candidate's answer is kept, so
      // a refused candidate the walk skips never reaches the caller.
      onFinishReason: (reason: string) => {
        finish.reason = reason;
        if (onFinishReason) finish.replay.push(() => onFinishReason(reason));
      },
      ...(onRefusal
        ? {
            onRefusal: (refusal: unknown) => {
              finish.replay.push(() => onRefusal(refusal));
            },
          }
        : {}),
    };
    // After the merge, so a candidate's own params cannot bring back a
    // feature its fallback removed (#4758).
    if (adjust?.dropJson) delete options.responseFormat;
    if (adjust?.dropTools) delete options.tools;
    return options;
  }

  private async attemptOnce<T>(
    step: ChainStep,
    invoke: Invoke<T>,
    isRefusal: ((value: T) => boolean) | undefined,
    adjust?: CapabilityAdjustment,
  ): Promise<Outcome<T>> {
    let emitted = '';
    const emit = (chunk: string) => {
      emitted += chunk;
    };
    const finish: { reason?: string; replay: Array<() => void> } = {
      replay: [],
    };
    try {
      const client = await this.context.clientFor(step.target);
      const value = await invoke(
        client,
        this.callOptions(step, emit, finish, adjust),
        emit,
      );
      const refused =
        (finish.reason !== undefined && REFUSAL_FINISH.has(finish.reason)) ||
        (isRefusal?.(value) ?? false);
      if (refused && emitted === '') {
        return {
          ok: false,
          cls: 'refusal',
          error: new RefusalSignal(`${step.label} declined the request`),
          emitted,
        };
      }
      for (const replay of finish.replay) replay();
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        cls: classifyInferenceFailure(error),
        error,
        emitted,
      };
    }
  }

  private async attempt<T>(
    step: ChainStep,
    invoke: Invoke<T>,
    isRefusal: ((value: T) => boolean) | undefined,
    adjust?: CapabilityAdjustment,
  ): Promise<Outcome<T>> {
    const first = await this.attemptOnce(step, invoke, isRefusal, adjust);
    if (first.ok || first.cls !== 'transient' || first.emitted !== '') {
      return first;
    }
    await this.options.sleep(this.options.retryDelayMs());
    return this.attemptOnce(step, invoke, isRefusal, adjust);
  }

  private async recordFailure(
    outcome: 'failed' | 'partial',
    reason: InferenceSubstitutionReason | 'unclassified',
  ): Promise<void> {
    const step = this.lastStep;
    // Nothing answered, so no tier resolved: drop the tag core added up
    // front, or #4751 would lift a failed tier into tier_resolved.
    const { tierResolved: _unanswered, ...callerTags } =
      this.callerOptions.usageTags ?? {};
    try {
      await this.context.recordUsage({
        ...(typeof step?.target.provider === 'string'
          ? { provider: step.target.provider }
          : {}),
        ...(typeof step?.target.model === 'string'
          ? { model: step.target.model }
          : {}),
        operation: this.operation,
        duration: Math.max(0, this.options.now() - this.started),
        tags: {
          ...callerTags,
          tierRequested: this.tierRequested,
          outcome,
          reason,
          substitutions: JSON.stringify(this.substitutions),
        },
      });
    } catch {
      // Recording must never mask the call's own failure.
    }
  }

  async run<T>(
    invoke: Invoke<T>,
    isRefusal?: (value: T) => boolean,
    partialValue?: (text: string) => T,
  ): Promise<T> {
    const { context } = this;
    const attempted = new Set<string>();
    let pending:
      | { label: string; reason: InferenceFailureClass; error?: unknown }
      | undefined;
    let tier = context.resolution.tierResolved;
    let steps = expandResolved(context.resolution.target, tier, context.config);

    for (;;) {
      for (const step of steps) {
        if (attempted.has(step.identity)) continue;
        attempted.add(step.identity);
        if (pending) {
          this.substitutions.push({
            from: pending.label,
            to: step.label,
            reason: pending.reason,
          });
        }
        pending = undefined;
        this.lastStep = step;
        if (step.unavailable) {
          pending = { label: step.label, reason: step.unavailable };
          continue;
        }
        const fit = await this.capabilityFit(step);
        if (!fit.ok) {
          // Skipped before the call: no model ran for this candidate.
          pending = {
            label: step.label,
            reason: 'missing-capability',
            error: fit.error,
          };
          continue;
        }

        const outcome = await this.attempt(step, invoke, isRefusal, fit.adjust);
        if (outcome.ok) return outcome.value;

        if (outcome.emitted !== '') {
          this.substitutions.push({
            from: step.label,
            to: null,
            reason: 'partial',
          });
          await this.recordFailure('partial', outcome.cls ?? 'unclassified');
          if (context.allowPartial && partialValue) {
            return partialValue(outcome.emitted);
          }
          throw new InferenceExhaustedError({
            reason: 'partial',
            substitutions: [...this.substitutions],
            tierRequested: this.tierRequested,
            partialText: outcome.emitted,
            cause: outcome.error,
          });
        }
        if (outcome.cls === undefined) {
          // Not a routing failure: a caller abort records nothing (nothing
          // ran to completion by choice), nor does a hosted-gate block
          // (`AI_UNAVAILABLE`, #4760: core already wrote its `blocked`
          // row); anything else is recorded and rethrown as the caller's
          // own error.
          if (
            !isInferenceAbort(outcome.error) &&
            !isInferenceUnavailableError(outcome.error)
          ) {
            // The trail always ends with `to: null` on a failure row.
            this.substitutions.push({
              from: step.label,
              to: null,
              reason: 'unclassified',
            });
            await this.recordFailure('failed', 'unclassified');
          }
          throw outcome.error;
        }
        pending = {
          label: step.label,
          reason: outcome.cls,
          error: outcome.error,
        };
      }

      if (context.config?.degrade === false) break;
      const next = lowerTier(tier);
      if (!next) break;
      if (
        context.minimumTier &&
        compareInferenceTiers(next, context.minimumTier) < 0
      ) {
        break;
      }
      const resolution = await context.resolveTier(next);
      // A lower tier that may not run (#4757: explicit mode with no binding
      // of its kind, or `off`) ends the ladder. Its empty target would
      // otherwise expand to the configured client and send the call to a
      // provider the principal's mode excludes.
      if (resolution.unavailable) break;
      tier = resolution.tierResolved;
      steps = expandResolved(resolution.target, tier, context.config);
    }

    if (pending) {
      this.substitutions.push({
        from: pending.label,
        to: null,
        reason: pending.reason,
      });
    }
    const reason = pending?.reason ?? 'unclassified';
    await this.recordFailure('failed', reason);
    throw new InferenceExhaustedError({
      reason,
      substitutions: [...this.substitutions],
      tierRequested: this.tierRequested,
      cause: pending?.error,
    });
  }
}

/** Validate a resolved target (config or resolver-sourced), then expand it. */
function expandResolved(
  target: InferenceTarget,
  tier: InferenceTier,
  config: InferenceExecutionContext['config'],
): ChainStep[] {
  validateInferenceTarget(target, `resolution.${tier}`, config);
  return expandTarget(target, tier, config);
}

/** Async queue backing `stream()`; closing it stops the producer. */
function createChunkQueue(onClose: () => void) {
  const chunks: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let closed = false;
  let failure: { error: unknown } | undefined;
  return {
    /** True once the consumer stopped reading. */
    get closed() {
      return closed;
    },
    push(chunk: string) {
      if (closed) return;
      chunks.push(chunk);
      wake?.();
    },
    end(error?: { error: unknown }) {
      done = true;
      failure = error;
      wake?.();
    },
    async *drain(): AsyncGenerator<string> {
      try {
        for (;;) {
          if (chunks.length > 0) {
            yield chunks.shift() as string;
            continue;
          }
          if (done) {
            if (failure) throw failure.error;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        // The consumer finished, threw, or broke out early: stop the
        // provider stream instead of reading (and paying for) the rest.
        if (!done) {
          closed = true;
          chunks.length = 0;
          onClose();
        }
      }
    },
  };
}

function isRefusalResponse(value: unknown): boolean {
  const reason = (value as { finishReason?: unknown } | null)?.finishReason;
  return typeof reason === 'string' && REFUSAL_FINISH.has(reason);
}

let lastValidated: string | undefined;

function validateChainConfig(config: InferenceExecutionContext['config']) {
  const key = JSON.stringify(config ?? null);
  if (key === lastValidated) return;
  validateInferenceConfig(config);
  lastValidated = key;
}

/**
 * A client whose calls walk the chain in `context.resolution`. `message`,
 * `chat`, `complete` and `stream` walk; `embed` uses the first candidate
 * that can run.
 */
export function createChainClient(
  context: InferenceExecutionContext,
  options: ChainExecutorOptions = {},
): InferenceModelClient {
  // Validate here too, not only in the resolver: a resolver registered after
  // this package replaces ours, and a chain must never run half-configured.
  validateChainConfig(context.config);
  const resolved: Required<ChainExecutorOptions> = {
    retryDelayMs: options.retryDelayMs ?? (() => 200 + Math.random() * 300),
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? (() => Date.now()),
  };
  const call = (operation: string, callerOptions?: InferenceCallOptions) =>
    new ChainCall(context, resolved, operation, callerOptions ?? {});

  return {
    message(text: string, callerOptions?: InferenceCallOptions) {
      return call('message', callerOptions).run<string>(
        (client, opts) => client.message(text, opts),
        undefined,
        (partial) => partial,
      );
    },
    chat(messages: unknown, callerOptions?: InferenceCallOptions) {
      return call('chat', callerOptions).run<unknown>(
        (client, opts) =>
          Promise.resolve(method(client, 'chat')(messages, opts)),
        isRefusalResponse,
      );
    },
    complete(prompt: string, callerOptions?: InferenceCallOptions) {
      return call('complete', callerOptions).run<unknown>(
        (client, opts) =>
          Promise.resolve(method(client, 'complete')(prompt, opts)),
        isRefusalResponse,
      );
    },
    stream(messages: unknown, callerOptions?: InferenceCallOptions) {
      const controller = new AbortController();
      const queue = createChunkQueue(() => controller.abort());
      const callerSignal = (callerOptions as { signal?: AbortSignal })?.signal;
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
      call('stream', { ...(callerOptions ?? {}), signal })
        .run<void>(
          async (client, opts, emit) => {
            const iterable = method(client, 'stream')(
              messages,
              opts,
            ) as AsyncIterable<string>;
            // Breaking out of for-await calls the provider iterator's
            // return(), which ends its request.
            for await (const chunk of iterable) {
              if (queue.closed) break;
              emit(chunk);
              queue.push(chunk);
            }
          },
          undefined,
          () => undefined,
        )
        .then(
          () => queue.end(),
          (error: unknown) => queue.end({ error }),
        );
      return queue.drain();
    },
    async embed(...args: unknown[]) {
      const steps = expandTarget(
        context.resolution.target,
        context.resolution.tierResolved,
        context.config,
      );
      const step = steps.find((candidate) => !candidate.unavailable);
      if (!step) {
        throw new InferenceExhaustedError({
          reason: steps[0]?.unavailable ?? 'unclassified',
          substitutions: [],
          tierRequested: context.request.tier,
        });
      }
      const client = await context.clientFor(step.target);
      return method(client, 'embed')(...args);
    },
  };
}
