/**
 * Binding a tier target onto AI client options, for code that builds its own
 * `getAI()` client instead of calling `SmrtClass#getAiClient(tier)` (#4756).
 *
 * `bindInferenceTarget()` is the one implementation of the endpoint/key pair
 * rules (#3372, #4750): `SmrtClass` uses it for every tier client, and
 * `resolveInferenceTarget()` uses it for raw `getAI()` sites (chat, agents,
 * jobs, CLI), so a per-user or per-tenant binding registered with
 * `setInferenceResolver()` applies there under the same rules.
 *
 * Browser-safe: imports nothing from `@happyvertical/ai`.
 */

import {
  type AIExplicitConfig,
  mergeAIConfigObjects,
  tryResolveAIProviderConfig,
  withAIAliases,
} from '@happyvertical/smrt-config';
import {
  attachAiUsageRecorder,
  type CreateAiUsageRecorderOptions,
  createAiUsageRecorder,
  resolveAiUsageTenantId,
} from './adapters/ai-usage-recorder.js';
import { maybeWithAiTranscripts } from './ai-transcripts.js';
import {
  InferenceBindingError,
  type InferenceLatency,
  type InferenceRequest,
  type InferenceResolution,
  type InferenceResolver,
  type InferenceTarget,
  type InferenceTargetSource,
  type InferenceTierRequest,
  inferenceTargetKind,
  inferenceUsageTags,
  isInferenceTargetSource,
  resolveInference,
} from './inference.js';
import { InferenceUnavailableError } from './inference-availability.js';
import {
  detectInferenceCapabilities,
  type InferenceCapabilities,
} from './inference-capabilities.js';
import {
  enforceInferenceGate,
  inferenceGateRequest,
  isHostedInferenceTarget,
} from './inference-gate.js';

const IDENTITY_FIELDS = ['provider', 'model', 'baseUrl', 'apiKey'] as const;

/** The trimmed provider/model/baseUrl/apiKey a target names (may be empty). */
export function inferenceTargetIdentity(
  target: InferenceTarget | undefined,
): Record<string, string> {
  const identity: Record<string, string> = {};
  for (const key of IDENTITY_FIELDS) {
    const value = target?.[key];
    if (typeof value === 'string' && value.trim() !== '') {
      identity[key] = value.trim();
    }
  }
  return identity;
}

function text(config: Record<string, unknown>, key: string): string {
  return typeof config[key] === 'string' ? (config[key] as string).trim() : '';
}

/**
 * Merge a `single` target's identity over `base` client options under the
 * pair rules, returning `getAI()` options with both provider/model aliases
 * set. Absent target fields inherit from `base`; a target on another provider
 * drops the base key, endpoint and model. Throws `InferenceBindingError`
 * (`INFERENCE_TARGET_UNBOUND`) for an unbound endpoint/key pair, and for
 * another provider's default endpoint while `HAVE_AI_*` is set, before any
 * SDK can fill the gap from its own environment. `base.onUsage` is dropped;
 * callers attach their own usage sink.
 *
 * `owner` names the caller in error messages (a class name, a route).
 */
export function bindInferenceTarget(
  base: Record<string, unknown> | undefined,
  target: InferenceTarget,
  owner: string,
): Record<string, unknown> {
  if (inferenceTargetKind(target) !== 'single') {
    throw new InferenceBindingError(
      `${owner}: a chain inference target cannot be bound to one client; run it through getAiClient(tier).`,
    );
  }
  const identity = inferenceTargetIdentity(target);
  const { onUsage: _onUsage, ...baseFields } = base ?? {};
  const merged = mergeAIConfigObjects(baseFields, identity);
  // Endpoint and credential are owned together (#3372) and travel as an
  // explicit pair. `getAI()` and provider SDKs refill an unset key or
  // endpoint from their own environment (`HAVE_AI_*`, `OPENAI_API_KEY`,
  // `OPENAI_BASE_URL`, ...), so deleting an inherited field is not enough:
  // an unbound pair fails closed here, before SDK construction.
  const provider = text(merged, 'provider');
  const sameProvider =
    provider.toLowerCase() === text(baseFields, 'provider').toLowerCase();
  const keepsBaseEndpoint =
    sameProvider && identity.baseUrl === text(baseFields, 'baseUrl');
  if (identity.baseUrl && !identity.apiKey && !keepsBaseEndpoint) {
    throw new InferenceBindingError(
      `${owner}: an inference target that names its own baseUrl must carry its own apiKey (use a placeholder such as 'smrt-local' for a keyless local server); a configured or environment key is never sent to another endpoint.`,
    );
  }
  if (identity.apiKey && !identity.baseUrl) {
    throw new InferenceBindingError(
      `${owner}: an inference target that brings its own apiKey must name its baseUrl; a target key is never sent to an inherited or environment endpoint.`,
    );
  }
  if (!sameProvider && !identity.baseUrl) {
    // Another provider's default endpoint with that provider's own key
    // variable. The SDK-wide `HAVE_AI_*` fallbacks belong to the configured
    // client and would redirect or replace that key.
    const env = typeof process !== 'undefined' ? process.env : undefined;
    for (const name of ['HAVE_AI_BASE_URL', 'HAVE_AI_API_KEY']) {
      if (env?.[name]?.trim()) {
        throw new InferenceBindingError(
          `${owner}: an inference target on another provider must name its baseUrl and apiKey while ${name} is set.`,
        );
      }
    }
    const resolved = tryResolveAIProviderConfig({
      explicit: merged as AIExplicitConfig,
      config: null,
      prefixes: [],
      autoDetect: false,
      requireProvider: false,
      providerKeyEnvFallback: true,
    });
    if (!merged.apiKey && resolved?.apiKey) merged.apiKey = resolved.apiKey;
  }
  return withAIAliases(merged);
}

