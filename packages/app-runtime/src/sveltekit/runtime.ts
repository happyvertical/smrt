/**
 * SvelteKit server composition for the validated runtime profiles.
 *
 * Request foundation, in order:
 *
 * 0. Wait for the fail-closed runtime startup gate (`init`).
 * 1. Resolve a URL tenant candidate into `locals.selectedTenant*`. This is
 *    selection only and never enters AsyncLocalStorage tenant context.
 * 2. Load the signed session. Its tenant is accepted only for a verified
 *    active direct or legitimately inherited membership
 *    ({@link isSessionTenantAuthorized}, the deployed runtime's rule);
 *    otherwise the request is unauthenticated. An accepted session enters the
 *    tenant context and permission set for downstream code, inside the
 *    request RLS transaction when the profile selects `database-rls`.
 * 3. Publish the authorized context on `locals.tenantContext` only when it
 *    matches the verified session tenant.
 *
 * This ordering prevents a spoofed header or hostname from becoming query
 * authority. Membership-gated tenant switching belongs in an explicit action
 * using `switchSessionTenant()` from `@happyvertical/smrt-users/sveltekit`.
 */

import {
  loadConfig,
  type ResolvedApplicationRuntime,
  resolveApplicationRuntime,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  enableTenancy,
  getCurrentTenant,
  isTenancyEnabled,
  type MinimalTenantContext,
} from '@happyvertical/smrt-tenancy';
import {
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
  PermissionResolver,
  SessionService,
  type SessionServiceOptions,
  withPrincipalPermissionContext,
  withSessionPermissionContext,
} from '@happyvertical/smrt-users';
import type {
  SessionHandlerOptions,
  SessionLocals,
} from '@happyvertical/smrt-users/sveltekit';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import type { Handle, ServerInit } from '@sveltejs/kit';
import {
  resolveApplicationId,
  runtimeConfigurationFingerprint,
} from '../application-identity.js';
import {
  type DeployedApplicationRuntime,
  type DeployedApplicationRuntimeProfile,
  initializeDeployedApplicationRuntime,
  isSessionTenantAuthorized,
  type PublicAuthenticationProvider,
} from '../deployed-runtime.js';
import {
  initializeLocalApplicationRuntime,
  type LocalApplicationRuntime,
  type LocalOwnerBootstrapInvitation,
  resolveLocalRuntimePaths,
  validateApplicationId,
} from '../index.js';
import {
  projectRuntimeDiagnostics,
  type RuntimeDiagnostics,
  type RuntimeDiagnosticsProjectionInput,
} from '../runtime-diagnostics.js';
import { resolveApplicationStateRoot } from '../state-root.js';
import type { WriterLease } from '../writer-lease.js';
import {
  createSubdomainTenantSelector,
  normalizeTenantSelection,
  type TenantSelector,
} from './tenancy.js';

/** `App.Locals` fields populated by the SMRT runtime `handle`. */
export interface SmrtRuntimeLocals extends SessionLocals {
  /**
   * URL-selected tenant candidate. Never use this as authorization; the
   * session-authorized tenant remains `tenantId` from {@link SessionLocals}.
   */
  selectedTenantId: string | null;
  selectedTenantSlug: string | null;
  /** Full context for the authorized session tenant, when present. */
  tenantContext?: MinimalTenantContext;
}

/** Provider component whose readiness a deployed web process must prove. */
export type ProviderReadinessComponent =
  | 'authentication'
  | 'assets'
  | 'secrets';

/**
 * Build a provider-owned readiness probe. The probe must check the real
 * backing service and must never return or log credentials.
 */
export type ProviderReadinessFactory = (
  component: ProviderReadinessComponent,
  context: { readonly profile: string; readonly provider: string },
) => () => Promise<void>;

/** Context handed to an application-owned writer lease. */
export interface WriterLeaseContext {
  readonly appId: string;
  readonly dataDirectory: string | undefined;
  readonly sourceRoot: string;
}

/**
 * Held for the life of the local web process; released on failed startup.
 * The root entry's `acquireWriterLease()` returns one.
 */
export type { WriterLease } from '../writer-lease.js';

