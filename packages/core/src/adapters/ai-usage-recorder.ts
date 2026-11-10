/**
 * Public AI usage recorder (#3077).
 *
 * The normalize -> estimate cost -> handlers pipeline that `SmrtClass` runs for
 * its own `this.ai` client, made reachable from any AI client: per-call
 * `getAI()` clients, route handlers, and services that are not SMRT objects.
 *
 * - {@link createAiUsageRecorder} builds a standalone `onUsage` sink.
 * - {@link attachAiUsageRecorder} chains a sink onto an AI config's `onUsage`,
 *   keeping the caller's own callback.
 * - {@link setAiUsageTenantResolver} is the ambient-tenant slot smrt-tenancy
 *   fills at `enableTenancy()`, so a call made inside `withTenant()` is
 *   attributed to that tenant when nothing more specific names one.
 *
 * Browser-safe: no Node-only imports.
 */

import { createLogger } from '@happyvertical/logger';
import type {
  AiTokenUsage,
  AiUsageHandler,
  SmrtAiUsageEvent,
} from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { observeAiTranscriptUsage } from '../ai-transcripts.js';
import type { AiUsageConfig } from '../config.js';
import { config } from '../config.js';
import { AiUsagePersistenceHandler } from './ai-usage.js';
import { estimateAiUsageCost } from './cost-rates.js';

const logger = createLogger({ level: 'info' });

/** Usage config after merging the global and the local layer. */
export interface ResolvedAiUsageConfig {
  enabled: boolean;
  persist: boolean;
  estimateCosts: boolean;
  costRates?: Record<string, { input: number; output: number }>;
  handlers: AiUsageHandler[];
}

/**
 * Merge a global and a local {@link AiUsageConfig}: local scalars win, cost
 * rates merge (local over global), handlers concatenate (global first).
 */
