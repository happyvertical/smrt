/**
 * `@happyvertical/smrt-inference/resolver` — per-user and per-tenant
 * inference bindings over smrt-secrets (#4756). Node-only: it reads secrets
 * and the ambient principal, so it stays off the browser-safe root entry.
 *
 * Precedence for each tier, highest first:
 *   1. the current user's stored `inference.provider-config` (tier binding,
 *      then the user's default binding);
 *   2. the tenant's stored config (same order);
 *   3. `fallback` (another resolver), else the app's `inference` block;
 *   4. unbound: the configured client (`SMRT_AI_*` / the process `ai` block).
 * Every resolution carries `target.source` (`byo | local | hosted | app`),
 * which core records as the `source` usage tag.
 *
 * Inference mode (#4757): a stored config may carry `mode`. The user's mode,
 * else the tenant's, applies: `off` answers every tier (and untiered calls,
 * through `mode()`) as unavailable; `byo` / `local` / `hosted` bind only a
 * stored binding of that source (user, then tenant) and report
 * `unconfigured` when there is none, never falling through to app config.
 */
import {
  type InferenceMode,
  type InferenceModeRequest,
  type InferenceModeState,
  type InferenceRequest,
  type InferenceResolution,
  type InferenceResolver,
  type InferenceResolverContext,
  type InferenceTarget,
  type InferenceTier,
  isInferenceTargetSource,
  resolveAutoTier,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { SecretService } from '@happyvertical/smrt-secrets';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { getCurrentSessionPermissionContext } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
  type InferenceProviderConfig,
  inferenceProviderConfigSecretName,
  inferenceProviderTargets,
  parseInferenceProviderConfig,
  type RedactedInferenceProviderConfig,
  redactInferenceProviderConfig,
  redactInferenceTarget,
} from './provider-config.js';
import { createInferenceResolver } from './register.js';

export * from './provider-config.js';

/** `invalidate()` of every live resolver this process created. */
const liveResolvers = new Set<WeakRef<UserInferenceResolver['invalidate']>>();

/**
 * Drop cached configs in every user resolver this process created (all, one
 * tenant, or one user). Writers outside a resolver (hosted provisioning,
 * #4759) call this after storing a config; other processes see the change
 * when their cache entry expires (`ttlMs`, 30 s by default).
 */
export function invalidateUserInferenceResolvers(scope?: {
  tenantId?: string;
  userId?: string;
}): void {
  for (const ref of [...liveResolvers]) {
    const invalidate = ref.deref();
    if (invalidate) invalidate(scope);
    else liveResolvers.delete(ref);
  }
}

/** Default cache lifetime of decrypted configs, per `(tenantId, userId)`. */
export const USER_INFERENCE_CACHE_TTL_MS = 30_000;

/**
 * The subset of `SecretService` the resolver uses. Reads go through
 * `retrieve()` (audited, access-counted); writes through `store()`.
 */
export interface InferenceSecretStore {
  retrieve(name: string): Promise<{ value: string }>;
  store(
    name: string,
    value: string,
    options?: { category?: string; description?: string },
  ): Promise<unknown>;
  delete(name: string): Promise<boolean>;
}

/** Who a resolution acts for. */
export interface InferencePrincipal {
  tenantId: string;
  /** Absent for service principals and background jobs: no user layer. */
  userId?: string;
}

