/**
 * Application-side composition for public self-hosted and managed-cloud
 * runtimes. Provider credentials and vendor clients remain in their owning
 * adapters; this module validates the selected seams, owns the PostgreSQL
 * connection lifecycle, and exposes orchestration-safe diagnostics.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  type ApplicationRuntimeProfile,
  type AssetStorageProvider,
  type AuthenticationProvider,
  type ResolvedApplicationRuntime,
  type RuntimeProviderOverrides,
  resolveApplicationRuntime,
  type SecretProvider,
} from '@happyvertical/smrt-config';
import {
  ScheduleRunner,
  type ScheduleRunnerConfig,
  TaskRunner,
  type TaskRunnerConfig,
} from '@happyvertical/smrt-jobs';
import { SessionService } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';

export type DeployedApplicationRuntimeProfile = Exclude<
  ApplicationRuntimeProfile,
  'local'
>;

export type PublicAuthenticationProvider = Exclude<
  AuthenticationProvider,
  'owner-bootstrap'
>;

export type DeployedRuntimeComponent =
  | 'database'
  | 'authentication'
  | 'assets'
  | 'secrets';

/**
 * A provider-owned readiness boundary.
 *
 * The callback should prove that required configuration is present and that
 * the provider is usable. It must not return credentials or secret values.
 */
export interface DeployedProviderBinding<Provider extends string> {
  readonly provider: Provider;
  readonly readiness: () => Promise<void>;
}

/** PostgreSQL connection factory. URLs and credentials stay in this adapter. */
export interface DeployedDatabaseBinding {
  readonly engine: 'postgres';
  readonly connect: () => Promise<DatabaseInterface>;
  readonly readiness?: (db: DatabaseInterface) => Promise<void>;
  /**
   * Provider-owned cleanup boundary, required before a connection is opened.
   * Keeping cleanup on the binding also covers malformed connection handles.
   */
  readonly close: (db: DatabaseInterface) => Promise<void>;
}

export interface DeployedApplicationRuntimeOptions {
  readonly profile: DeployedApplicationRuntimeProfile;
  /** Validated selector overrides; never put credentials in this object. */
  readonly providers?: RuntimeProviderOverrides;
  readonly database: DeployedDatabaseBinding;
  readonly authentication: DeployedProviderBinding<PublicAuthenticationProvider>;
  readonly assets: DeployedProviderBinding<AssetStorageProvider>;
  readonly secrets: DeployedProviderBinding<SecretProvider>;
  /** Explicit, idempotent application migration hook. */
  readonly prepareDatabase?: (db: DatabaseInterface) => Promise<void>;
}

export interface DeployedProviderDiagnostic {
  readonly provider: string;
  readonly configured: true;
}

export interface DeployedRuntimeDiagnostics {
  readonly schemaVersion: 1;
  readonly runtime: ResolvedApplicationRuntime;
  readonly providers: {
    readonly database: DeployedProviderDiagnostic;
    readonly authentication: DeployedProviderDiagnostic;
    readonly assets: DeployedProviderDiagnostic;
    readonly secrets: DeployedProviderDiagnostic;
  };
  readonly tenancy: {
    readonly mode: 'single-tenant' | 'multi-tenant';
    readonly context: 'defaulted' | 'required';
    readonly isolation: 'application' | 'database-rls';
    readonly rootTenantFallback: 'disabled';
  };
  readonly workers: {
    readonly topology: 'external' | 'scalable';
    readonly taskProcess: 'separate';
    readonly scheduleProcess: 'separate';
    readonly replicas: 'operator-managed' | 'horizontal';
  };
  readonly secretValuesIncluded: false;
}

export interface DeployedRuntimeHealth {
  readonly schemaVersion: 1;
  readonly profile: DeployedApplicationRuntimeProfile;
  readonly status: 'healthy' | 'stopped';
}

export interface DeployedComponentReadiness {
  readonly status: 'ready' | 'not-ready';
}

