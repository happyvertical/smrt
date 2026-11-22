/**
 * Run tracking on an AI client (#5005): a call whose options carry a
 * `runContext` (an {@link AiRunContext}) is a tracked call of that run. It is
 * reserved before it is sent, sent with its own call id and the run's usage
 * tags (and the output limit its reservation decided), and settled with its
 * usage row afterwards. A call without `runContext` is sent exactly as
 * before. `runContext` and `expectedOutputTokens` never reach the provider.
 *
 * The call's ledger (#5516): a client that declares `usageFeatures.parts`
 * (sdk#1576) is billed in parts mode, every other client in single mode,
 * decided here from the declared capability and never from a provider name.
 * The call's usage events reach it through the secret its usage tags carry
 * (the provider-level callback looks the call up by that secret), and core's
 * own tag names (`aiCallId`, `aiCallProof`) are removed from what a caller
 * passes before the SDK sees it. The call is priced from the rate its
 * reservation recorded, never from the rate card at completion.
 *
 * `SmrtClass` wraps every provider-bound client (one per target, so each
 * alias-chain candidate actually sent is its own call) with
 * {@link withAiRunTracking}, and the client of a chain or fusion executor
 * with {@link withAiRunEntryCallId}, which gives the entry call the id its
 * calls share.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import {
  type CallUsageMode,
  withCallInternals,
  withObservedParts,
  withoutClaimTags,
} from './system/ai-call-ledger.js';
import type { AiCallRate } from './system/ai-run-accounting.js';
import {
  type AiRunCallRequest,
  type AiRunContext,
  type AiRunObservedUsage,
  beginAiRunCall,
  isAiRunContext,
} from './system/ai-run-calls.js';
import { newAiRunId } from './system/ai-run-model.js';

/** What a tracked client needs from its owner. */
export interface AiRunClientHooks {
  /** The provider and model the client sends to. */
  target(): { provider: string; model: string };
  /** The rate card entry, or null for an uncosted call. */
  rateFor(provider: string, model: string): AiCallRate | null;
  className?: string;
  tenantId?(): string | null | undefined;
  /**
   * The billed row's first two tag sources, read when a call is admitted:
   * the sink attribution's tags and the client's provider-level tags.
   */
  attribution?(): Record<string, string> | undefined;
  /** The usage handlers, run once the settlement committed. */
  afterSettle(event: SmrtAiUsageEvent): Promise<void>;
}

const TRACKED_METHODS = new Set(['message', 'chat', 'complete']);
const TRACKED = Symbol.for('@happyvertical/smrt-core:aiRunTracked');

type Options = Record<string, unknown> & {
  usageTags?: Record<string, string>;
};

function splitOptions(raw: unknown): {
  context: AiRunContext | undefined;
  expectedOutputTokens: number | undefined;
  options: Options;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { context: undefined, expectedOutputTokens: undefined, options: {} };
  }
  const { runContext, expectedOutputTokens, ...options } = raw as Options & {
    runContext?: unknown;
    expectedOutputTokens?: unknown;
  };
  return {
    context: isAiRunContext(runContext) ? runContext : undefined,
    expectedOutputTokens:
      typeof expectedOutputTokens === 'number'
        ? expectedOutputTokens
        : undefined,
    options: withoutClaimOptions(options),
  };
}

/** `options` with core's claim tags removed from its `usageTags`. */
function withoutClaimOptions(options: Options): Options {
  const tags = options.usageTags;
  const stripped = withoutClaimTags(tags);
  return stripped === tags ? options : { ...options, usageTags: stripped };
}

/** An untracked call's raw options, its claim tags removed when present. */
function untrackedOptions(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return withoutClaimOptions(raw as Options);
}

/** The client's declared capability (sdk#1576 R6): parts mode, else single. */
function usageModeOf(client: unknown): CallUsageMode {
  const features = (client as { usageFeatures?: { parts?: unknown } } | null)
    ?.usageFeatures;
  return features?.parts === true ? 'parts' : 'single';
}

/**
 * The usage a response reports (`chat()` answers carry `usage` and `model`),
 * for a client whose usage never reaches the pipeline: a single-mode call is
 * then settled with it; a parts-mode response's `usageParts` folds as parts.
 */
function observedUsage(
  result: unknown,
  duration: number,
): AiRunObservedUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const { usage, model, usageParts } = result as {
    usage?: Record<string, unknown>;
    model?: unknown;
    usageParts?: unknown;
  };
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  const promptTokens = count(usage?.promptTokens);
  const completionTokens = count(usage?.completionTokens);
  const totalTokens =
    count(usage?.totalTokens) ??
    (promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined);
  const observed: AiRunObservedUsage = {
    duration,
    ...(typeof model === 'string' && model ? { model } : {}),
    ...(totalTokens !== undefined
      ? {
          usage: {
            promptTokens: promptTokens ?? 0,
            completionTokens: completionTokens ?? 0,
            totalTokens,
          },
        }
      : {}),
  };
  return usageParts === undefined
    ? observed
    : withObservedParts(observed, usageParts);
}

function inputChars(input: unknown): number {
  if (typeof input === 'string') return input.length;
  try {
    return JSON.stringify(input ?? '').length;
  } catch {
    return 0;
  }
}