/** Inputs to the public diagnostics projection that only the app can supply. */
export interface ApplicationRuntimeDiagnosticsOptions {
  readonly toolNames: readonly string[];
  readonly observedAt: Date;
  /** Application-owned schema verification seam; runtime liveness is not proof. */
  readonly schemaStatus?: 'not-ready' | 'ready' | 'unknown';
  /** Application-owned migration tracker seam; database liveness is not proof. */
  readonly migrationStatus?: 'current' | 'failed' | 'pending' | 'unknown';
  /** Bounded worker seam supplied by the deployment's lease/heartbeat adapter. */
  readonly workerHeartbeatAt?: Date | string | null;
  /** Stable code/timestamp pairs only; raw errors never cross this seam. */
  readonly recentErrors?: readonly {
    readonly code?: unknown;
    readonly at?: unknown;
  }[];
}

/** Liveness body served by the mounted health route. */
export interface RuntimeHealthBody {
  readonly schemaVersion: 1;
  readonly status: 'ready';
  readonly profile: ResolvedApplicationRuntime['profile'];
  /** Local profile only: canonical application ID. */
  readonly application?: string;
  /** Local profile only: managed process instance (`SMRT_PROCESS_INSTANCE`). */
  readonly instance?: string | null;
  /** Local profile only: {@link runtimeConfigurationFingerprint}. */
  readonly configuration?: string;
}

/** Session-handler options the application may tune. */
export type SmrtRuntimeSessionOptions = Omit<
  SessionHandlerOptions,
  'enterTenantContext'
>;

/** App-specific options for {@link createSmrtSvelteKitRuntime}. */
export interface SmrtSvelteKitRuntimeOptions {
  /**
   * Explicit application ID. Defaults to `SMRT_APP_ID` (strictly validated)
   * or the encoded `package.json` name under `sourceRoot`.
   */
  readonly appId?: string;
  /** Application source checkout. Defaults to `process.cwd()`. */
  readonly sourceRoot?: string;
  /** Local data root. Defaults to `SMRT_DATA_DIR`, then the OS data directory. */
  readonly dataDirectory?: string;
  /** Environment to read. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Resolved runtime profile. Defaults to `smrt.config` `runtime` when
   * present, otherwise the `local` profile.
   */
  readonly runtime?:
    | ResolvedApplicationRuntime
    | (() => ResolvedApplicationRuntime | Promise<ResolvedApplicationRuntime>);
  /**
   * Explicit, idempotent application migration hook, run during `init`.
   * The runtime never synthesizes application tables itself.
   */
  readonly prepareDatabase?: (db: DatabaseInterface) => Promise<void>;
  /**
   * Local HTTP bind host. Defaults to `HOST`, or `127.0.0.1` when
   * `NODE_ENV=development`. Local production startup without one fails.
   */
  readonly bindHost?: string;
  /** Opt in to persisted local background jobs. Default `SMRT_BACKGROUND_JOBS === 'true'`. */
  readonly backgroundJobs?: boolean;
  /** Opt in to application-defined paid capabilities. Default false. */
  readonly paidCapabilities?: boolean;
  /** Owner-bootstrap token lifetime (1..900 seconds). */
  readonly bootstrapTtlSeconds?: number;
  /** Session lifetime for the owner-bootstrap session cookie. Default 7 days. */
  readonly sessionTtlSeconds?: number;
  /**
   * Local single-writer lease held for the web process (for example the CLI's
   * state-root writer lease). Released when local startup fails.
   */
  readonly acquireWriterLease?: (context: WriterLeaseContext) => WriterLease;
  /**
   * Deployed provider readiness probes. Required by `self-hosted` and `cloud`;
   * deployed startup fails closed without them.
   */
  readonly providerReadiness?: ProviderReadinessFactory;
  /** Replace the default subdomain tenant selector. Selection only. */
  readonly selectTenant?: TenantSelector;
  /** Base domain for the default selector. Defaults to `TENANT_BASE_DOMAIN`. */
  readonly tenantBaseDomain?: string;
  /** Session handler tuning. `enterTenantContext` is always `true`. */
  readonly session?: SmrtRuntimeSessionOptions;
  /** Per-class overrides layered over the runtime database config. */
  readonly classOverrides?: Readonly<Record<string, Partial<SmrtClassOptions>>>;
  /** Call `enableTenancy()` if it is not already enabled. Default true. */
  readonly enableTenancy?: boolean;
  /**
   * Receives an owner-bootstrap invitation that this process's startup newly
   * issued (the plaintext is returned exactly once; only its HMAC is stored).
   * Use it to show a loopback `/setup?token=` URL. Errors are ignored so a
   * failing presenter never blocks startup. Default: not presented.
   */
  readonly onBootstrapInvitation?: (
    invitation: LocalOwnerBootstrapInvitation,
    context: { readonly bindHost: string },
  ) => void;
  /** Testable clock for the local runtime. */
  readonly now?: () => Date;
}