export interface DeployedRuntimeReadiness {
  readonly schemaVersion: 1;
  readonly profile: DeployedApplicationRuntimeProfile;
  readonly status: 'ready' | 'not-ready';
  readonly components: Readonly<
    Record<DeployedRuntimeComponent, DeployedComponentReadiness>
  >;
  readonly secretValuesIncluded: false;
}

export type DeployedRuntimeErrorCode =
  | 'invalid_configuration'
  | 'provider_mismatch'
  | 'provider_unavailable'
  | 'tenant_context_required'
  | 'tenant_context_unauthorized'
  | 'runtime_stopped';

/** Stable failure that never includes a provider's underlying error text. */
export class DeployedRuntimeError extends Error {
  constructor(
    readonly code: DeployedRuntimeErrorCode,
    message: string,
    readonly component?: DeployedRuntimeComponent,
  ) {
    super(message);
    this.name = 'DeployedRuntimeError';
  }
}

/** Startup failure that retains the only safe retry path for database cleanup. */
export class DeployedRuntimeCleanupError extends DeployedRuntimeError {
  private cleaned = false;
  private cleanupAttempt?: Promise<void>;

  constructor(private readonly cleanup: () => Promise<void>) {
    super(
      'provider_unavailable',
      "The database connection could not be closed after startup failed; retry cleanup and inspect the provider's private logs.",
      'database',
    );
    this.name = 'DeployedRuntimeCleanupError';
  }

  async retryCleanup(): Promise<void> {
    if (this.cleaned) return;
    if (!this.cleanupAttempt) {
      this.cleanupAttempt = Promise.resolve()
        .then(() => this.cleanup())
        .then(() => {
          this.cleaned = true;
        })
        .catch(() => {
          throw this;
        })
        .finally(() => {
          this.cleanupAttempt = undefined;
        });
    }
    return this.cleanupAttempt;
  }
}

export interface DeployedApplicationRuntime {
  readonly db: DatabaseInterface;
  readonly resolvedRuntime: ResolvedApplicationRuntime;
  restoreSession(
    sessionId: string,
  ): ReturnType<SessionService['loadSessionContext']>;
  createTaskWorker(config?: TaskRunnerConfig): Promise<TaskRunner>;
  createScheduleWorker(config?: ScheduleRunnerConfig): Promise<ScheduleRunner>;
  diagnostics(): DeployedRuntimeDiagnostics;
  health(): DeployedRuntimeHealth;
  readiness(): Promise<DeployedRuntimeReadiness>;
  close(): Promise<void>;
}

interface ValidatedBindings {
  database: DeployedDatabaseBinding;
  authentication: DeployedProviderBinding<PublicAuthenticationProvider>;
  assets: DeployedProviderBinding<AssetStorageProvider>;
  secrets: DeployedProviderBinding<SecretProvider>;
}

/**
 * Initialize a self-hosted or cloud application composition.
 *
 * Configuration and provider identity are validated before a connection is
 * opened. Provider readiness and database migrations complete before the
 * runtime is returned. A failed initialization closes the acquired connection.
 */