/** Options for {@link createUserInferenceResolver}. */
export interface UserInferenceResolverOptions {
  /** Database for a `SecretService` built on first use (when no `secrets`). */
  db?: DatabaseInterface;
  /** The secret store; defaults to `SecretService.create({ db })`. */
  secrets?: InferenceSecretStore | SecretService;
  /**
   * Resolver for tiers neither the user nor the tenant binds. Default: the
   * app's `inference` block through core's built-in resolution.
   */
  fallback?: InferenceResolver;
  /** Cache lifetime in ms (default {@link USER_INFERENCE_CACHE_TTL_MS}). */
  ttlMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /**
   * Principal seam for tests and hosts with their own identity. Default:
   * the ambient principal, read the way smrt-preferences reads it.
   */
  principal?: () => InferencePrincipal | undefined;
  /**
   * Let a request for another tenant than the principal's (an object of
   * tenant B used by a principal of tenant A) read tenant B's stored config.
   * Default `false`: such a request skips the stored layers and falls through
   * to the app config, because reading B's key for A's action is a
   * cross-tenant read. Principal-less contexts (jobs) always use the
   * request's tenant.
   */
  allowCrossTenant?: boolean;
}

/** The stored layers for one `(tenantId, userId)`. */
interface Layers {
  user?: InferenceProviderConfig;
  tenant?: InferenceProviderConfig;
}

/** The explicit mode that applies: the user's, else the tenant's. */
function explicitMode(
  layers: Layers,
): { mode: InferenceMode; layer: 'user' | 'tenant' } | undefined {
  if (layers.user?.mode) return { mode: layers.user.mode, layer: 'user' };
  if (layers.tenant?.mode) return { mode: layers.tenant.mode, layer: 'tenant' };
  return undefined;
}

/** One tier of {@link InferenceBindingMap}. */
export type InferenceBindingEntry = (
  | InferenceTarget
  | (Omit<InferenceTarget, 'apiKey'> & { hasApiKey: boolean })
) & { layer: 'user' | 'tenant' };

/** What {@link UserInferenceResolver.resolveBindings} returns. */
export interface InferenceBindingMap {
  tenantId?: string;
  userId?: string;
  /** Per tier: the stored binding that answers it (absent: app config). */
  tiers: Partial<Record<InferenceTier, InferenceBindingEntry>>;
  /** The stored configs themselves, redacted unless `redact: false`. */
  user?: InferenceProviderConfig | RedactedInferenceProviderConfig;
  tenant?: InferenceProviderConfig | RedactedInferenceProviderConfig;
  /** The explicit mode that applies (#4757) and the layer that set it. */
  mode?: { mode: InferenceMode; layer: 'user' | 'tenant' };
}

/** The scope a config is written to. */
export type InferenceConfigLevel = 'user' | 'tenant';

/** A resolver plus the read/write helpers the settings panel uses. */
export interface UserInferenceResolver extends InferenceResolver {
  /**
   * The tier → target map for the ambient principal (never a caller-chosen
   * tenant or user), without
   * keys unless `redact: false` (server-only; never send that to a client).
   */
  resolveBindings(options?: { redact?: boolean }): Promise<InferenceBindingMap>;
  /**
   * Validate and store a config for the current principal through
   * `SecretService.store()`, then invalidate the cache. `user` needs a
   * principal with a user id. Authorization (who may write the tenant
   * config) is the host's server action's job.
   */
  write(level: InferenceConfigLevel, config: unknown): Promise<void>;
  /** Delete the stored config at `level` for the current principal. */
  remove(level: InferenceConfigLevel): Promise<boolean>;
  /**
   * Set (or with `null` clear) the stored mode at `level` (#4757), keeping
   * the stored binding. Works without a key: a mode-only config is valid.
   * A config left with neither binding nor mode is deleted. Invalidates the
   * cache, so the next call sees it.
   */
  setMode(
    level: InferenceConfigLevel,
    mode: InferenceMode | null,
  ): Promise<void>;
  /** The explicit stored mode for untiered calls (core's `mode()` hook). */
  mode(request: InferenceModeRequest): Promise<InferenceModeState | undefined>;
  /**
   * Drop cached configs: all, one tenant's (every user), or one
   * `(tenantId, userId)`. Call after writing a config elsewhere.
   */
  invalidate(scope?: { tenantId?: string; userId?: string }): void;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

/**
 * The ambient principal: the tenancy context first, then the users session
 * permission context (smrt-preferences' order). Never guessed.
 */
export function getAmbientInferencePrincipal(): InferencePrincipal | undefined {
  const tenant = getCurrentTenant();
  const tenantId = text(tenant?.tenantId);
  if (tenantId) {
    const userId = text(tenant?.userId);
    return userId ? { tenantId, userId } : { tenantId };
  }
  const session = getCurrentSessionPermissionContext();
  const sessionTenant = text(session?.tenantId);
  if (!sessionTenant) return undefined;
  const userId = text(session?.userId);
  return userId
    ? { tenantId: sessionTenant, userId }
    : { tenantId: sessionTenant };
}

function isAbsentSecretError(error: unknown, name: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === `Secret '${name}' not found` ||
    error.message === 'Secret not found' ||
    error.message === 'Secret disabled' ||
    error.message === 'Secret expired'
  );
}