/** Cookie attributes for a session established outside the session handler. */
export interface SmrtRuntimeSessionCookie {
  readonly name: string;
  readonly path: string;
  readonly domain?: string;
  readonly sameSite: 'strict' | 'lax' | 'none';
  /** `undefined` means "secure when the request is HTTPS". */
  readonly secure?: boolean;
  readonly maxAgeSeconds: number;
}

/** The composed runtime; `handle` and `init` are bound and destructurable. */
/** A principal a route authenticated itself, for {@link SmrtSvelteKitRuntime.runAsPrincipal}. */
export interface SmrtRuntimeBoundPrincipal {
  readonly id: string;
  readonly tenantId?: string | null;
  /** Granted scopes that cap the live permission set (e.g. token scopes). */
  readonly scopes?: readonly string[];
}

export interface SmrtSvelteKitRuntime {
  /** `hooks.server.ts` `handle`. */
  readonly handle: Handle;
  /** `hooks.server.ts` `init`: the fail-closed startup gate. */
  readonly init: ServerInit;
  /** Session cookie attributes shared with owner setup. */
  readonly sessionCookie: SmrtRuntimeSessionCookie;
  /** Resolve the runtime profile (memoized; retried after failure). */
  resolvedRuntime(): Promise<ResolvedApplicationRuntime>;
  /** Await profile-specific startup (same promise as `init`). */
  ready(): Promise<void>;
  /** Canonical application ID. */
  applicationId(): string;
  /**
   * Private state root shared with the `smrt app` operator commands (writer
   * lease, operation lock, onboarding hand-off files). Resolves the path only;
   * it does not create it.
   */
  applicationStateRoot(): string;
  /** Secret-free configuration fingerprint. Requires a resolved runtime. */
  configurationFingerprint(): string;
  /**
   * Database for SMRT collections. Requires a resolved runtime. Inside a
   * request running in the RLS transaction (`database-rls` isolation, or
   * `session.postgresRls`) this is the transaction-bound request database;
   * otherwise the base configuration. Call it per request and never retain
   * the result (or collections built from it) beyond that request.
   */
  databaseConfig(): SmrtClassOptions['db'];
  /**
   * Collection options for a class: {@link databaseConfig} plus
   * `classOverrides`. A class whose override sets `db` keeps that database.
   * Same per-request rule as {@link databaseConfig}.
   */
  classOptions(className: string): SmrtClassOptions;
  /**
   * Run `fn` as a principal the route verified itself (for example a bearer
   * token mapped by an MCP route), replacing the cookie session's permission
   * context for that call. The principal's permissions are resolved live from
   * its membership in `tenantId` and, when `scopes` is given, capped to it;
   * under the RLS transaction rule of {@link databaseConfig} a fresh
   * transaction publishes that user, tenant and permission set, and
   * `databaseConfig()`/`classOptions()` return it inside `fn`. Rejects (before
   * `fn` runs) without a user id, a tenant, or an authorized membership.
   *
   * `fn` receives the principal with `scopes` replaced by that effective
   * permission set (live permissions, capped by the given scopes). Callers
   * that authorize in code (rather than through database policy, as under
   * `application` isolation) must authorize with these effective scopes so a
   * revoked permission takes effect even while a token still carries it.
   */
  runAsPrincipal<
    T,
    P extends SmrtRuntimeBoundPrincipal = SmrtRuntimeBoundPrincipal,
  >(
    principal: P,
    fn: (bound: P & { scopes: string[] }) => Promise<T>,
  ): Promise<T>;
  /** The local runtime. Rejects outside the `local` profile. */
  localRuntime(): Promise<LocalApplicationRuntime>;
  /** The deployed runtime. Rejects in the `local` profile. */
  deployedRuntime(): Promise<DeployedApplicationRuntime>;
  /** Liveness body for the health route (awaits startup). */
  health(): Promise<RuntimeHealthBody>;
  /**
   * Read private runtime state and project it onto the public allowlist.
   * Call only after the route has authenticated and authorized its caller.
   */
  readDiagnostics(
    options: ApplicationRuntimeDiagnosticsOptions,
  ): Promise<RuntimeDiagnostics>;
}

