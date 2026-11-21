/**
 * Hosted spend holds (#5489): every call sent to a `source: hosted` target
 * reserves its estimated cost against the plan caps before it is sent.
 *
 * - **Per send.** The hosted gate is asked before each `message`, `chat`,
 *   `complete` and `stream` call on a hosted client, not once when the
 *   client is built: a kept client stops at a cap or a kill switch like a
 *   fresh one.
 * - **Hold, then check.** Before the gate is asked, the call's estimate (the
 *   run accounting's reservation size: input characters / 4 plus the output
 *   limit, or the declared or default output allowance, at the model's rate)
 *   is written as one hold row in `_smrt_ai_usage` (`operation:
 *   'hosted-hold'`, id `hosted-hold:<uuid>`, `source: hosted`, the metered
 *   user and tenant). The spend reader counts it like spend, so the gate's
 *   answer includes this call's own estimate and every other call's hold
 *   that committed before the read: of two calls in flight at once, the one
 *   that checks later sees both. A call whose estimate would bring spend to
 *   the cap is refused. No lock is taken; under contention both calls can be
 *   refused, never both allowed past the cap on their estimates.
 * - **Release or settle.** A refused or failed call drops its hold. A call
 *   that answered drops its hold once its usage row is written (a call of a
 *   run: by its settlement, before the call returns; any other call: when
 *   its usage event has been recorded, or after a grace period when none
 *   arrives). A call outside a run whose usage reports neither tokens nor
 *   cost is recorded at its held estimate (`usageEstimate: reservation`).
 * - **Stale holds.** A hold whose process stopped is counted until it is
 *   {@link HOSTED_AI_HOLD_TTL_MS} old; spend readers then ignore it.
 *   Usage readers that count calls exclude hold rows
 *   ({@link HOSTED_AI_HOLD_ROW_SQL}).
 *
 * Holds are written only while a gate is registered, the client's usage is
 * persisted to a database, and the call's model is priced.
 */

import { isAiRunContext } from './system/ai-run-calls.js';

/** The `operation` of a hosted spend hold row. */
export const HOSTED_AI_HOLD_OPERATION = 'hosted-hold';

/** How long an unreleased hold counts as spend. */
export const HOSTED_AI_HOLD_TTL_MS = 60 * 60 * 1000;

/** A SQL predicate matching hosted spend hold rows of `_smrt_ai_usage`. */
export const HOSTED_AI_HOLD_ROW_SQL = `(operation = '${HOSTED_AI_HOLD_OPERATION}' AND id LIKE '${HOSTED_AI_HOLD_OPERATION}:%')`;

/** Whether a `_smrt_ai_usage` row (its `operation` and `id`) is a hold. */
export function isHostedAiHoldRow(row: {
  operation?: unknown;
  id?: unknown;
}): boolean {
  return (
    row.operation === HOSTED_AI_HOLD_OPERATION &&
    String(row.id ?? '').startsWith(`${HOSTED_AI_HOLD_OPERATION}:`)
  );
}

/**
 * The tag linking a call outside a run to its hold while it is in flight.
 * Never persisted: core removes it before the usage row is written.
 *
 * @internal
 */
export const HOSTED_AI_HOLD_TAG = 'hostedHold';

/** How long a call's hold waits for its usage event after the call ended. */
const HOSTED_AI_HOLD_GRACE_MS = 60_000;

/** What the hosted hold wrapper needs from its owner. */
export interface HostedHoldHooks {
  /** The call's estimated cost in USD (0 for an unpriced model). */
  estimate(input: unknown, options: Record<string, unknown>): number;
  /** Write a hold of `cost` USD; its row id, or undefined when not held. */
  place(cost: number): Promise<string | undefined>;
  /** Delete a hold row. Never throws. */
  drop(holdId: string): Promise<void>;
  /** The hosted gate for this send; throws on a block. */
  check(): Promise<void>;
  /** Whether calls carrying a run context are tracked calls of that run. */
  runTracking: boolean;
}

/** The in-flight state of a call outside a run, keyed by its hold tag. */
interface HoldWatch {
  cost: number;
  ended: boolean;
  recorded: boolean;
  release: () => void;
}

const watches = new Map<string, HoldWatch>();

/**
 * Called by the usage pipeline for an event of a call outside a run: a
 * held call's usage that reports neither tokens nor cost is given its held
 * estimate. Removes the hold tag. Returns a callback to run once the event
 * has been recorded.
 *
 * @internal
 */