const cacheKey = (tenantId: string, userId: string | undefined) =>
  `${tenantId}\u0000${userId ?? ''}`;

/**
 * Create the per-user / per-tenant {@link InferenceResolver}. Register it
 * with {@link registerUserInferenceResolver} (keeps #4752's validation in
 * front) or `setInferenceResolver()`.
 */
export function createUserInferenceResolver(
  options: UserInferenceResolverOptions = {},
): UserInferenceResolver {
  const ttlMs = options.ttlMs ?? USER_INFERENCE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const principalOf = options.principal ?? getAmbientInferencePrincipal;
  const cache = new Map<string, { expires: number; value: Promise<Layers> }>();
  let secretsPromise: Promise<InferenceSecretStore> | undefined;

  const getSecrets = (): Promise<InferenceSecretStore> => {
    if (options.secrets) return Promise.resolve(options.secrets);
    if (!options.db) {
      return Promise.reject(
        new Error(
          'createUserInferenceResolver needs `secrets` or `db` to read stored inference configs.',
        ),
      );
    }
    secretsPromise ??= SecretService.create({ db: options.db }).catch(
      (error: unknown) => {
        secretsPromise = undefined;
        throw error;
      },
    );
    return secretsPromise;
  };

  /** Run `fn` in a tenancy context for `principal` (audit keeps the user). */
  const inTenant = <T>(
    principal: InferencePrincipal,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const current = getCurrentTenant();
    if (
      text(current?.tenantId) === principal.tenantId &&
      text(current?.userId) === principal.userId
    ) {
      return fn();
    }
    return withTenant(
      {
        tenantId: principal.tenantId,
        ...(principal.userId ? { userId: principal.userId } : {}),
      },
      fn,
    );
  };

  const readConfig = async (
    secrets: InferenceSecretStore,
    name: string,
  ): Promise<InferenceProviderConfig | undefined> => {
    let value: string;
    try {
      value = (await secrets.retrieve(name)).value;
    } catch (error) {
      if (isAbsentSecretError(error, name)) return undefined;
      throw error;
    }
    return parseInferenceProviderConfig(value);
  };

  const loadLayers = async (
    tenantId: string,
    userId: string | undefined,
  ): Promise<Layers> => {
    const secrets = await getSecrets();
    return inTenant({ tenantId, ...(userId ? { userId } : {}) }, async () => {
      const layers: Layers = {};
      if (userId) {
        layers.user = await readConfig(
          secrets,
          inferenceProviderConfigSecretName({ userId }),
        );
      }
      layers.tenant = await readConfig(
        secrets,
        inferenceProviderConfigSecretName({}),
      );
      return layers;
    });
  };

  const getLayers = (
    tenantId: string,
    userId: string | undefined,
  ): Promise<Layers> => {
    const key = cacheKey(tenantId, userId);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.value;
    const value = loadLayers(tenantId, userId);
    const entry = { expires: now() + ttlMs, value };
    cache.set(key, entry);
    value.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return value;
  };

  /**
   * Whose stored layers answer this request. With a principal: its tenant
   * (or the request's when they match), its user unless the request says
   * `userId: null` (a client shared beyond one user, e.g. a long-lived
   * agent). A request for another tenant reads nothing stored unless
   * `allowCrossTenant`. Without a principal: the request's tenant, no user.
   */
  const identityFor = (
    request: Pick<InferenceRequest, 'tenantId' | 'userId'>,
  ): { tenantId?: string; userId?: string } => {
    const principal = principalOf();
    const requested = text(request.tenantId);
    if (!principal) return requested ? { tenantId: requested } : {};
    if (requested && requested !== principal.tenantId) {
      return options.allowCrossTenant ? { tenantId: requested } : {};
    }
    const tenantId = principal.tenantId;
    const userId = request.userId === null ? undefined : text(principal.userId);
    return userId ? { tenantId, userId } : { tenantId };
  };

  const invalidate: UserInferenceResolver['invalidate'] = (scope) => {
    if (!scope?.tenantId) {
      cache.clear();
      return;
    }
    if (scope.userId) {
      cache.delete(cacheKey(scope.tenantId, scope.userId));
      return;
    }
    const prefix = `${scope.tenantId}\u0000`;
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  };

  const writeScope = (level: InferenceConfigLevel): InferencePrincipal => {
    const principal = principalOf();
    if (!principal?.tenantId) {
      throw new Error(
        'Writing an inference provider config needs an authenticated tenant context.',
      );
    }
    if (level === 'user' && !principal.userId) {
      throw new Error(
        'Writing a user inference provider config needs a principal with a user id.',
      );
    }
    return principal;
  };

  liveResolvers.add(new WeakRef(invalidate));

  return {
    async resolve(
      request: InferenceRequest,
      context: InferenceResolverContext,
    ): Promise<InferenceResolution | undefined> {
      const tierResolved =
        request.tier === 'auto'
          ? resolveAutoTier(context.config)
          : request.tier;
      const { tenantId, userId } = identityFor(request);
      if (tenantId) {
        const layers = await getLayers(tenantId, userId);
        const chosen = explicitMode(layers);
        if (chosen?.mode === 'off') {
          return {
            tierResolved,
            target: {},
            via: 'resolver',
            mode: 'off',
            unavailable: 'off',
          };
        }
        const candidates = [
          inferenceProviderTargets(layers.user)[tierResolved],
          inferenceProviderTargets(layers.tenant)[tierResolved],
        ];
        if (chosen) {
          // An explicit mode binds only its own kind of stored binding.
          const target = candidates.find(
            (entry) => entry?.source === chosen.mode,
          );
          if (target) {
            return { tierResolved, target, via: 'resolver', mode: chosen.mode };
          }
          return {
            tierResolved,
            target: {},
            via: 'resolver',
            mode: 'off',
            unavailable: 'unconfigured',
          };
        }
        const target = candidates.find(Boolean);
        if (target) {
          const source = target.source;
          return {
            tierResolved,
            target,
            via: 'resolver',
            ...(source === 'byo' || source === 'local' || source === 'hosted'
              ? { mode: source }
              : {}),
          };
        }
      }
      const fallen =
        (await options.fallback?.resolve(request, context)) ??
        context.resolveFromConfig(request);
      const source = fallen.target?.source;
      return {
        ...fallen,
        target: {
          ...fallen.target,
          source: isInferenceTargetSource(source) ? source : 'app',
        },
      };
    },

    async mode(request) {
      const { tenantId, userId } = identityFor(request);
      if (!tenantId) return undefined;
      const chosen = explicitMode(await getLayers(tenantId, userId));
      if (!chosen) return undefined;
      return chosen.mode === 'off'
        ? { mode: 'off', unavailable: 'off' }
        : { mode: chosen.mode };
    },

    // Fusions are app-scope only (#4753): stored user and tenant configs
    // never define one, so the lookup is the fallback's (override rows,
    // #4800) or none (core then reads `inference.fusions`).
    async lookupFusion(key, request, context) {
      return options.fallback?.lookupFusion?.(key, request, context);
    },

    async resolveBindings(bindingOptions = {}) {
      const redact = bindingOptions.redact !== false;
      // Identity is ambient only: no caller-chosen tenant or user.
      const { tenantId, userId } = identityFor({});
      if (!tenantId) return { tiers: {} };
      const layers = await getLayers(tenantId, userId);
      const map: InferenceBindingMap = {
        tenantId,
        ...(userId ? { userId } : {}),
        tiers: {},
      };
      for (const layer of ['tenant', 'user'] as const) {
        const config = layers[layer];
        if (!config) continue;
        map[layer] = redact ? redactInferenceProviderConfig(config) : config;
        for (const [tier, target] of Object.entries(
          inferenceProviderTargets(config),
        )) {
          map.tiers[tier as InferenceTier] = {
            ...(redact ? redactInferenceTarget(target) : target),
            layer,
          };
        }
      }
      const chosen = explicitMode(layers);
      if (chosen) map.mode = chosen;
      return map;
    },

    async write(level, config) {
      const principal = writeScope(level);
      const parsed = parseInferenceProviderConfig(config);
      const secrets = await getSecrets();
      const name = inferenceProviderConfigSecretName(
        level === 'user' ? { userId: principal.userId } : {},
      );
      await inTenant(principal, () =>
        secrets.store(name, JSON.stringify(parsed), {
          category: INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
          description: `Inference provider config (${level})`,
        }),
      );
      invalidate(
        level === 'user'
          ? { tenantId: principal.tenantId, userId: principal.userId }
          : { tenantId: principal.tenantId },
      );
    },

    async remove(level) {
      const principal = writeScope(level);
      const secrets = await getSecrets();
      const name = inferenceProviderConfigSecretName(
        level === 'user' ? { userId: principal.userId } : {},
      );
      const removed = await inTenant(principal, () => secrets.delete(name));
      invalidate(
        level === 'user'
          ? { tenantId: principal.tenantId, userId: principal.userId }
          : { tenantId: principal.tenantId },
      );
      return removed;
    },

    async setMode(level, mode) {
      const principal = writeScope(level);
      const secrets = await getSecrets();
      const name = inferenceProviderConfigSecretName(
        level === 'user' ? { userId: principal.userId } : {},
      );
      // Read fresh (not the cache) so a concurrent binding write is kept.
      const current = await inTenant(principal, () =>
        readConfig(secrets, name),
      );
      const next: InferenceProviderConfig = { ...(current ?? {}) };
      if (mode === null) delete next.mode;
      else next.mode = parseInferenceProviderConfig({ mode }).mode;
      const empty = Object.keys(next).every(
        (key) =>
          key === 'version' || key === 'source' || key === 'gatewayKeyAlias',
      );
      await inTenant(principal, async () => {
        if (empty) {
          if (current) await secrets.delete(name);
          return;
        }
        await secrets.store(
          name,
          JSON.stringify(parseInferenceProviderConfig(next)),
          {
            category: INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
            description: `Inference provider config (${level})`,
          },
        );
      });
      invalidate(
        level === 'user'
          ? { tenantId: principal.tenantId, userId: principal.userId }
          : { tenantId: principal.tenantId },
      );
    },

    invalidate,
  };
}

/**
 * Register `resolver` behind smrt-inference's validating resolver (#4752):
 * chain config is validated first, then the per-user resolver binds, then
 * its `fallback` / the app config. Safe in either import order: a later
 * `registerInference()` keeps this registration.
 */
export function registerUserInferenceResolver(
  resolver: UserInferenceResolver,
): UserInferenceResolver {
  setInferenceResolver(createInferenceResolver(resolver));
  return resolver;
}