/** Options for {@link resolveInferenceTarget}. */
export interface ResolveInferenceTargetOptions {
  /** Tier to resolve. Default `auto`. */
  tier?: InferenceTierRequest;
  latency?: InferenceLatency;
  /**
   * The site's own client options (its `options.ai`, a prompt's merged AI
   * config, the configured provider). Kept as-is when the tier is unbound;
   * otherwise the bound target is merged over it by
   * {@link bindInferenceTarget}.
   */
  base?: Record<string, unknown>;
  /** Tenant the call acts for; the resolver also reads the ambient one. */
  tenantId?: string | null;
  /**
   * `null`: the client serves more than one user (a long-lived agent, a
   * cached client), so a resolver must not apply any user's binding. A
   * per-user resolver reads the user from the ambient principal, never
   * from a string here.
   */
  userId?: string | null;
  className?: string;
  promptKey?: string;
  /** Resolver to use instead of the registered one (tests, instances). */
  resolver?: InferenceResolver;
  /**
   * Attach the public usage recorder (#3077) so calls land in
   * `_smrt_ai_usage` with the resolution's tags (`tierRequested`,
   * `tierResolved`, `source`). Omit when the caller wires usage itself.
   * Without a `db` the recorder still reaches `config({ usage: { handlers } })`.
   */
  usage?: {
    db?: CreateAiUsageRecorderOptions['db'];
    className?: string;
    /** Explicit attribution; omit to use the ambient tenant per call. */
    tenantId?: string | null;
    tags?: Record<string, string>;
  };
  /**
   * Whether an app-config binding (the `inference` block; `source: 'app'`, or
   * the built-in resolution) may replace `base`. Default `true`. Sites whose
   * `base` is their own explicit config (an agent's `ai`, a prompt's model)
   * pass `false`: only a stored user/tenant/hosted binding (a resolver
   * resolution whose source is not `app`) overrides them, so apps that
   * predate tier bindings keep their per-site config.
   */
  appBindings?: boolean;
  /** Names the caller in binding errors. Default `className` or `getAI`. */
  owner?: string;
  /**
   * Transcript directive for clients passed to the result's `instrument()`
   * (#4780): `false` never stores a transcript (chat, whose conversations
   * smrt-chat already stores), `true` always does; omitted, successes are
   * sampled. Transcripts go to `usage.db` and only while the app enables
   * `inference.transcripts`.
   */
  transcript?: boolean;
}

/** Result of {@link resolveInferenceTarget}. */
export interface ResolvedInferenceTarget {
  /**
   * `getAI()` options: `base` when the tier is unbound (or the target is a
   * chain, which a raw client cannot run), else the bound target over it.
   * May carry an API key: never log it.
   */
  options: Record<string, unknown> | undefined;
  resolution: InferenceResolution;
  /** True when the target's provider/model/endpoint/key shaped `options`. */
  bound: boolean;
  /** The binding origin; `app` when the site kept its own options. */
  source?: InferenceTargetSource;
  /**
   * Bound: `tierRequested`, `tierResolved` and the target's `source`.
   * Unbound: `{ source: 'app' }` only. Also set on the recorder.
   */
  usageTags: Record<string, string>;
  /**
   * What `options` can do (#4758) from the static layers only (preset, model
   * heuristic, assumed): no client exists yet. A site that builds the client
   * can refine it with `detectInferenceCapabilities(identity, await
   * client.getCapabilities())`.
   */
  capabilities: InferenceCapabilities;
  /**
   * Wrap the client the site builds from `options` for transcript capture
   * (#4780): `getAI(options)` then `instrument(client)`. Returns the client
   * unchanged while the app does not enable `inference.transcripts`, or when
   * the site passed `transcript: false`.
   */
  instrument<T>(client: T): T;
}

/**
 * Resolve a tier through the registered `InferenceResolver` (a per-user /
 * per-tenant binding, #4756; app `inference` config otherwise) and return
 * `getAI()` options for a raw client. Never calls a model.
 *
 * A chain target (`alias`, `candidates`) cannot run on one raw client: the
 * site keeps `base` and `bound` is false, as before tier bindings existed.
 * Sites that want chains build their client through `getAiClient(tier)`.
 *
 * Throws `InferenceUnavailableError` (`AI_UNAVAILABLE`, #4757) when the
 * resolution is unavailable (the principal's mode is `off`, ...), before any
 * options are built, so the raw site records nothing.
 */