/** @internal Test and composition seams; not part of the public entry. */
export interface SmrtSvelteKitRuntimeSeams {
  readonly initializeLocal?: typeof initializeLocalApplicationRuntime;
  readonly initializeDeployed?: typeof initializeDeployedApplicationRuntime;
  readonly loadRuntime?: () => Promise<ResolvedApplicationRuntime>;
}

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Compose runtime startup, tenant selection, the signed session, and
 * authorized-tenant locals into a SvelteKit `{ handle, init }` pair.
 *
 * @example
 * ```ts
 * // src/hooks.server.ts
 * import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
 *
 * export const runtime = createSmrtSvelteKitRuntime();
 * export const { handle, init } = runtime;
 * ```
 */
export function createSmrtSvelteKitRuntime(
  options: SmrtSvelteKitRuntimeOptions = {},
): SmrtSvelteKitRuntime {
  return composeSmrtSvelteKitRuntime(options, {});
}

/** @internal */
export function composeSmrtSvelteKitRuntime(
  options: SmrtSvelteKitRuntimeOptions,
  seams: SmrtSvelteKitRuntimeSeams,
): SmrtSvelteKitRuntime {
  const env = options.env ?? process.env;
  const sourceRoot = options.sourceRoot ?? process.cwd();
  const dataDirectory = options.dataDirectory ?? env.SMRT_DATA_DIR;
  const initializeLocal =
    seams.initializeLocal ?? initializeLocalApplicationRuntime;
  const initializeDeployed =
    seams.initializeDeployed ?? initializeDeployedApplicationRuntime;

  if (options.enableTenancy !== false && !isTenancyEnabled()) {
    enableTenancy();
  }

  let appId: string | undefined;
  const applicationId = (): string => {
    appId ??= options.appId
      ? validateApplicationId(options.appId)
      : resolveApplicationId({ sourceRoot, explicitId: env.SMRT_APP_ID });
    return appId;
  };

  let resolved: ResolvedApplicationRuntime | undefined;
  let resolvedPromise: Promise<ResolvedApplicationRuntime> | undefined;
  const resolvedRuntime = (): Promise<ResolvedApplicationRuntime> => {
    resolvedPromise ??= (async () => {
      const value =
        typeof options.runtime === 'function'
          ? await options.runtime()
          : (options.runtime ??
            (await (seams.loadRuntime ?? loadConfiguredRuntime)()));
      resolved = value;
      return value;
    })().catch((error: unknown) => {
      resolvedPromise = undefined;
      throw error;
    });
    return resolvedPromise;
  };

  const requireResolved = (): ResolvedApplicationRuntime => {
    if (!resolved) {
      throw new Error(
        'The SMRT application runtime is not resolved yet; await init() first.',
      );
    }
    return resolved;
  };

  /** Base (connection-level) database config; never request-scoped. */
  const baseDatabaseConfig = (): SmrtClassOptions['db'] => {
    const runtime = requireResolved();
    if (runtime.profile === 'local') {
      const paths = resolveLocalRuntimePaths({
        appId: applicationId(),
        dataDirectory,
        sourceRoot,
        env,
      });
      return { type: 'sqlite', url: paths.database };
    }
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(`${runtime.profile} requires DATABASE_URL.`);
    }
    return { type: 'postgres', url: databaseUrl };
  };

  /** Base collection options; used for anything that outlives a request. */
  const baseClassOptions = (className: string): SmrtClassOptions => {
    const defaults: SmrtClassOptions = { db: baseDatabaseConfig() };
    const override = options.classOverrides?.[className];
    return override ? { ...defaults, ...override } : defaults;
  };

  /**
   * Inside a request running in the RLS transaction, the transaction-bound
   * request database (it carries the `smrt.*` session variables); otherwise
   * undefined. Never cache the returned handle beyond the request.
   */
  const rlsRequestDatabase = (): SmrtClassOptions['db'] | undefined => {
    const context = getCurrentSessionPermissionContext();
    if (context?.postgresRls !== true) return undefined;
    return (getRequestScopedDatabase() ?? undefined) as
      | SmrtClassOptions['db']
      | undefined;
  };

  const databaseConfig = (): SmrtClassOptions['db'] =>
    rlsRequestDatabase() ?? baseDatabaseConfig();

  const classOptions = (className: string): SmrtClassOptions => {
    const base = baseClassOptions(className);
    if (options.classOverrides?.[className]?.db !== undefined) return base;
    const requestDb = rlsRequestDatabase();
    return requestDb ? { ...base, db: requestDb } : base;
  };

  let localPromise: Promise<LocalApplicationRuntime> | undefined;
  let localLease: WriterLease | undefined;
  const localRuntime = async (): Promise<LocalApplicationRuntime> => {
    const runtime = await resolvedRuntime();
    if (runtime.profile !== 'local') {
      throw new Error(
        'Owner bootstrap is available only in the local profile.',
      );
    }
    if (localPromise) return localPromise;
    const bindHost =
      options.bindHost ||
      env.HOST ||
      (env.NODE_ENV === 'development' ? '127.0.0.1' : null);
    if (!bindHost) {
      throw new Error(
        'Local production startup requires an explicit loopback HOST; use pnpm app:start.',
      );
    }
    const id = applicationId();
    localLease ??= options.acquireWriterLease?.({
      appId: id,
      dataDirectory,
      sourceRoot,
    });
    localPromise = initializeLocal({
      appId: id,
      dataDirectory,
      sourceRoot,
      env,
      bindHost,
      providers: {
        database: runtime.providers.database,
        authentication: runtime.providers.authentication,
        tenancy: runtime.providers.tenancy,
        assets: runtime.providers.assets,
        secrets: runtime.providers.secrets,
        jobs: runtime.providers.jobs,
        network: runtime.providers.network,
      },
      backgroundJobs:
        options.backgroundJobs ?? env.SMRT_BACKGROUND_JOBS === 'true',
      paidCapabilities: options.paidCapabilities,
      bootstrapTtlSeconds: options.bootstrapTtlSeconds,
      sessionTtlSeconds: options.sessionTtlSeconds,
      prepareDatabase: options.prepareDatabase,
      now: options.now,
    })
      .then(({ runtime: initialized, bootstrap }) => {
        if (bootstrap) {
          try {
            options.onBootstrapInvitation?.(bootstrap, { bindHost });
          } catch {
            // Presentation is best effort; the invitation stays claimable.
          }
        }
        return initialized;
      })
      .catch((error: unknown) => {
        localLease?.release();
        localLease = undefined;
        localPromise = undefined;
        throw error;
      });
    return localPromise;
  };

  let deployedPromise: Promise<DeployedApplicationRuntime> | undefined;
  const deployedRuntime = async (): Promise<DeployedApplicationRuntime> => {
    const runtime = await resolvedRuntime();
    if (runtime.profile === 'local') {
      throw new Error('deployed_runtime_unavailable');
    }
    const profile = runtime.profile as DeployedApplicationRuntimeProfile;
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(`${profile} requires DATABASE_URL.`);
    }
    const authenticationProvider = runtime.providers.authentication.provider;
    if (authenticationProvider === 'owner-bootstrap') {
      throw new Error('Deployed profiles require public authentication.');
    }
    const readiness = options.providerReadiness;
    if (!readiness) {
      throw new Error(
        `${profile} requires providerReadiness probes for authentication, assets, and secrets.`,
      );
    }
    deployedPromise ??= initializeDeployed({
      profile,
      providers: {
        database: runtime.providers.database,
        authentication: runtime.providers.authentication,
        tenancy: runtime.providers.tenancy,
        assets: runtime.providers.assets,
        secrets: runtime.providers.secrets,
        jobs: runtime.providers.jobs,
        network: runtime.providers.network,
      },
      database: {
        engine: 'postgres',
        connect: () => getDatabase({ type: 'postgres', url: databaseUrl }),
        close: async (db) => {
          await db.close?.();
        },
      },
      authentication: {
        provider: authenticationProvider as PublicAuthenticationProvider,
        readiness: readiness('authentication', {
          profile,
          provider: authenticationProvider,
        }),
      },
      assets: {
        provider: runtime.providers.assets.provider,
        readiness: readiness('assets', {
          profile,
          provider: runtime.providers.assets.provider,
        }),
      },
      secrets: {
        provider: runtime.providers.secrets.provider,
        readiness: readiness('secrets', {
          profile,
          provider: runtime.providers.secrets.provider,
        }),
      },
      prepareDatabase: options.prepareDatabase,
    });
    return deployedPromise;
  };

  const ready = async (): Promise<void> => {
    const runtime = await resolvedRuntime();
    if (runtime.profile === 'local') {
      await localRuntime();
      return;
    }
    await deployedRuntime();
  };

  const configurationFingerprint = (): string =>
    runtimeConfigurationFingerprint(requireResolved(), env);

  const health = async (): Promise<RuntimeHealthBody> => {
    await ready();
    const runtime = requireResolved();
    const publicHealth = {
      schemaVersion: 1 as const,
      status: 'ready' as const,
      profile: runtime.profile,
    };
    return runtime.profile === 'local'
      ? {
          ...publicHealth,
          application: applicationId(),
          instance: env.SMRT_PROCESS_INSTANCE || null,
          configuration: configurationFingerprint(),
        }
      : publicHealth;
  };

  const readDiagnostics = async (
    diagnosticsOptions: ApplicationRuntimeDiagnosticsOptions,
  ): Promise<RuntimeDiagnostics> => {
    await ready();
    const runtime = requireResolved();
    const schema = {
      status: diagnosticsOptions.schemaStatus ?? 'unknown',
      migrations: diagnosticsOptions.migrationStatus ?? 'unknown',
    } as const;

    if (runtime.profile === 'local') {
      const local = await localRuntime();
      const diagnostics = await local.diagnostics();
      return projectRuntimeDiagnostics({
        profile: 'local',
        health: 'healthy',
        schema,
        capabilities: {
          'asset-storage': 'available',
          authentication: 'available',
          'background-jobs': diagnostics.jobs.backgroundEnabled
            ? 'available'
            : 'disabled',
          database: 'available',
          'paid-capabilities': diagnostics.paidCapabilitiesEnabled
            ? 'available'
            : 'disabled',
          'secret-storage': 'available',
        },
        toolNames: diagnosticsOptions.toolNames,
        worker: {
          topology: diagnostics.jobs.topology,
          required: diagnostics.jobs.backgroundEnabled,
          heartbeatAt: diagnosticsOptions.workerHeartbeatAt,
        },
        recentErrors: diagnosticsOptions.recentErrors,
        observedAt: diagnosticsOptions.observedAt,
      });
    }

    const deployed = await deployedPromise;
    if (!deployed) throw new Error('deployed_runtime_unavailable');
    const readiness = await deployed.readiness();
    const componentStatus = (
      component: keyof typeof readiness.components,
    ): 'available' | 'unavailable' =>
      readiness.components[component].status === 'ready'
        ? 'available'
        : 'unavailable';
    const input: RuntimeDiagnosticsProjectionInput = {
      profile: runtime.profile,
      health:
        deployed.health().status === 'healthy'
          ? readiness.status === 'ready'
            ? 'healthy'
            : 'degraded'
          : 'stopped',
      schema,
      capabilities: {
        'asset-storage': componentStatus('assets'),
        authentication: componentStatus('authentication'),
        'background-jobs': 'available',
        database: componentStatus('database'),
        'paid-capabilities': 'unknown',
        'secret-storage': componentStatus('secrets'),
      },
      toolNames: diagnosticsOptions.toolNames,
      worker: {
        topology: deployed.resolvedRuntime.providers.jobs.topology,
        required: true,
        heartbeatAt: diagnosticsOptions.workerHeartbeatAt,
      },
      recentErrors: diagnosticsOptions.recentErrors,
      observedAt: diagnosticsOptions.observedAt,
    };
    return projectRuntimeDiagnostics(input);
  };

  const selectTenant: TenantSelector =
    options.selectTenant ??
    createSubdomainTenantSelector({
      baseDomain: options.tenantBaseDomain ?? env.TENANT_BASE_DOMAIN,
      classOptions: () => baseClassOptions('Tenant'),
    });

  const readinessHandle: Handle = async ({ event, resolve }) => {
    await ready();
    return resolve(event);
  };

  const tenantSelectionHandle: Handle = async ({ event, resolve }) => {
    const locals = runtimeLocals(event.locals);
    const selection = normalizeTenantSelection(
      await selectTenant({ url: event.url, request: event.request }),
    );
    locals.selectedTenantId = selection.tenantId;
    locals.selectedTenantSlug = selection.tenantSlug;
    return resolve(event);
  };

  const sessionCookieName = options.session?.cookieName ?? 'sid';
  const sessionSkipPaths = options.session?.skipPaths ?? [];
  const sessionServiceOptions = (): SessionServiceOptions => ({
    ...baseClassOptions('Session'),
    ...options.session,
    defaultTTL: options.session?.ttl ?? DEFAULT_SESSION_TTL_SECONDS,
    autoExtend: options.session?.autoExtend ?? false,
  });
  /** `database-rls` isolation always runs the request RLS transaction. */
  const postgresRls = (): boolean | undefined =>
    requireResolved().providers.tenancy.isolation === 'database-rls'
      ? true
      : options.session?.postgresRls;
  let permissionResolverPromise: Promise<PermissionResolver> | undefined;
  const permissionResolver = (): Promise<PermissionResolver> => {
    permissionResolverPromise ??= PermissionResolver.create(
      baseClassOptions('Permission'),
    ).catch((error: unknown) => {
      permissionResolverPromise = undefined;
      throw error;
    });
    return permissionResolverPromise;
  };

  const runAsPrincipal = async <
    T,
    P extends SmrtRuntimeBoundPrincipal = SmrtRuntimeBoundPrincipal,
  >(
    principal: P,
    fn: (bound: P & { scopes: string[] }) => Promise<T>,
  ): Promise<T> => {
    const userId = principal?.id;
    const tenantId = principal?.tenantId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('A bound principal requires a user id.');
    }
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new Error('A bound principal requires a tenant.');
    }
    // Resolution reads the base connection, before any RLS transaction opens.
    const resolved = await (await permissionResolver()).resolvePermissions(
      userId,
      tenantId,
    );
    if (!resolved.membershipId) {
      throw new Error('The bound principal has no membership in its tenant.');
    }
    const cap = principal.scopes ? new Set(principal.scopes) : undefined;
    const permissions = [...resolved.permissions].filter(
      (permission) => !cap || cap.has(permission),
    );
    return withPrincipalPermissionContext(
      {
        ...baseClassOptions('Session'),
        userId,
        tenantId,
        permissions,
        enterTenantContext: true,
        postgresRls: postgresRls(),
      },
      () => fn({ ...principal, scopes: [...permissions] }),
    );
  };

  let sessionServicePromise: Promise<SessionService> | undefined;
  const sessionService = (): Promise<SessionService> => {
    sessionServicePromise ??= (async () => {
      const service = new TenantAuthorizingSessionService(
        sessionServiceOptions(),
        requireResolved().providers.tenancy.context === 'required',
      );
      await service.initialize();
      return service;
    })().catch((error: unknown) => {
      sessionServicePromise = undefined;
      throw error;
    });
    return sessionServicePromise;
  };

  /**
   * Step 2. Downstream code runs at most once: a downstream throw (or a
   * failure after `resolve` was entered, such as an RLS commit) propagates
   * unchanged and `resolve` is never re-entered. A session-layer failure
   * before `resolve` fails closed with 500 and no authenticated locals, for
   * both RLS and non-RLS isolation.
   */
  const sessionStep: Handle = async ({ event, resolve }) => {
    const locals = runtimeLocals(event.locals);
    clearSessionLocals(locals);
    const rls = postgresRls();
    // A skipped path skips session loading only. Under RLS it still runs in
    // the request transaction, as an anonymous principal.
    const skipped = sessionSkipPaths.some((path) =>
      event.url.pathname.startsWith(path),
    );
    if (skipped && !rls) return resolve(event);
    const sessionId = skipped
      ? undefined
      : event.cookies.get(sessionCookieName);
    if (!sessionId && !rls) return resolve(event);

    let resolveEntered = false;
    let downstream: { error: unknown } | undefined;
    try {
      const service = await sessionService();
      return await withSessionPermissionContext(
        {
          ...sessionServiceOptions(),
          enterTenantContext: true,
          postgresRls: rls,
          sessionId: sessionId ?? null,
          sessionService: service,
        },
        async (context) => {
          if (context.session) {
            locals.user = context.user;
            locals.membership = context.membership ?? null;
            locals.permissions = context.permissions;
            locals.tenantId = context.tenantId;
            locals.sessionId = context.sessionId;
            if (context.tenantId) {
              verifiedSessionTenants.set(locals, context.tenantId);
            }
          }
          resolveEntered = true;
          try {
            return await resolve(event);
          } catch (error) {
            downstream = { error };
            throw error;
          }
        },
      );
    } catch (error) {
      if (downstream) throw downstream.error;
      if (resolveEntered) throw error;
      clearSessionLocals(locals);
      return new Response('Internal Server Error', { status: 500 });
    }
  };

  const sessionCookie: SmrtRuntimeSessionCookie = Object.freeze({
    name: options.session?.cookieName ?? 'sid',
    path: options.session?.cookiePath ?? '/',
    ...(options.session?.cookieDomain
      ? { domain: options.session.cookieDomain }
      : {}),
    sameSite: options.session?.cookieSameSite ?? 'lax',
    ...(options.session?.cookieSecure !== undefined
      ? { secure: options.session.cookieSecure }
      : {}),
    maxAgeSeconds: options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
  });

  const init: ServerInit = () => ready();

  return Object.freeze({
    handle: composeHandles(
      readinessHandle,
      tenantSelectionHandle,
      sessionStep,
      authorizedTenantLocalsHandle,
    ),
    init,
    sessionCookie,
    resolvedRuntime,
    ready,
    applicationId,
    applicationStateRoot: () =>
      resolveApplicationStateRoot({
        appId: applicationId(),
        dataDirectory,
        sourceRoot,
      }),
    configurationFingerprint,
    databaseConfig,
    classOptions,
    runAsPrincipal,
    localRuntime,
    deployedRuntime,
    health,
    readDiagnostics,
  });
}