export function applyHostedAiHold(event: {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  estimatedCost?: number;
  tags?: Record<string, string>;
}): (() => void) | undefined {
  const key = event.tags?.[HOSTED_AI_HOLD_TAG];
  if (key === undefined) return undefined;
  const { [HOSTED_AI_HOLD_TAG]: _key, ...tags } = event.tags ?? {};
  event.tags = tags;
  const watch = watches.get(key);
  if (!watch) return undefined;
  const usage = event.usage;
  const reported = [
    usage?.promptTokens,
    usage?.completionTokens,
    usage?.totalTokens,
    event.estimatedCost,
  ].some((value) => typeof value === 'number' && Number.isFinite(value));
  if (!reported && watch.cost > 0) {
    event.estimatedCost = watch.cost;
    event.tags = { ...tags, usageEstimate: 'reservation' };
  }
  return () => {
    watch.recorded = true;
    if (watch.ended) watch.release();
  };
}

const HELD_METHODS = new Set(['message', 'chat', 'complete', 'stream']);

/** Copy the call's options once (`runContext` read once, prototype included). */
function copyOptions(raw: unknown): Record<PropertyKey, unknown> {
  const copy: Record<PropertyKey, unknown> = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const source = raw as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(source)) {
      if (key === 'runContext') continue;
      if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
      copy[key] = source[key];
    }
    const runContext = source.runContext;
    if (runContext !== undefined) copy.runContext = runContext;
  }
  return copy;
}

/** One call's hold, from before the gate is asked until it is released. */
async function holdCall(
  hooks: HostedHoldHooks,
  input: unknown,
  options: Record<PropertyKey, unknown>,
): Promise<{
  options: Record<PropertyKey, unknown>;
  failed: () => Promise<void>;
  answered: () => void;
}> {
  const cost = hooks.estimate(input, options as Record<string, unknown>);
  const holdId = cost > 0 ? await hooks.place(cost) : undefined;
  let dropped = false;
  const drop = async () => {
    if (dropped || holdId === undefined) return;
    dropped = true;
    await hooks.drop(holdId);
  };
  try {
    await hooks.check();
  } catch (error) {
    await drop();
    throw error;
  }
  const tracked = hooks.runTracking && isAiRunContext(options.runContext);
  if (tracked || holdId === undefined) {
    // A call of a run writes its usage row in its settlement, before the
    // call returns; an unheld call has nothing to release.
    return { options, failed: drop, answered: () => void drop() };
  }
  const key = crypto.randomUUID();
  const watch: HoldWatch = {
    cost,
    ended: false,
    recorded: false,
    release: () => {
      watches.delete(key);
      void drop();
    },
  };
  watches.set(key, watch);
  const own = options.usageTags;
  return {
    options: {
      ...options,
      usageTags: {
        ...(own !== null && typeof own === 'object'
          ? (own as Record<string, string>)
          : {}),
        [HOSTED_AI_HOLD_TAG]: key,
      },
    },
    failed: async () => {
      watches.delete(key);
      await drop();
    },
    answered: () => {
      watch.ended = true;
      if (watch.recorded) {
        watch.release();
        return;
      }
      const timer = setTimeout(watch.release, HOSTED_AI_HOLD_GRACE_MS);
      (timer as { unref?: () => void }).unref?.();
    },
  };
}

const wrapped = new WeakMap<object, WeakMap<HostedHoldHooks, object>>();

/**
 * `client` with a hosted spend hold and a gate check around every model
 * call. Cached per client and hooks.
 */
export function withHostedInferenceHolds<T>(
  client: T,
  hooks: HostedHoldHooks,
): T {
  if (!client || typeof client !== 'object') return client;
  let byHooks = wrapped.get(client as object);
  const cached = byHooks?.get(hooks);
  if (cached) return cached as T;
  const proxy = new Proxy(client as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }
      if (!HELD_METHODS.has(property)) return value.bind(target);
      if (property === 'stream') {
        return (input: unknown, raw?: unknown, ...rest: unknown[]) =>
          (async function* () {
            const held = await holdCall(hooks, input, copyOptions(raw));
            let failed = false;
            try {
              yield* value.call(
                target,
                input,
                held.options,
                ...rest,
              ) as AsyncIterable<unknown>;
            } catch (error) {
              failed = true;
              await held.failed();
              throw error;
            } finally {
              // Finished, or the consumer stopped reading.
              if (!failed) held.answered();
            }
          })();
      }
      return async (input: unknown, raw?: unknown, ...rest: unknown[]) => {
        const held = await holdCall(hooks, input, copyOptions(raw));
        let result: unknown;
        try {
          result = await value.call(target, input, held.options, ...rest);
        } catch (error) {
          await held.failed();
          throw error;
        }
        held.answered();
        return result;
      };
    },
  });
  if (!byHooks) {
    byHooks = new WeakMap();
    wrapped.set(client as object, byHooks);
  }
  byHooks.set(hooks, proxy);
  return proxy as T;
}