export async function initializeDeployedApplicationRuntime(
  options: DeployedApplicationRuntimeOptions,
): Promise<DeployedApplicationRuntime> {
  const resolvedRuntime = resolveDeployedRuntime(options);
  const bindings = validateBindings(options, resolvedRuntime);
  const prepareDatabase = snapshotPrepareDatabase(options);

  await checkProvider('authentication', () =>
    bindings.authentication.readiness(),
  );
  await checkProvider('assets', () => bindings.assets.readiness());
  await checkProvider('secrets', () => bindings.secrets.readiness());

  let db: DatabaseInterface | undefined;
  try {
    db = await bindings.database.connect();
  } catch {
    throw unavailable('database');
  }
  let validDatabase = false;
  try {
    validDatabase = isDatabaseInterface(db);
  } catch {
    // Treat throwing accessors on an untrusted handle as malformed.
  }
  if (!validDatabase) {
    await cleanupAfterStartupFailure(
      bindings.database,
      db,
      new DeployedRuntimeError(
        'invalid_configuration',
        'The database adapter did not return a valid database connection.',
        'database',
      ),
    );
  }
  try {
    await checkDatabase(bindings.database, db);
  } catch (error) {
    await cleanupAfterStartupFailure(bindings.database, db, error);
  }
  try {
    await prepareDatabase?.(db);
  } catch {
    await cleanupAfterStartupFailure(
      bindings.database,
      db,
      new DeployedRuntimeError(
        'provider_unavailable',
        'The PostgreSQL migration step failed; inspect the application migration logs.',
        'database',
      ),
    );
  }

  return new InitializedDeployedApplicationRuntime(
    db,
    resolvedRuntime,
    bindings,
  );
}

function resolveDeployedRuntime(
  options: DeployedApplicationRuntimeOptions,
): ResolvedApplicationRuntime {
  let plainOptions = false;
  try {
    plainOptions = isPlainRecord(options);
  } catch {
    // Proxies and throwing prototype traps are invalid options.
  }
  if (!plainOptions) {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      'Deployed runtime options must be an object.',
    );
  }
  let profile: unknown;
  let providers: RuntimeProviderOverrides | undefined;
  try {
    profile = options.profile;
    providers = options.providers;
  } catch {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      'Deployed runtime options could not be read safely.',
    );
  }
  if (profile !== 'self-hosted' && profile !== 'cloud') {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      'Deployed runtime initialization requires the self-hosted or cloud profile.',
    );
  }
  try {
    return resolveApplicationRuntime({ profile, providers });
  } catch {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      'Deployed runtime provider options could not be read safely.',
    );
  }
}

function validateBindings(
  options: DeployedApplicationRuntimeOptions,
  runtime: ResolvedApplicationRuntime,
): ValidatedBindings {
  const databaseSource = readBindingOption(options, 'database', 'database');
  const database = requireObjectBinding<DeployedDatabaseBinding>(
    databaseSource,
    'database',
  );
  let engine: unknown;
  let connect: unknown;
  let readiness: unknown;
  let close: unknown;
  try {
    engine = database.engine;
    connect = database.connect;
    readiness = database.readiness;
    close = database.close;
  } catch {
    throw invalidBinding('database');
  }
  requireFunction(connect, 'database', 'connect');
  requireOptionalFunction(readiness, 'database', 'readiness');
  requireFunction(close, 'database', 'close');
  if (engine !== runtime.providers.database.engine) {
    throw mismatch('database', runtime.providers.database.engine);
  }
  const databaseSnapshot: DeployedDatabaseBinding = Object.freeze({
    engine: engine as 'postgres',
    connect: bindCallback(
      connect as DeployedDatabaseBinding['connect'],
      database,
      'database',
    ),
    readiness:
      typeof readiness === 'function'
        ? bindCallback(
            readiness as NonNullable<DeployedDatabaseBinding['readiness']>,
            database,
            'database',
          )
        : undefined,
    close: bindCallback(
      close as DeployedDatabaseBinding['close'],
      database,
      'database',
    ),
  });

  const authentication = requireProviderBinding(
    readBindingOption(options, 'authentication', 'authentication'),
    'authentication',
    runtime.providers.authentication.provider,
  ) as DeployedProviderBinding<PublicAuthenticationProvider>;
  const assets = requireProviderBinding(
    readBindingOption(options, 'assets', 'assets'),
    'assets',
    runtime.providers.assets.provider,
  ) as DeployedProviderBinding<AssetStorageProvider>;
  const secrets = requireProviderBinding(
    readBindingOption(options, 'secrets', 'secrets'),
    'secrets',
    runtime.providers.secrets.provider,
  ) as DeployedProviderBinding<SecretProvider>;

  return {
    database: databaseSnapshot,
    authentication,
    assets,
    secrets,
  };
}