export async function resolveInferenceTarget(
  options: ResolveInferenceTargetOptions = {},
): Promise<ResolvedInferenceTarget> {
  const tier = options.tier ?? 'auto';
  const request: InferenceRequest = {
    tier,
    ...(options.latency ? { latency: options.latency } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
    ...(options.className ? { className: options.className } : {}),
    ...(options.promptKey ? { promptKey: options.promptKey } : {}),
  };
  const resolution = await resolveInference(
    request,
    options.resolver ? { resolver: options.resolver } : {},
  );
  if (resolution.unavailable) {
    throw new InferenceUnavailableError({
      reason: resolution.unavailable,
      ...(resolution.mode ? { mode: resolution.mode } : {}),
      tier: resolution.tierResolved,
      ...(options.owner || options.className
        ? { owner: options.owner ?? options.className }
        : {}),
    });
  }
  const target = resolution.target ?? {};
  const single = inferenceTargetKind(target) === 'single';
  const identity = single ? inferenceTargetIdentity(target) : {};
  const stored = resolution.via === 'resolver' && target.source !== 'app';
  const bound =
    Object.keys(identity).length > 0 &&
    (options.appBindings !== false || stored);
  let clientOptions: Record<string, unknown> | undefined = options.base
    ? { ...options.base }
    : undefined;
  if (bound) {
    if (!options.base && !identity.provider) {
      throw new InferenceBindingError(
        `${options.owner ?? options.className ?? 'getAI'}: an inference target without a base client must name a provider.`,
      );
    }
    clientOptions = bindInferenceTarget(
      options.base,
      target,
      options.owner ?? options.className ?? 'getAI',
    );
    // The caller's own usage callback survives the binding; the recorder
    // below wraps it rather than replacing it.
    if (options.base?.onUsage !== undefined) {
      clientOptions.onUsage = options.base.onUsage;
    }
  }
  // A bound hosted target passes the hosted gate (#4760) before any options
  // are returned: a block records its zero-usage audit row through the same
  // recorder the call would have used (persisted when `usage.db` is given;
  // handlers only otherwise), then throws `reason: 'entitlement'`.
  if (bound && isHostedInferenceTarget(target)) {
    const owner = options.owner ?? options.className;
    await enforceInferenceGate(inferenceGateRequest(request, resolution), {
      resolution,
      ...(owner ? { owner } : {}),
      record: (row) =>
        createAiUsageRecorder({
          ...(options.usage?.db ? { db: options.usage.db } : {}),
          className: options.usage?.className ?? options.className,
          ...(options.usage?.tenantId !== undefined
            ? { tenantId: options.usage.tenantId }
            : options.tenantId !== undefined
              ? { tenantId: options.tenantId }
              : {}),
          tags: { ...(options.usage?.tags ?? {}) },
          aiConfig: clientOptions,
        })({
          ...row,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
    });
  }
  // An unbound site runs its own config: no tier answered it, so only the
  // origin is recorded.
  const source: InferenceTargetSource | undefined = bound
    ? isInferenceTargetSource(target.source)
      ? target.source
      : undefined
    : 'app';
  const usageTags = bound
    ? inferenceUsageTags(tier, resolution)
    : { source: 'app' };
  if (clientOptions && options.usage) {
    const usage = options.usage;
    clientOptions = attachAiUsageRecorder(
      clientOptions,
      createAiUsageRecorder({
        ...(usage.db ? { db: usage.db } : {}),
        className: usage.className ?? options.className,
        ...(usage.tenantId !== undefined ? { tenantId: usage.tenantId } : {}),
        tags: { ...usageTags, ...(usage.tags ?? {}) },
        aiConfig: clientOptions,
      }),
    );
  }
  const field = (key: string) =>
    typeof clientOptions?.[key] === 'string'
      ? (clientOptions[key] as string)
      : undefined;
  const transcriptTenant =
    options.usage?.tenantId !== undefined
      ? options.usage.tenantId
      : options.tenantId;
  const instrument = <T>(client: T): T =>
    options.transcript === false
      ? client
      : maybeWithAiTranscripts(client, () => ({
          db: options.usage?.db ?? null,
          className: options.usage?.className ?? options.className,
          tenantId: () => resolveAiUsageTenantId(transcriptTenant) ?? null,
          ...((field('provider') ?? field('type'))
            ? { provider: field('provider') ?? field('type') }
            : {}),
          ...((field('model') ?? field('defaultModel'))
            ? { model: field('model') ?? field('defaultModel') }
            : {}),
          secrets: () => {
            const key = field('apiKey');
            return key ? [key] : [];
          },
          ...(options.transcript === true ? { transcript: true } : {}),
        }));
  return {
    options: clientOptions,
    resolution,
    bound,
    ...(source ? { source } : {}),
    usageTags,
    instrument,
    capabilities: detectInferenceCapabilities({
      provider: field('provider') ?? field('type'),
      model: field('model') ?? field('defaultModel'),
      baseUrl: field('baseUrl'),
    }),
  };
}
