/**
 * The inference availability probe and its HTTP helper (#4757).
 *
 * `getInferenceStatus()` / `isInferenceAvailable()` answer "would an AI call
 * run here?" for the ambient principal without calling a model or writing
 * `_smrt_ai_usage`. `createInferenceStatusHandler()` serves that answer as
 * JSON for a SvelteKit `+server.ts` (and backs the generated REST
 * `_inference` route), so a settings page or a feature flag can hide AI
 * actions. The body is an {@link InferenceStatus}: never a key, endpoint or
 * model.
 *
 * Browser-safe: no `@happyvertical/ai`, no Node built-ins.
 */

import {
  type AIExplicitConfig,
  getAIConfigBlock,
  tryResolveAIProviderConfig,
} from '@happyvertical/smrt-config';
import { config as globalConfig } from './config.js';
import {
  type InferenceResolver,
  type InferenceTierRequest,
  inferenceModeForTarget,
  inferenceTargetKind,
  isInferenceTierRequest,
  resolveInference,
  resolveInferenceMode,
} from './inference.js';
import {
  type InferenceStatus,
  inferenceUnavailableStatus,
} from './inference-availability.js';
import {
  checkInferenceGate,
  inferenceGateRequest,
  isHostedInferenceTarget,
} from './inference-gate.js';
import { inferenceTargetIdentity } from './inference-target.js';