function snapshotPrepareDatabase(
  options: DeployedApplicationRuntimeOptions,
): DeployedApplicationRuntimeOptions['prepareDatabase'] {
  let prepareDatabase: unknown;
  try {
    prepareDatabase = options.prepareDatabase;
  } catch {
    throw invalidBinding('database');
  }
  requireOptionalFunction(prepareDatabase, 'database', 'prepareDatabase');
  return typeof prepareDatabase === 'function'
    ? bindCallback(
        prepareDatabase as NonNullable<
          DeployedApplicationRuntimeOptions['prepareDatabase']
        >,
        options,
        'database',
      )
    : undefined;
}

function readBindingOption(
  options: DeployedApplicationRuntimeOptions,
  field: 'database' | 'authentication' | 'assets' | 'secrets',
  component: DeployedRuntimeComponent,
): unknown {
  try {
    return options[field];
  } catch {
    throw invalidBinding(component);
  }
}

function requireProviderBinding(
  value: unknown,
  component: Exclude<DeployedRuntimeComponent, 'database'>,
  expectedProvider: string,
): DeployedProviderBinding<string> {
  const binding = requireObjectBinding<DeployedProviderBinding<string>>(
    value,
    component,
  );
  let provider: unknown;
  let readiness: unknown;
  try {
    provider = binding.provider;
    readiness = binding.readiness;
  } catch {
    throw invalidBinding(component);
  }
  if (provider !== expectedProvider) {
    throw mismatch(component, expectedProvider);
  }
  requireFunction(readiness, component, 'readiness');
  return Object.freeze({
    provider: provider as string,
    readiness: bindCallback(
      readiness as DeployedProviderBinding<string>['readiness'],
      binding,
      component,
    ),
  });
}

function requireObjectBinding<T>(
  value: unknown,
  component: DeployedRuntimeComponent,
): T {
  let valid = false;
  try {
    valid =
      typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    // Revoked proxies and throwing shape traps are invalid bindings.
  }
  if (!valid) {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      `The ${component} provider binding is required.`,
      component,
    );
  }
  return value as T;
}

function invalidBinding(
  component: DeployedRuntimeComponent,
): DeployedRuntimeError {
  return new DeployedRuntimeError(
    'invalid_configuration',
    `The ${component} provider binding could not be read safely.`,
    component,
  );
}

function bindCallback<T>(
  callback: T,
  receiver: unknown,
  component: DeployedRuntimeComponent,
): T {
  try {
    return Reflect.apply(
      Function.prototype.bind,
      callback as (...args: never[]) => unknown,
      [receiver],
    ) as T;
  } catch {
    throw invalidBinding(component);
  }
}

function requireFunction(
  value: unknown,
  component: DeployedRuntimeComponent,
  field: string,
): void {
  if (typeof value !== 'function') {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      `The ${component} provider requires a ${field} callback.`,
      component,
    );
  }
}

function requireOptionalFunction(
  value: unknown,
  component: DeployedRuntimeComponent,
  field: string,
): void {
  if (value !== undefined) requireFunction(value, component, field);
}

function mismatch(
  component: DeployedRuntimeComponent,
  expectedProvider: string,
): DeployedRuntimeError {
  return new DeployedRuntimeError(
    'provider_mismatch',
    `The ${component} binding does not match the selected ${expectedProvider} provider.`,
    component,
  );
}

function unavailable(
  component: DeployedRuntimeComponent,
): DeployedRuntimeError {
  return new DeployedRuntimeError(
    'provider_unavailable',
    `The ${component} provider is not ready; inspect that provider's private logs.`,
    component,
  );
}

async function checkProvider(
  component: Exclude<DeployedRuntimeComponent, 'database'>,
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check();
  } catch {
    throw unavailable(component);
  }
}