function request(
  hooks: AiRunClientHooks,
  client: unknown,
  operation: string,
  input: unknown,
  options: Options,
  expectedOutputTokens: number | undefined,
): AiRunCallRequest {
  const target = hooks.target();
  const provider = target.provider;
  const model =
    typeof options.model === 'string' ? options.model : target.model;
  const tenantId = hooks.tenantId?.();
  const attributionTags = hooks.attribution?.();
  return withCallInternals<AiRunCallRequest>(
    {
      ...(options.usageTags?.callId
        ? { entryCallId: options.usageTags.callId }
        : {}),
      inputChars: inputChars(input),
      ...(typeof options.maxTokens === 'number'
        ? { outputLimit: options.maxTokens }
        : {}),
      ...(expectedOutputTokens !== undefined ? { expectedOutputTokens } : {}),
      rate: hooks.rateFor(provider, model),
      fallbackUsage: {
        provider,
        model,
        operation,
        ...(options.usageTags ? { tags: options.usageTags } : {}),
        ...(hooks.className ? { className: hooks.className } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      },
      afterSettle: (event) => hooks.afterSettle(event),
      ...(options.signal instanceof AbortSignal
        ? { signal: options.signal }
        : {}),
    },
    {
      mode: usageModeOf(client),
      ...(attributionTags ? { attributionTags } : {}),
    },
  );
}

function sendOptions(
  options: Options,
  invocation: {
    usageTags: Record<string, string>;
    outputLimit: number | null;
    signal: AbortSignal | undefined;
  },
): Options {
  return {
    ...options,
    usageTags: { ...(options.usageTags ?? {}), ...invocation.usageTags },
    ...(invocation.outputLimit !== null
      ? { maxTokens: invocation.outputLimit }
      : {}),
    ...(invocation.signal ? { signal: invocation.signal } : {}),
  };
}

const wrappers = new WeakMap<object, WeakMap<AiRunClientHooks, object>>();

/**
 * `client` with run tracking on `message`, `chat`, `complete` and `stream`.
 * Cached per client and hooks, so identity is stable.
 */
export function withAiRunTracking<T>(client: T, hooks: AiRunClientHooks): T {
  if (!client || typeof client !== 'object') return client;
  if ((client as Record<symbol, unknown>)[TRACKED]) return client;
  let byHooks = wrappers.get(client as object);
  const cached = byHooks?.get(hooks);
  if (cached) return cached as T;
  const proxy = new Proxy(client as object, {
    get(target, property, receiver) {
      if (property === TRACKED) return true;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }
      if (TRACKED_METHODS.has(property)) {
        return async (input: unknown, raw?: unknown, ...rest: unknown[]) => {
          const split = splitOptions(raw);
          if (!split.context) {
            return raw === undefined
              ? value.call(target, input, ...rest)
              : value.call(target, input, untrackedOptions(raw), ...rest);
          }
          const handle = await beginAiRunCall(
            split.context,
            request(
              hooks,
              target,
              property,
              input,
              split.options,
              split.expectedOutputTokens,
            ),
          );
          const started = Date.now();
          let result: unknown;
          try {
            result = await value.call(
              target,
              input,
              sendOptions(split.options, handle.invocation),
              ...rest,
            );
          } catch (error) {
            throw await handle.fail(error);
          }
          await handle.succeed(observedUsage(result, Date.now() - started));
          return result;
        };
      }
      if (property === 'stream') {
        return (input: unknown, raw?: unknown, ...rest: unknown[]) => {
          const split = splitOptions(raw);
          if (!split.context) {
            return raw === undefined
              ? value.call(target, input, ...rest)
              : value.call(target, input, untrackedOptions(raw), ...rest);
          }
          const context = split.context;
          return (async function* () {
            const handle = await beginAiRunCall(
              context,
              request(
                hooks,
                target,
                'stream',
                input,
                split.options,
                split.expectedOutputTokens,
              ),
            );
            let failed = false;
            try {
              const iterable = value.call(
                target,
                input,
                sendOptions(split.options, handle.invocation),
                ...rest,
              ) as AsyncIterable<unknown>;
              for await (const chunk of iterable) yield chunk;
            } catch (error) {
              failed = true;
              throw await handle.fail(error);
            } finally {
              if (!failed) {
                // Finished, or the consumer stopped reading: what was used
                // is settled.
                await handle.succeed();
              }
            }
          })();
        };
      }
      return value.bind(target);
    },
  });
  if (!byHooks) {
    byHooks = new WeakMap();
    wrappers.set(client as object, byHooks);
  }
  byHooks.set(hooks, proxy);
  return proxy as T;
}

const ENTRY_WRAPPED = new WeakMap<object, object>();

/**
 * An executor's client (an alias chain, a fusion) whose tracked calls get
 * one entry call id, shared by every call it sends (page section 2). Calls
 * without `runContext`, or that already carry a `callId` tag, pass as they
 * are.
 */
export function withAiRunEntryCallId<T>(client: T): T {
  if (!client || typeof client !== 'object') return client;
  const cached = ENTRY_WRAPPED.get(client as object);
  if (cached) return cached as T;
  const proxy = new Proxy(client as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof value !== 'function' ||
        typeof property !== 'string' ||
        !(TRACKED_METHODS.has(property) || property === 'stream')
      ) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (input: unknown, raw?: unknown, ...rest: unknown[]) => {
        const options = raw as Options | undefined;
        if (
          !options ||
          typeof options !== 'object' ||
          !isAiRunContext((options as { runContext?: unknown }).runContext) ||
          options.usageTags?.callId
        ) {
          return raw === undefined
            ? value.call(target, input, ...rest)
            : value.call(target, input, raw, ...rest);
        }
        return value.call(
          target,
          input,
          {
            ...options,
            usageTags: { ...(options.usageTags ?? {}), callId: newAiRunId() },
          },
          ...rest,
        );
      };
    },
  });
  ENTRY_WRAPPED.set(client as object, proxy);
  return proxy as T;
}