export function resolveAiUsageConfig(
  globalUsage: AiUsageConfig | undefined,
  localUsage: AiUsageConfig | undefined,
): ResolvedAiUsageConfig {
  const global = globalUsage ?? {};
  const local = localUsage ?? {};
  return {
    enabled: local.enabled ?? global.enabled ?? true,
    persist: local.persist ?? global.persist ?? true,
    estimateCosts: local.estimateCosts ?? global.estimateCosts ?? true,
    costRates: {
      ...(global.costRates ?? {}),
      ...(local.costRates ?? {}),
    },
    handlers: [...(global.handlers ?? []), ...(local.handlers ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Ambient tenant slot
// ---------------------------------------------------------------------------

/**
 * Returns the tenant id of the current async scope, or `null`/`undefined`
 * when there is none (no tenant context, or a system context).
 */
export type AiUsageTenantResolver = () => string | null | undefined;

declare global {
  // eslint-disable-next-line no-var
  var __smrtAiUsageTenantResolver: AiUsageTenantResolver | undefined;
}

/**
 * Register the resolver usage attribution falls back to when neither the
 * caller nor the instance names a tenant. `@happyvertical/smrt-tenancy`
 * registers `getTenantId()` at `enableTenancy()` and clears it at
 * `disableTenancy()`; an application without smrt-tenancy may register its
 * own. Pass `undefined` to clear. Stored on `globalThis` so every loaded copy
 * of core shares it (same pattern as `setDispatchTenantResolver()`).
 */
export function setAiUsageTenantResolver(
  resolver: AiUsageTenantResolver | undefined,
): void {
  globalThis.__smrtAiUsageTenantResolver = resolver;
}

/** The registered ambient-tenant resolver, if any. */
export function getAiUsageTenantResolver(): AiUsageTenantResolver | undefined {
  return globalThis.__smrtAiUsageTenantResolver;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readAmbientAiUsageTenant(): string | undefined {
  const resolver = globalThis.__smrtAiUsageTenantResolver;
  if (!resolver) return undefined;
  try {
    return nonEmptyString(resolver());
  } catch {
    // A misbehaving resolver never breaks usage recording; attribute nothing.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Ambient user slot (#4760)
// ---------------------------------------------------------------------------

/**
 * Returns the user id of the current async scope's principal, or
 * `null`/`undefined` when there is none (jobs, service principals).
 */
export type AiUsageUserResolver = () => string | null | undefined;

/** The usage tag that names the acting user (#4760 per-user spend). */
export const AI_USAGE_USER_TAG = 'userId';

declare global {
  // eslint-disable-next-line no-var
  var __smrtAiUsageUserResolver: AiUsageUserResolver | undefined;
}

/**
 * Register the resolver whose user id every usage row records as the
 * `userId` tag when the event does not carry one. The hosted gate
 * (`@happyvertical/smrt-inference/gate`, #4760) registers the ambient
 * principal's user, because per-user spend caps sum `_smrt_ai_usage` by that
 * tag. Pass `undefined` to clear. Stored on `globalThis` like the tenant
 * slot.
 */
export function setAiUsageUserResolver(
  resolver: AiUsageUserResolver | undefined,
): void {
  globalThis.__smrtAiUsageUserResolver = resolver;
}

/** The registered ambient-user resolver, if any. */
export function getAiUsageUserResolver(): AiUsageUserResolver | undefined {
  return globalThis.__smrtAiUsageUserResolver;
}

function readAmbientAiUsageUser(): string | undefined {
  const resolver = globalThis.__smrtAiUsageUserResolver;
  if (!resolver) return undefined;
  try {
    return nonEmptyString(resolver());
  } catch {
    // A misbehaving resolver never breaks usage recording; attribute nothing.
    return undefined;
  }
}

/**
 * Resolve the tenant a usage event is attributed to:
 *
 * 1. `explicit` — a non-empty string wins; an explicit `null` means "global,
 *    do not consult the ambient context".
 * 2. `instance` — the owning object's non-empty `tenantId`.
 * 3. The ambient tenant from {@link setAiUsageTenantResolver}.
 * 4. Otherwise `instance` as given (`null` or `undefined`): never a guess.
 */
export function resolveAiUsageTenantId(
  explicit?: string | null,
  instance?: string | null,
): string | null | undefined {
  const explicitTenant = nonEmptyString(explicit);
  if (explicitTenant) return explicitTenant;
  if (explicit === null) return null;
  const instanceTenant = nonEmptyString(instance);
  if (instanceTenant) return instanceTenant;
  return readAmbientAiUsageTenant() ?? instance;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function firstString(...candidates: unknown[]): string | undefined {
  return candidates.find(
    (candidate): candidate is string => typeof candidate === 'string',
  );
}

function firstNumber(...candidates: unknown[]): number | undefined {
  return candidates.find(
    (candidate): candidate is number => typeof candidate === 'number',
  );
}

/** Read token counts from either the SMRT or the OpenAI-style field names. */
export function normalizeIncomingAiUsageTokens(
  value: unknown,
): AiTokenUsage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const promptTokens =
    typeof usage.promptTokens === 'number'
      ? usage.promptTokens
      : typeof usage.inputTokens === 'number'
        ? usage.inputTokens
        : undefined;
  const completionTokens =
    typeof usage.completionTokens === 'number'
      ? usage.completionTokens
      : typeof usage.outputTokens === 'number'
        ? usage.outputTokens
        : undefined;
  const totalTokens =
    typeof usage.totalTokens === 'number'
      ? usage.totalTokens
      : promptTokens !== undefined || completionTokens !== undefined
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return { promptTokens, completionTokens, totalTokens };
}

/** Stringify tag values and drop null/undefined ones; `undefined` if empty. */
export function normalizeAiUsageTags(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (tagValue === undefined || tagValue === null) continue;
    tags[key] = String(tagValue);
  }

  return Object.keys(tags).length > 0 ? tags : undefined;
}

/** A `Date` from a Date, ISO string, or epoch number; now when unparseable. */
export function normalizeAiUsageTimestamp(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

/** Attribution for {@link normalizeAiUsageEvent}. */
export interface AiUsageAttribution {
  className?: string;
  /** Already-resolved tenant (see {@link resolveAiUsageTenantId}). */
  tenantId?: string | null;
  /** Default tags; the event's own tags win on a key clash. */
  tags?: Record<string, string>;
}

/**
 * Turn a raw `onUsage` event into a {@link SmrtAiUsageEvent}. Provider and
 * model fall back to the client config; an event naming neither is dropped
 * (`undefined`).
 */
export function normalizeAiUsageEvent(
  event: unknown,
  aiConfig: Record<string, unknown> | undefined,
  attribution: AiUsageAttribution = {},
): SmrtAiUsageEvent | undefined {
  const raw = (event ?? {}) as Record<string, unknown>;
  const cfg = aiConfig ?? {};
  const provider = firstString(raw.provider, raw.type, cfg.provider, cfg.type);
  const model = firstString(
    raw.model,
    raw.defaultModel,
    cfg.model,
    cfg.defaultModel,
  );
  const operation =
    firstString(raw.operation, raw.kind, raw.method) ?? 'unknown';
  const usage =
    normalizeIncomingAiUsageTokens(raw.usage) ??
    normalizeIncomingAiUsageTokens(raw.tokenUsage) ??
    normalizeIncomingAiUsageTokens({
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
      totalTokens: raw.totalTokens,
    });

  if (!provider || !model) {
    return undefined;
  }

  const duration = firstNumber(raw.duration, raw.durationMs, raw.latency) ?? 0;
  const eventTags = normalizeAiUsageTags(raw.tags);
  // An explicit `userId` tag (attribution or event) wins; otherwise the
  // ambient principal's user, when a resolver is registered (#4760).
  const explicitUser =
    eventTags?.[AI_USAGE_USER_TAG] ?? attribution.tags?.[AI_USAGE_USER_TAG];
  const ambientUser = explicitUser ? undefined : readAmbientAiUsageUser();
  const tags =
    attribution.tags || eventTags || ambientUser
      ? normalizeAiUsageTags({
          ...(ambientUser ? { [AI_USAGE_USER_TAG]: ambientUser } : {}),
          ...(attribution.tags ?? {}),
          ...(eventTags ?? {}),
        })
      : undefined;

  return {
    provider,
    model,
    operation,
    usage,
    duration,
    timestamp: normalizeAiUsageTimestamp(raw.timestamp),
    tags,
    className: attribution.className,
    tenantId: attribution.tenantId,
  };
}

/**
 * Estimate the cost (when enabled) and hand the event to every handler. A
 * failing handler is logged and never rejects.
 */
export async function dispatchAiUsageEvent(
  event: SmrtAiUsageEvent,
  handlers: readonly AiUsageHandler[],
  usageConfig: ResolvedAiUsageConfig,
): Promise<void> {
  if (!usageConfig.enabled || handlers.length === 0) {
    return;
  }

  if (usageConfig.estimateCosts) {
    event.estimatedCost = estimateAiUsageCost(
      event.provider,
      event.model,
      event.usage,
      usageConfig.costRates,
    );
  }

  const results = await Promise.allSettled(
    handlers.map((handler) => handler.handle(event)),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(
        `[smrt] AI usage handler failed for ${event.provider}:${event.model}: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * An `onUsage` sink. Accepts the `@happyvertical/ai` `UsageEvent` (or any
 * object with the same fields) and never rejects.
 */
export type AiUsageRecorder = (event: unknown) => Promise<void>;

/** Options for {@link createAiUsageRecorder}. */
export interface CreateAiUsageRecorderOptions {
  /** Database for `_smrt_ai_usage` rows; omitted means no persistence. */
  db?: DatabaseInterface | null;
  /** Value of the `class_name` column (e.g. `'ComposeRoute'`). */
  className?: string;
  /**
   * Tenant to attribute. A string wins; `null` records a global row without
   * consulting the ambient tenant; omitted falls back to the ambient tenant.
   */
  tenantId?: string | null;
  /** Local usage config, merged over the global `config({ usage })`. */
  usage?: AiUsageConfig;
  /** Default tags merged under each event's own tags. */
  tags?: Record<string, string>;
  /**
   * Client config used as the provider/model fallback when an event omits
   * them (the same fallback the instance pipeline uses).
   */
  aiConfig?: Record<string, unknown>;
}

const AI_USAGE_SINK = Symbol.for('@happyvertical/smrt-core:aiUsageSink');

/**
 * Explicit attribution a sink carries. It travels with the sink: a pipeline
 * that replaces the sink (see {@link unwrapAiUsageSink}) applies it instead.
 */
export interface AiUsageSinkAttribution {
  /** Explicit tenant (`null` = global, skip the ambient tenant). */
  tenantId?: string | null;
  /** Default tags, under each event's own tags. */
  tags?: Record<string, string>;
}

interface AiUsageSinkBrand {
  /** The caller's own `onUsage` that a chained sink wraps, if any. */
  inner?: (event: unknown) => unknown;
  /** Explicit attribution of the sink, if any. */
  attribution?: AiUsageSinkAttribution;
}

function brandSink<T extends (event: unknown) => unknown>(
  fn: T,
  brand: AiUsageSinkBrand,
): T {
  Object.defineProperty(fn, AI_USAGE_SINK, { value: brand });
  return fn;
}

/**
 * Mark `fn` as a SMRT usage sink carrying `attribution`.
 *
 * @internal Used by `SmrtClass#withAiUsage()`.
 */
export function brandAiUsageSink<T extends (event: unknown) => unknown>(
  fn: T,
  attribution: AiUsageSinkAttribution,
): T {
  return brandSink(fn, { attribution });
}

function sinkBrand(fn: unknown): AiUsageSinkBrand | undefined {
  return typeof fn === 'function'
    ? ((fn as unknown as Record<symbol, AiUsageSinkBrand | undefined>)[
        AI_USAGE_SINK
      ] ?? undefined)
    : undefined;
}

/**
 * The explicit attribution of a sink `onUsage` (a recorder, a chained sink,
 * or a `withAiUsage()` sink); `undefined` for a plain callback.
 *
 * @internal Used by `SmrtClass` when it replaces a sink with its own pipeline.
 */
export function aiUsageSinkAttribution(
  onUsage: unknown,
): AiUsageSinkAttribution | undefined {
  return sinkBrand(onUsage)?.attribution;
}

/**
 * The caller's own part of an `onUsage` callback: a recorder or a chained
 * sink is removed (keeping the callback it wraps), so a pipeline that records
 * itself never records the same call twice. Non-sink callbacks are returned
 * unchanged.
 *
 * @internal Used by `SmrtClass` when it builds its own clients.
 */
export function unwrapAiUsageSink(
  onUsage: unknown,
): ((event: unknown) => unknown) | undefined {
  if (typeof onUsage !== 'function') return undefined;
  const brand = sinkBrand(onUsage);
  if (!brand) return onUsage as (event: unknown) => unknown;
  return brand.inner;
}

/**
 * Build a standalone `onUsage` sink that runs the SMRT usage pipeline:
 * normalize, estimate cost, then the persistence handler (when `db` is given
 * and `persist` is on) plus any configured handlers. Usage config is resolved
 * once, at creation, as global `config({ usage })` < `options.usage`.
 *
 * ```ts
 * const ai = await getAI(
 *   attachAiUsageRecorder(aiConfig, createAiUsageRecorder({ db, className: 'ComposeRoute' })),
 * );
 * ```
 */
export function createAiUsageRecorder(
  options: CreateAiUsageRecorderOptions = {},
): AiUsageRecorder {
  const usageConfig = resolveAiUsageConfig(
    config.toJSON().usage,
    options.usage,
  );
  const handlers: AiUsageHandler[] = [];
  if (usageConfig.enabled) {
    if (usageConfig.persist && options.db) {
      handlers.push(new AiUsagePersistenceHandler(options.db));
    }
    handlers.push(...usageConfig.handlers);
  }

  const recorder: AiUsageRecorder = async (event: unknown) => {
    // Transcript capture (#4780) reads the raw event first, whatever the
    // usage config says.
    observeAiTranscriptUsage(event);
    if (handlers.length === 0) return;
    try {
      const normalized = normalizeAiUsageEvent(event, options.aiConfig, {
        className: options.className,
        tenantId: resolveAiUsageTenantId(options.tenantId),
        tags: options.tags,
      });
      if (!normalized) return;
      await dispatchAiUsageEvent(normalized, handlers, usageConfig);
    } catch (error) {
      logger.warn(
        `[smrt] AI usage recorder failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  return brandSink(recorder, {
    attribution: { tenantId: options.tenantId, tags: options.tags },
  });
}

/**
 * Return a copy of `aiConfig` whose `onUsage` calls the caller's existing
 * `onUsage` first and then `recorder`. Attaching again replaces the previous
 * recorder rather than stacking a second one, so a call is recorded once.
 * The result carries `recorder`'s explicit attribution, so a `SmrtClass`
 * that later builds its own client from this config keeps the same tenant
 * and tags when it replaces the sink.
 */
export function attachAiUsageRecorder<T extends object>(
  aiConfig: T,
  recorder: (event: unknown) => unknown,
): T & { onUsage: (event: unknown) => Promise<void> } {
  const inner = unwrapAiUsageSink((aiConfig as { onUsage?: unknown }).onUsage);
  const onUsage = async (event: unknown): Promise<void> => {
    // Transcript capture (#4780) reads the raw event before the caller's
    // (possibly async) callback; the recorder observes it again, harmlessly.
    observeAiTranscriptUsage(event);
    try {
      if (inner) await inner(event);
    } finally {
      await recorder(event);
    }
  };
  return {
    ...aiConfig,
    onUsage: brandSink(onUsage, {
      inner,
      attribution: sinkBrand(recorder)?.attribution,
    }),
  };
}
