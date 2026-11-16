/**
 * Run tracking on an AI client (#5005): a call whose options carry a
 * `runContext` (an {@link AiRunContext}) is a tracked call of that run. It is
 * reserved before it is sent, sent with its own call id and the run's usage
 * tags (and the output limit its reservation decided), and settled with its
 * usage row afterwards. A call without `runContext` is sent exactly as
 * before. `runContext` and `expectedOutputTokens` never reach the provider.
 *
 * `SmrtClass` wraps every provider-bound client (one per target, so each
 * alias-chain candidate actually sent is its own call) with
 * {@link withAiRunTracking}, and the client of a chain or fusion executor
 * with {@link withAiRunEntryCallId}, which gives the entry call the id its
 * calls share.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
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
  /** Route the usage event tagged with this call id to `capture`. */
  registerCapture(
    callId: string,
    capture: (event: SmrtAiUsageEvent) => void,
  ): () => void;
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
    options,
  };
}

/**
 * The usage a response reports (`chat()` answers carry `usage` and `model`),
 * for a client whose usage never reaches the pipeline: the call is then
 * settled with it instead of a zero-token row.
 */
function observedUsage(
  result: unknown,
  duration: number,
): AiRunObservedUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const { usage, model } = result as {
    usage?: Record<string, unknown>;
    model?: unknown;
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
  return {
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
  return {
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
  };
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
              : value.call(target, input, raw, ...rest);
          }
          const handle = await beginAiRunCall(
            split.context,
            request(
              hooks,
              property,
              input,
              split.options,
              split.expectedOutputTokens,
            ),
          );
          const release = hooks.registerCapture(
            handle.invocation.callId,
            (event) => handle.invocation.capture(event),
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
            release();
            throw await handle.fail(error);
          }
          release();
          const observed = observedUsage(result, Date.now() - started);
          const sentTo = hooks.target();
          const rate = hooks.rateFor(
            sentTo.provider,
            observed?.model ?? sentTo.model,
          );
          if (observed?.usage && rate) {
            observed.estimatedCost =
              ((observed.usage.promptTokens ?? 0) * rate.input +
                (observed.usage.completionTokens ?? 0) * rate.output) /
              1000;
          }
          await handle.succeed(observed);
          return result;
        };
      }
      if (property === 'stream') {
        return (input: unknown, raw?: unknown, ...rest: unknown[]) => {
          const split = splitOptions(raw);
          if (!split.context) {
            return raw === undefined
              ? value.call(target, input, ...rest)
              : value.call(target, input, raw, ...rest);
          }
          const context = split.context;
          return (async function* () {
            const handle = await beginAiRunCall(
              context,
              request(
                hooks,
                'stream',
                input,
                split.options,
                split.expectedOutputTokens,
              ),
            );
            const release = hooks.registerCapture(
              handle.invocation.callId,
              (event) => handle.invocation.capture(event),
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
              release();
              throw await handle.fail(error);
            } finally {
              if (!failed) {
                release();
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