/** Locals whose session tenant passed {@link isSessionTenantAuthorized}. */
const verifiedSessionTenants = new WeakMap<object, string>();

/**
 * Session service whose loaded context carries a tenant only when that
 * tenant passed {@link isSessionTenantAuthorized}. A session bound to an
 * unauthorized tenant (or missing a required tenant) loads as no session, so
 * no identity, permissions, or tenant context is established for it.
 */
class TenantAuthorizingSessionService extends SessionService {
  private readonly tenantRequired: boolean;

  constructor(options: SessionServiceOptions, tenantRequired: boolean) {
    super(options);
    this.tenantRequired = tenantRequired;
  }

  override async loadSessionContext(
    sessionId: string,
  ): ReturnType<SessionService['loadSessionContext']> {
    const context = await super.loadSessionContext(sessionId);
    if (!context) return null;
    if (typeof context.tenantId === 'string' && context.tenantId.length > 0) {
      return isSessionTenantAuthorized(context) ? context : null;
    }
    return this.tenantRequired ? null : context;
  }
}

function clearSessionLocals(locals: SmrtRuntimeLocals): void {
  locals.user = null;
  locals.membership = null;
  locals.permissions = [];
  locals.tenantId = null;
  locals.sessionId = null;
  locals.tenantContext = undefined;
  verifiedSessionTenants.delete(locals);
}