async function checkDatabase(
  binding: DeployedDatabaseBinding,
  db: DatabaseInterface,
): Promise<void> {
  try {
    await binding.readiness?.(db);
    const result = await db.query(
      "SELECT current_setting('server_version_num') AS smrt_postgres_version",
    );
    if (!isValidPostgresProbe(result)) throw new Error('invalid probe');
  } catch {
    throw unavailable('database');
  }
}

class InitializedDeployedApplicationRuntime
  implements DeployedApplicationRuntime
{
  private state: 'running' | 'closing' | 'close-failed' | 'stopped' = 'running';
  private closeAttempt?: Promise<void>;
  private readonly pendingReadinessChecks = new Set<Promise<unknown>>();
  private readonly pendingSessionRestorations = new Set<Promise<unknown>>();
  private readonly pendingWorkerInitializations = new Set<Promise<unknown>>();
  private readonly pendingWorkerOperations = new Set<Promise<unknown>>();
  private readonly lifecycleOperationContext = new AsyncLocalStorage<symbol>();
  private readonly activeLifecycleOperations = new Set<symbol>();
  private readonly workerCleanups = new Set<() => Promise<void>>();
  private readonly sessionService: SessionService;
  private sessionServiceReady?: Promise<void>;
  private readonly snapshot: DeployedRuntimeDiagnostics;

  constructor(
    readonly db: DatabaseInterface,
    readonly resolvedRuntime: ResolvedApplicationRuntime,
    private readonly bindings: ValidatedBindings,
  ) {
    this.snapshot = createDiagnostics(resolvedRuntime);
    this.sessionService = new SessionService({ db });
  }

  async restoreSession(sessionId: string) {
    this.assertRunning();
    const operation = this.beginLifecycleOperation(() =>
      this.restoreSessionWhileRunning(sessionId),
    );
    this.pendingSessionRestorations.add(operation);
    try {
      return await operation;
    } finally {
      this.pendingSessionRestorations.delete(operation);
    }
  }

  private async restoreSessionWhileRunning(sessionId: string) {
    let context: Awaited<ReturnType<SessionService['loadSessionContext']>>;
    try {
      await this.initializeSessionService();
      context = await this.sessionService.loadSessionContext(sessionId);
    } catch {
      throw unavailable('authentication');
    }
    this.assertRunning();
    if (
      context &&
      this.resolvedRuntime.providers.tenancy.context === 'required'
    ) {
      let tenantId: unknown;
      try {
        tenantId = context.tenantId;
      } catch {
        throw unavailable('authentication');
      }
      if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
        throw new DeployedRuntimeError(
          'tenant_context_required',
          'The authenticated session does not include the required tenant context.',
          'authentication',
        );
      }
      let tenantAuthorized = false;
      try {
        const membership = context.membership;
        const authorization = context.tenantAuthorization;
        const membershipId = authorization?.membershipId;
        const validMembershipId =
          typeof membershipId === 'string' && membershipId.trim().length > 0;
        if (membership?.isActive() === true) {
          tenantAuthorized =
            validMembershipId &&
            membership.id === membershipId &&
            authorization?.inheritedFromTenantId === null;
        } else if (membership === null) {
          tenantAuthorized =
            validMembershipId &&
            typeof authorization?.inheritedFromTenantId === 'string' &&
            authorization.inheritedFromTenantId.trim().length > 0;
        }
      } catch {
        throw unavailable('authentication');
      }
      if (!tenantAuthorized) {
        throw new DeployedRuntimeError(
          'tenant_context_unauthorized',
          'The authenticated session is not authorized for its tenant context.',
          'authentication',
        );
      }
    }
    return context;
  }

  async createTaskWorker(config: TaskRunnerConfig = {}): Promise<TaskRunner> {
    this.assertRunning();
    const operation = this.beginLifecycleOperation(() =>
      this.initializeTaskWorker(config),
    );
    this.pendingWorkerInitializations.add(operation);
    try {
      const runner = await operation;
      return this.retainWorker(runner);
    } finally {
      this.pendingWorkerInitializations.delete(operation);
    }
  }

  async createScheduleWorker(
    config: ScheduleRunnerConfig = {},
  ): Promise<ScheduleRunner> {
    this.assertRunning();
    const operation = this.beginLifecycleOperation(() =>
      this.initializeScheduleWorker(config),
    );
    this.pendingWorkerInitializations.add(operation);
    try {
      const runner = await operation;
      return this.retainWorker(runner);
    } finally {
      this.pendingWorkerInitializations.delete(operation);
    }
  }

  diagnostics(): DeployedRuntimeDiagnostics {
    return this.snapshot;
  }

  health(): DeployedRuntimeHealth {
    return Object.freeze({
      schemaVersion: 1 as const,
      profile: this.resolvedRuntime
        .profile as DeployedApplicationRuntimeProfile,
      status:
        this.state === 'running' ? ('healthy' as const) : ('stopped' as const),
    });
  }

  async readiness(): Promise<DeployedRuntimeReadiness> {
    if (this.state !== 'running')
      return createStoppedReadiness(this.resolvedRuntime.profile);

    const operation = this.beginLifecycleOperation(() =>
      this.checkReadinessWhileRunning(),
    );
    this.pendingReadinessChecks.add(operation);
    try {
      return await operation;
    } finally {
      this.pendingReadinessChecks.delete(operation);
    }
  }

  private async checkReadinessWhileRunning(): Promise<DeployedRuntimeReadiness> {
    const results = await Promise.all([
      probe(() => checkDatabase(this.bindings.database, this.db)),
      probe(() => this.bindings.authentication.readiness()),
      probe(() => this.bindings.assets.readiness()),
      probe(() => this.bindings.secrets.readiness()),
    ]);
    if (this.state !== 'running') {
      return createStoppedReadiness(this.resolvedRuntime.profile);
    }
    const [database, authentication, assets, secrets] = results;
    return freezeReadiness(
      this.resolvedRuntime.profile,
      { database, authentication, assets, secrets },
      results.every((result) => result.status === 'ready'),
    );
  }

  async close(): Promise<void> {
    const operationToken = this.lifecycleOperationContext.getStore();
    const requestedFromLifecycleOperation =
      operationToken !== undefined &&
      this.activeLifecycleOperations.has(operationToken);
    if (this.state === 'stopped') return;
    if (this.closeAttempt) {
      if (requestedFromLifecycleOperation) return;
      return this.closeAttempt;
    }

    this.state = 'closing';
    const pendingOperations = [
      ...this.pendingReadinessChecks,
      ...this.pendingSessionRestorations,
      ...this.pendingWorkerInitializations,
      ...this.pendingWorkerOperations,
    ];
    const shutdownToken = Symbol('deployed-runtime-shutdown');
    this.activeLifecycleOperations.add(shutdownToken);
    const attempt = Promise.resolve()
      .then(() =>
        this.lifecycleOperationContext.run(shutdownToken, async () => {
          await Promise.allSettled(pendingOperations);
          await this.cleanupWorkers();
          await this.closeConnection();
        }),
      )
      .finally(() => {
        this.activeLifecycleOperations.delete(shutdownToken);
      });
    this.closeAttempt = attempt.finally(() => {
      this.closeAttempt = undefined;
    });
    if (requestedFromLifecycleOperation) {
      // The lifecycle callback cannot await the shutdown pipeline without
      // deadlocking on itself. It receives an acknowledgement instead, but the
      // internally owned attempt still needs a rejection observer until an
      // outside caller can retry the failed cleanup.
      void this.closeAttempt.catch(() => undefined);
      return;
    }
    return this.closeAttempt;
  }

  private async initializeTaskWorker(
    config: TaskRunnerConfig,
  ): Promise<TaskRunner> {
    let runner: TaskRunner | undefined;
    try {
      runner = new TaskRunner(config);
      await runner.initialize(this.db);
    } catch {
      if (runner) await this.stopOrRetainUnreturnedWorker(runner);
      throw unavailable('database');
    }
    if (this.state !== 'running') {
      await this.stopOrRetainUnreturnedWorker(runner);
      this.assertRunning();
    }
    return runner;
  }

  private async initializeScheduleWorker(
    config: ScheduleRunnerConfig,
  ): Promise<ScheduleRunner> {
    let runner: ScheduleRunner | undefined;
    try {
      runner = new ScheduleRunner(config);
      await runner.initialize(this.db);
    } catch {
      if (runner) await this.stopOrRetainUnreturnedWorker(runner);
      throw unavailable('database');
    }
    if (this.state !== 'running') {
      await this.stopOrRetainUnreturnedWorker(runner);
      this.assertRunning();
    }
    return runner;
  }

  private async stopOrRetainUnreturnedWorker(runner: {
    stop(): Promise<void>;
  }): Promise<void> {
    const cleanup = () => runner.stop();
    try {
      await cleanup();
    } catch {
      this.workerCleanups.add(cleanup);
    }
  }

  private retainWorker<Runner extends TaskRunner | ScheduleRunner>(
    runner: Runner,
  ): Runner {
    const start = runner.start.bind(runner);
    const stop = runner.stop.bind(runner);
    let operationTail = Promise.resolve();
    const queueOperation = (callback: () => Promise<void>): Promise<void> => {
      const previous = operationTail;
      const operation = this.beginLifecycleOperation(async () => {
        await previous;
        await callback();
      });
      operationTail = operation.catch(() => undefined);
      this.pendingWorkerOperations.add(operation);
      void operation.then(
        () => {
          this.pendingWorkerOperations.delete(operation);
        },
        () => {
          this.pendingWorkerOperations.delete(operation);
        },
      );
      return operation;
    };
    const ownedStart = async (): Promise<void> => {
      this.assertRunning();
      return queueOperation(async () => {
        this.assertRunning();
        try {
          await start();
          this.assertRunning();
        } catch {
          // A runner can reject after it has made itself live (for example,
          // when a runner:started listener throws). Keep this cleanup inside
          // the tracked lifecycle operation so shutdown cannot call stop()
          // concurrently on the same runner.
          if (this.state === 'running') {
            try {
              await stop();
            } catch {
              // The runtime-owned cleanup is already retained in workerCleanups.
            }
          }
          if (this.state !== 'running') this.assertRunning();
          throw unavailable('database');
        }
      });
    };
    const ownedStop = (): Promise<void> =>
      queueOperation(async () => {
        try {
          await stop();
        } catch {
          throw unavailable('database');
        }
      });
    Object.defineProperties(runner, {
      start: {
        configurable: false,
        enumerable: false,
        value: ownedStart,
        writable: false,
      },
      stop: {
        configurable: false,
        enumerable: false,
        value: ownedStop,
        writable: false,
      },
    });
    this.workerCleanups.add(ownedStop);
    return runner;
  }

  private async cleanupWorkers(): Promise<void> {
    const cleanups = [...this.workerCleanups];
    const results = await Promise.allSettled(
      cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
    );
    let cleanupFailed = false;
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        const cleanup = cleanups[index];
        if (cleanup) this.workerCleanups.delete(cleanup);
      } else cleanupFailed = true;
    }
    if (cleanupFailed) {
      this.state = 'close-failed';
      throw unavailable('database');
    }
  }

  private initializeSessionService(): Promise<void> {
    if (!this.sessionServiceReady) {
      this.sessionServiceReady = this.sessionService
        .initialize()
        .catch((error) => {
          this.sessionServiceReady = undefined;
          throw error;
        });
    }
    return this.sessionServiceReady;
  }

  private beginLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const token = Symbol('deployed-runtime-operation');
    this.activeLifecycleOperations.add(token);
    return Promise.resolve()
      .then(() => this.lifecycleOperationContext.run(token, operation))
      .finally(() => {
        this.activeLifecycleOperations.delete(token);
      });
  }

  private async closeConnection(): Promise<void> {
    try {
      await this.bindings.database.close(this.db);
      this.state = 'stopped';
    } catch {
      this.state = 'close-failed';
      throw new DeployedRuntimeError(
        'provider_unavailable',
        "The database connection could not be closed; inspect the provider's private logs.",
        'database',
      );
    }
  }

  private assertRunning(): void {
    if (this.state !== 'running') {
      throw new DeployedRuntimeError(
        'runtime_stopped',
        'The deployed application runtime has already stopped.',
      );
    }
  }
}

