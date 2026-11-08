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
 */
import {
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
}

/** The stored layers for one `(tenantId, userId)`. */
interface Layers {
  user?: InferenceProviderConfig;
  tenant?: InferenceProviderConfig;
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

  /** The tenant this request acts for, and the user only when it matches. */
  const identityFor = (
    request: Pick<InferenceRequest, 'tenantId'>,
  ): { tenantId?: string; userId?: string } => {
    const principal = principalOf();
    const tenantId = text(request.tenantId) ?? principal?.tenantId;
    if (!tenantId) return {};
    // A user's config belongs to the tenant it was stored in; acting for
    // another tenant's object skips the user layer rather than guess.
    const userId =
      principal && principal.tenantId === tenantId
        ? text(principal.userId)
        : undefined;
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
        const target =
          inferenceProviderTargets(layers.user)[tierResolved] ??
          inferenceProviderTargets(layers.tenant)[tierResolved];
        if (target) return { tierResolved, target, via: 'resolver' };
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
