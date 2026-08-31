/**
 * Application-side composition for public self-hosted and managed-cloud
 * runtimes. Provider credentials and vendor clients remain in their owning
 * adapters; this module validates the selected seams, owns the PostgreSQL
 * connection lifecycle, and exposes orchestration-safe diagnostics.
 */

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
    await closeDatabaseQuietly(bindings.database, db);
    throw new DeployedRuntimeError(
      'invalid_configuration',
      'The database adapter did not return a valid database connection.',
      'database',
    );
  }
  try {
    await checkDatabase(bindings.database, db);
  } catch (error) {
    await closeDatabaseQuietly(bindings.database, db);
    throw error;
  }
  try {
    await options.prepareDatabase?.(db);
  } catch {
    await closeDatabaseQuietly(bindings.database, db);
    throw new DeployedRuntimeError(
      'provider_unavailable',
      'The PostgreSQL migration step failed; inspect the application migration logs.',
      'database',
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
  if (!isPlainRecord(options)) {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      'Deployed runtime options must be an object.',
    );
  }
  if (options.profile !== 'self-hosted' && options.profile !== 'cloud') {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      'Deployed runtime initialization requires the self-hosted or cloud profile.',
    );
  }
  return resolveApplicationRuntime({
    profile: options.profile,
    providers: options.providers,
  });
}

function validateBindings(
  options: DeployedApplicationRuntimeOptions,
  runtime: ResolvedApplicationRuntime,
): ValidatedBindings {
  const database = requireObjectBinding<DeployedDatabaseBinding>(
    options.database,
    'database',
  );
  requireFunction(database.connect, 'database', 'connect');
  requireOptionalFunction(database.readiness, 'database', 'readiness');
  requireFunction(database.close, 'database', 'close');
  if (database.engine !== runtime.providers.database.engine) {
    throw mismatch('database', runtime.providers.database.engine);
  }

  const authentication = requireProviderBinding(
    options.authentication,
    'authentication',
    runtime.providers.authentication.provider,
  ) as DeployedProviderBinding<PublicAuthenticationProvider>;
  const assets = requireProviderBinding(
    options.assets,
    'assets',
    runtime.providers.assets.provider,
  ) as DeployedProviderBinding<AssetStorageProvider>;
  const secrets = requireProviderBinding(
    options.secrets,
    'secrets',
    runtime.providers.secrets.provider,
  ) as DeployedProviderBinding<SecretProvider>;

  return { database, authentication, assets, secrets };
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
  if (binding.provider !== expectedProvider) {
    throw mismatch(component, expectedProvider);
  }
  requireFunction(binding.readiness, component, 'readiness');
  return binding;
}

function requireObjectBinding<T>(
  value: unknown,
  component: DeployedRuntimeComponent,
): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeployedRuntimeError(
      'invalid_configuration',
      `The ${component} provider binding is required.`,
      component,
    );
  }
  return value as T;
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
    if (binding.readiness) await binding.readiness(db);
    else {
      const result = await db.query('SELECT 1 AS smrt_runtime_probe');
      if (!isValidDatabaseProbe(result)) throw new Error('invalid probe');
    }
  } catch {
    throw unavailable('database');
  }
}

class InitializedDeployedApplicationRuntime
  implements DeployedApplicationRuntime
{
  private state: 'running' | 'closing' | 'close-failed' | 'stopped' = 'running';
  private closeAttempt?: Promise<void>;
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
      if (!context.tenantId) {
        throw new DeployedRuntimeError(
          'tenant_context_required',
          'The authenticated session does not include the required tenant context.',
          'authentication',
        );
      }
      if (!context.membership?.isActive()) {
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
    const runner = new TaskRunner(config);
    try {
      await runner.initialize(this.db);
    } catch {
      throw unavailable('database');
    }
    this.assertRunning();
    return runner;
  }

  async createScheduleWorker(
    config: ScheduleRunnerConfig = {},
  ): Promise<ScheduleRunner> {
    this.assertRunning();
    const runner = new ScheduleRunner(config);
    try {
      await runner.initialize(this.db);
    } catch {
      throw unavailable('database');
    }
    this.assertRunning();
    return runner;
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
    if (this.state === 'stopped') return;
    if (this.closeAttempt) return this.closeAttempt;

    this.state = 'closing';
    const attempt = Promise.resolve().then(() => this.closeConnection());
    this.closeAttempt = attempt;
    return attempt;
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
    } finally {
      this.closeAttempt = undefined;
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

function isValidDatabaseProbe(
  value: unknown,
): value is { rows: Array<{ smrt_runtime_probe: 1 }> } {
  if (typeof value !== 'object' || value === null) return false;
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row = rows[0];
  return (
    typeof row === 'object' &&
    row !== null &&
    (row as { smrt_runtime_probe?: unknown }).smrt_runtime_probe === 1
  );
}

async function closeDatabaseQuietly(
  binding: DeployedDatabaseBinding,
  db: unknown,
): Promise<void> {
  try {
    await binding.close(db as DatabaseInterface);
  } catch {
    // Preserve the primary startup failure without exposing cleanup details.
  }
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