/** Options for {@link getInferenceStatus}. */
export interface InferenceStatusOptions {
  /** Probe a tier (`auto` included). Omitted: the untiered call path. */
  tier?: InferenceTierRequest;
  /** Tenant the call would act for; the resolver also reads the ambient one. */
  tenantId?: string | null;
  /** `null`: a client shared beyond one user (no user binding applies). */
  userId?: null;
  className?: string;
  /** Resolver to use instead of the registered one. */
  resolver?: InferenceResolver;
  /**
   * The configured client's options, when the caller has its own (an
   * instance `ai`, a route's provider). Default: the process `ai` config,
   * the smrt.config `ai` block, then `SMRT_AI_*`, as `SmrtClass` reads them.
   */
  configured?: Record<string, unknown> | null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

/**
 * The provider/baseUrl of the process-level configured AI client, the way
 * `SmrtClass` builds it (process `ai` config > smrt.config `ai` block with a
 * provider > `SMRT_AI_*`), or `undefined` when none is configured. Never
 * returns the key.
 */
export function configuredAiProvider():
  | { provider?: string; baseUrl?: string }
  | undefined {
  const explicit = (globalConfig.toJSON().ai ?? {}) as Record<string, unknown>;
  const declared = getAIConfigBlock();
  const block = declared?.provider ? declared : null;
  const resolved = tryResolveAIProviderConfig({
    explicit: explicit as AIExplicitConfig,
    config: block,
    prefixes: ['SMRT_AI'],
    autoDetect: false,
    requireProvider: false,
    providerKeyEnvFallback: Boolean(block),
  });
  const provider =
    text(resolved?.provider) ?? text(explicit.provider) ?? text(explicit.type);
  if (!provider && !text(resolved?.apiKey) && !text(explicit.apiKey)) {
    return undefined;
  }
  const baseUrl = text(resolved?.baseUrl) ?? text(explicit.baseUrl);
  return {
    ...(provider ? { provider } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/**
 * Whether an AI call would run, and why not (#4757). With `tier` the binding
 * is resolved through the registered resolver exactly as a tier call would;
 * without, the resolver's optional `mode()` decides first (`off` is
 * unavailable, an explicit mode is probed as `auto`), then the configured
 * client. Never calls a model; records nothing.
 */
export async function getInferenceStatus(
  options: InferenceStatusOptions = {},
): Promise<InferenceStatus> {
  const configured =
    options.configured === undefined
      ? configuredAiProvider()
      : (options.configured ?? undefined);
  const scope = {
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.userId === null ? { userId: null } : {}),
    ...(options.className ? { className: options.className } : {}),
  };
  const resolverOption = options.resolver ? { resolver: options.resolver } : {};
  if (options.tier === undefined) {
    const state = await resolveInferenceMode(scope, resolverOption);
    if (state?.unavailable) {
      return inferenceUnavailableStatus(state.unavailable, state.mode);
    }
    if (state) {
      // An explicit stored mode routes untiered calls through `auto`.
      const { tier: _tier, ...routed } = await getInferenceStatus({
        ...options,
        tier: 'auto',
      });
      return routed;
    }
    if (!configured) return inferenceUnavailableStatus('unconfigured');
    return {
      available: true,
      mode: inferenceModeForTarget(undefined, configured),
    };
  }
  const resolution = await resolveInference(
    { tier: options.tier, ...scope },
    resolverOption,
  );
  const tier = resolution.tierResolved;
  if (resolution.unavailable) {
    return inferenceUnavailableStatus(
      resolution.unavailable,
      resolution.mode,
      tier,
    );
  }
  const target = resolution.target ?? {};
  if (
    inferenceTargetKind(target) === 'single' &&
    !inferenceTargetIdentity(target).provider &&
    !configured
  ) {
    return inferenceUnavailableStatus('unconfigured', undefined, tier);
  }
  if (isHostedInferenceTarget(target)) {
    // The hosted gate (#4760), asked as a probe: decide, record nothing.
    const decision = await checkInferenceGate({
      ...inferenceGateRequest({ tier: options.tier, ...scope }, resolution),
      probe: true,
    });
    if (decision.action === 'block') {
      return inferenceUnavailableStatus(
        'entitlement',
        'hosted',
        tier,
        decision.details,
      );
    }
  }
  return {
    available: true,
    mode: inferenceModeForTarget(resolution, configured),
    tier,
  };
}

/** `true` when {@link getInferenceStatus} reports `available`. */
export async function isInferenceAvailable(
  options: InferenceStatusOptions = {},
): Promise<boolean> {
  return (await getInferenceStatus(options)).available;
}

/** Options for {@link createInferenceStatusHandler}. */
export interface InferenceStatusHandlerOptions
  extends Omit<InferenceStatusOptions, 'tier'> {
  /** Tier probed when the request names none. Omitted: untiered. */
  tier?: InferenceTierRequest;
  /** Read `?tier=` from the request (default `true`). */
  tierParam?: boolean;
  /**
   * Run the probe inside the host's principal context (for example
   * smrt-tenancy's `withTenant()`), when the request's handle hook has not
   * already entered it. The per-user resolver reads the ambient principal.
   */
  run?: <T>(event: InferenceStatusEvent, probe: () => Promise<T>) => Promise<T>;
}

/** The part of a SvelteKit `RequestEvent` the handler reads. */
export interface InferenceStatusEvent {
  url: URL;
  request?: Request;
  locals?: unknown;
}

function statusJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Answer one status request: `{ available, mode, reason?, tier? }` as JSON
 * (`cache-control: no-store`), 400 for an unknown `?tier=`, 500 without
 * detail when the resolver fails.
 */
export async function inferenceStatusResponse(
  event: InferenceStatusEvent,
  options: InferenceStatusHandlerOptions = {},
): Promise<Response> {
  const { tierParam = true, run, tier: defaultTier, ...probe } = options;
  const requested = tierParam
    ? (event.url.searchParams.get('tier') ?? undefined)
    : undefined;
  if (requested !== undefined && !isInferenceTierRequest(requested)) {
    return statusJson({ error: 'Unknown inference tier.' }, 400);
  }
  const tier = requested ?? defaultTier;
  const probeStatus = () =>
    getInferenceStatus({ ...probe, ...(tier ? { tier } : {}) });
  try {
    const status = run ? await run(event, probeStatus) : await probeStatus();
    return statusJson(status);
  } catch {
    return statusJson({ error: 'Inference status is unavailable.' }, 500);
  }
}

/**
 * A SvelteKit `GET` handler for an inference status endpoint:
 *
 * ```ts
 * // src/routes/api/inference-status/+server.ts
 * import { createInferenceStatusHandler } from '@happyvertical/smrt-core';
 * export const GET = createInferenceStatusHandler();
 * ```
 */
export function createInferenceStatusHandler(
  options: InferenceStatusHandlerOptions = {},
): (event: InferenceStatusEvent) => Promise<Response> {
  return (event) => inferenceStatusResponse(event, options);
}