function createDiagnostics(
  runtime: ResolvedApplicationRuntime,
): DeployedRuntimeDiagnostics {
  const provider = (value: string): DeployedProviderDiagnostic =>
    Object.freeze({ provider: value, configured: true as const });
  return deepFreeze({
    schemaVersion: 1 as const,
    runtime,
    providers: {
      database: provider(runtime.providers.database.engine),
      authentication: provider(runtime.providers.authentication.provider),
      assets: provider(runtime.providers.assets.provider),
      secrets: provider(runtime.providers.secrets.provider),
    },
    tenancy: {
      mode: runtime.providers.tenancy.mode as 'single-tenant' | 'multi-tenant',
      context: runtime.providers.tenancy.context,
      isolation: runtime.providers.tenancy.isolation,
      rootTenantFallback: 'disabled' as const,
    },
    workers: {
      topology: runtime.providers.jobs.topology as 'external' | 'scalable',
      taskProcess: 'separate' as const,
      scheduleProcess: 'separate' as const,
      replicas:
        runtime.providers.jobs.topology === 'scalable'
          ? ('horizontal' as const)
          : ('operator-managed' as const),
    },
    secretValuesIncluded: false as const,
  });
}

async function probe(
  check: () => Promise<void>,
): Promise<DeployedComponentReadiness> {
  try {
    await check();
    return Object.freeze({ status: 'ready' as const });
  } catch {
    return Object.freeze({ status: 'not-ready' as const });
  }
}