/**
 * Step 3: publish the authorized tenant context only when this runtime's
 * session step verified the session tenant and it matches the active
 * AsyncLocalStorage context. Locals populated by any other session layer are
 * never published.
 */
export const authorizedTenantLocalsHandle: Handle = async ({
  event,
  resolve,
}) => {
  const locals = runtimeLocals(event.locals);
  const activeContext = getCurrentTenant();
  if (
    locals.user &&
    locals.tenantId &&
    verifiedSessionTenants.get(locals) === locals.tenantId &&
    activeContext?.tenantId === locals.tenantId
  ) {
    locals.tenantContext = activeContext;
  }
  return resolve(event);
};

/**
 * Run handles in order. Unlike `sequence()` from `@sveltejs/kit/hooks`, this
 * needs no SvelteKit request store, so the composed handle is usable (and
 * testable) outside the Kit server runtime. The runtime's own handles never
 * pass resolve options; any options a handle passes are forwarded unchanged.
 */
export function composeHandles(...handles: readonly Handle[]): Handle {
  return ({ event, resolve }) => {
    const run: (
      index: number,
      current: Parameters<Handle>[0]['event'],
      resolveOptions?: Parameters<Parameters<Handle>[0]['resolve']>[1],
    ) => ReturnType<Handle> = (index, current, resolveOptions) => {
      const next = handles[index];
      if (!next) return resolve(current, resolveOptions);
      return next({
        event: current,
        resolve: (nextEvent, nextOptions) =>
          run(index + 1, nextEvent, nextOptions ?? resolveOptions),
      });
    };
    return run(0, event);
  };
}

function runtimeLocals(locals: unknown): SmrtRuntimeLocals {
  return locals as SmrtRuntimeLocals;
}

async function loadConfiguredRuntime(): Promise<ResolvedApplicationRuntime> {
  const loaded = await loadConfig();
  return loaded.runtime
    ? resolveConfiguredApplicationRuntime()
    : resolveApplicationRuntime({ profile: 'local' });
}