function createStoppedReadiness(
  profile: ApplicationRuntimeProfile,
): DeployedRuntimeReadiness {
  const stopped = Object.freeze({ status: 'not-ready' as const });
  return freezeReadiness(
    profile,
    {
      database: stopped,
      authentication: stopped,
      assets: stopped,
      secrets: stopped,
    },
    false,
  );
}

function freezeReadiness(
  profile: ApplicationRuntimeProfile,
  components: Record<DeployedRuntimeComponent, DeployedComponentReadiness>,
  ready: boolean,
): DeployedRuntimeReadiness {
  return deepFreeze({
    schemaVersion: 1 as const,
    profile: profile as DeployedApplicationRuntimeProfile,
    status: ready ? ('ready' as const) : ('not-ready' as const),
    components,
    secretValuesIncluded: false as const,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDatabaseInterface(value: unknown): value is DatabaseInterface {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { query?: unknown }).query === 'function'
  );
}

function isValidPostgresProbe(
  value: unknown,
): value is { rows: Array<{ smrt_postgres_version: string }> } {
  if (typeof value !== 'object' || value === null) return false;
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row = rows[0];
  if (typeof row !== 'object' || row === null) return false;
  const version = (row as { smrt_postgres_version?: unknown })
    .smrt_postgres_version;
  return typeof version === 'string' && /^\d+$/.test(version);
}

async function cleanupAfterStartupFailure(
  binding: DeployedDatabaseBinding,
  db: unknown,
  startupError: unknown,
): Promise<never> {
  const cleanup = () => binding.close(db as DatabaseInterface);
  try {
    await cleanup();
  } catch {
    throw new DeployedRuntimeCleanupError(cleanup);
  }
  throw startupError;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    if (!Object.isFrozen(value)) Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child, seen);
    }
  }
  return value;
}
