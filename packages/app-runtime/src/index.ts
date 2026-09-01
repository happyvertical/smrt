/**
 * Safe, private, single-owner application runtime for the `local` profile.
 *
 * This Node-only subpath owns the small amount of operational composition that
 * does not belong in a generated application: user-owned paths, restrictive
 * local secret material, SQLite tuning, owner bootstrap, and an optional
 * embedded job runner. Domain schema preparation remains an explicit startup
 * step supplied by the application migration layer.
 */

import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  constants,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import {
  type ResolvedApplicationRuntime,
  type RuntimeProviderOverrides,
  resolveApplicationRuntime,
} from '@happyvertical/smrt-config';
import { TaskRunner, type TaskRunnerConfig } from '@happyvertical/smrt-jobs';
import { Person, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  SessionCollection,
  SessionService,
  TenantService,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';

export * from './deployed-runtime.js';

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_BOOTSTRAP_TTL_SECONDS = 10 * 60;
const MAX_BOOTSTRAP_TTL_SECONDS = 15 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const BOOTSTRAP_TABLE = '_smrt_local_owner_bootstrap';
const SECRET_FILE_NAME = 'application.secret';
const DATABASE_FILE_NAME = 'application.sqlite';
const ROOT_MARKER_PREFIX = '.smrt-local-runtime-';
const PREFLIGHT_RETRY_LIMIT = 4;
const INITIALIZATION_LOCK_TIMEOUT_MS = 120_000;
const INITIALIZATION_LOCK_WORKER = `
  const { parentPort, workerData } = require('node:worker_threads');
  let database;
  let transaction;
  (async () => {
    try {
      const { getDatabase } = await import(workerData.sqlModuleUrl);
      database = await getDatabase({
        type: 'sqlite',
        url: workerData.path,
        secureFile: {
          driver: 'node:sqlite',
          custody: 'trusted-parent',
          root: workerData.custodyRoot,
        },
        transactionQueueTimeout: workerData.timeout,
      });
      if (!database.beginTransaction) {
        throw new Error('Secure SQLite does not expose beginTransaction().');
      }
      await database.query('PRAGMA busy_timeout = ' + workerData.timeout);
      transaction = await database.beginTransaction();
      parentPort.postMessage({ type: 'acquired' });
    } catch (error) {
      try { await database?.close?.(); } catch {}
      parentPort.postMessage({ type: 'error', message: String(error) });
      parentPort.close();
      return;
    }
    parentPort.once('message', async (message) => {
      if (message?.type !== 'release') return;
      let releaseError;
      try { await transaction.rollback(); } catch (error) { releaseError = String(error); }
      try { await database.close?.(); } catch (error) { releaseError ??= String(error); }
      parentPort.postMessage({ type: 'released', error: releaseError });
      parentPort.close();
    });
  })().catch((error) => {
    parentPort.postMessage({ type: 'error', message: String(error) });
    parentPort.close();
  });
`;
const execFileAsync = promisify(execFile);

/** Paths owned by the local user, outside the source tree by default. */
export interface LocalRuntimePaths {
  readonly root: string;
  readonly database: string;
  readonly assets: string;
  readonly secrets: string;
  readonly applicationSecret: string;
}

export interface ResolveLocalRuntimePathsOptions {
  /** Stable application identifier, e.g. `lolaus`. */
  appId: string;
  /** Explicit user-owned data directory. Defaults to the OS application-data directory. */
  dataDirectory?: string;
  /** Source checkout to protect from accidental data placement. Defaults to cwd. */
  sourceRoot?: string;
  /** Testable default-root and filesystem case-sensitivity override. */
  platform?: NodeJS.Platform;
  /** Testable home-directory override. */
  homeDirectory?: string;
  /** Testable environment override. */
  env?: NodeJS.ProcessEnv;
}

export interface LocalApplicationRuntimeOptions
  extends ResolveLocalRuntimePathsOptions {
  /** Actual HTTP bind host. Owner bootstrap refuses non-loopback values. */
  bindHost?: string;
  /**
   * Explicit application migration/schema hook, invoked before identity access.
   * It must be idempotent; runtime code never synthesizes application tables.
   */
  prepareDatabase?: (db: DatabaseInterface) => Promise<void>;
  /** Local profile provider overrides (only validated local combinations survive). */
  providers?: RuntimeProviderOverrides;
  /** Short-lived bootstrap token lifetime. Range: 1..900 seconds. */
  bootstrapTtlSeconds?: number;
  /** Normal authenticated session lifetime in whole seconds. Minimum 1. */
  sessionTtlSeconds?: number;
  /** Explicit opt-in for persisted background work. Default false. */
  backgroundJobs?: boolean;
  /** Explicit opt-in for application-defined paid capabilities. Default false. */
  paidCapabilities?: boolean;
  /** Testable clock. */
  now?: () => Date;
}

/**
 * Claim the secure local database root before a standalone migration command
 * opens SQLite. This does not create application schema or bootstrap records.
 */
export async function prepareLocalDatabaseStorage(
  options: ResolveLocalRuntimePathsOptions,
): Promise<LocalRuntimePaths> {
  const paths = resolveLocalRuntimePaths(options);
  const sourceRoot = resolve(options.sourceRoot ?? process.cwd());
  const appId = validateApplicationId(options.appId);
  await preflightLocalApplicationRoot(paths.root, sourceRoot, appId);
  const initializationLock = await acquireInitializationLock(paths.root);
  let db: DatabaseInterface | undefined;
  let failure: unknown;
  try {
    await preflightLocalApplicationRoot(paths.root, sourceRoot, appId);
    const acquired = await acquireLocalDatabase(paths, sourceRoot, appId);
    db = acquired.db;
    await db.close?.();
    db = undefined;
  } catch (error) {
    failure = db ? await closeDatabaseAfterFailure(db, error) : error;
    db = undefined;
  }
  try {
    await initializationLock.release();
  } catch (releaseError) {
    failure = failure
      ? preservePrimaryFailure(
          failure,
          releaseError,
          'initializationLockReleaseError',
          'Local database storage preparation and initialization-lock release both failed.',
        )
      : releaseError;
  }
  if (failure) throw failure;
  return paths;
}

export interface LocalOwnerBootstrapInvitation {
  /** Plaintext is returned exactly when a new claim is issued; it is never persisted. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface LocalRuntimeInitialization {
  readonly runtime: LocalApplicationRuntime;
  readonly bootstrap: LocalOwnerBootstrapInvitation | null;
  readonly diagnostics: LocalRuntimeDiagnostics;
}

export interface ClaimLocalOwnerInput {
  token: string;
  name: string;
  email: string;
  tenantName?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface LocalOwnerClaimResult {
  readonly profileId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly sessionId: string;
}

export type LocalBootstrapStatus =
  | 'available'
  | 'expired'
  | 'claimed'
  | 'unavailable';

/** Secret-free, machine-readable local runtime state. */
export interface LocalRuntimeDiagnostics {
  readonly schemaVersion: 1;
  readonly runtime: ResolvedApplicationRuntime;
  readonly bind: {
    readonly host: string;
    readonly loopback: true;
  };
  readonly paths: LocalRuntimePaths;
  readonly storage: {
    readonly database: 'sqlite-file';
    readonly assets: 'user-owned-directory';
    readonly secrets: 'mode-0600-local-file';
  };
  readonly bootstrap: {
    readonly status: LocalBootstrapStatus;
    readonly expiresAt: string | null;
    readonly tokenValuesIncluded: false;
    readonly tokenHashesIncluded: false;
  };
  readonly tenancy: {
    readonly mode: 'real-default-tenant';
    readonly ui: 'hidden';
  };
  readonly jobs: {
    readonly topology: 'inline' | 'embedded';
    readonly backgroundEnabled: boolean;
  };
  readonly paidCapabilitiesEnabled: boolean;
  readonly secretValuesIncluded: false;
}

export type LocalRuntimeErrorCode =
  | 'bootstrap_claimed'
  | 'bootstrap_expired'
  | 'bootstrap_invalid'
  | 'bootstrap_unavailable'
  | 'capability_disabled'
  | 'invalid_configuration'
  | 'unsafe_public_exposure';

/** Stable, secret-free local-runtime failure. */
export class LocalRuntimeError extends Error {
  constructor(
    readonly code: LocalRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalRuntimeError';
  }
}

interface BootstrapRow {
  expires_at?: unknown;
  consumed_at?: unknown;
}

interface ExistingOwner {
  userId: string;
  tenantId: string;
}

/**
 * Resolve deterministic user-owned paths and reject source-tree placement.
 */
export function resolveLocalRuntimePaths(
  options: ResolveLocalRuntimePathsOptions,
): LocalRuntimePaths {
  const appId = validateApplicationId(options.appId);
  const runtimePlatform = options.platform ?? platform();
  const runtimeHome = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  const defaultRoot = defaultApplicationDataRoot(
    runtimePlatform,
    runtimeHome,
    env,
  );
  const root = resolve(options.dataDirectory ?? resolve(defaultRoot, appId));
  const sourceRoot = resolve(options.sourceRoot ?? process.cwd());

  if (
    sameFilesystemPath(root, runtimeHome, runtimePlatform) ||
    sameFilesystemPath(root, parse(root).root, runtimePlatform) ||
    isInside(sourceRoot, root, runtimePlatform) ||
    isInside(root, sourceRoot, runtimePlatform)
  ) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      'Local application data must be a dedicated directory that does not overlap the source tree.',
    );
  }

  return Object.freeze({
    root,
    database: resolve(root, DATABASE_FILE_NAME),
    assets: resolve(root, 'assets'),
    secrets: resolve(root, 'secrets'),
    applicationSecret: resolve(root, 'secrets', SECRET_FILE_NAME),
  });
}

/**
 * Initialize or reopen a local application runtime.
 *
 * A plaintext bootstrap token is returned only when this call creates a new
 * invitation. Existing unexpired invitations remain valid but cannot be read
 * back because only their HMAC is stored.
 */
export async function initializeLocalApplicationRuntime(
  options: LocalApplicationRuntimeOptions,
): Promise<LocalRuntimeInitialization> {
  const bindHost = normalizeLoopbackHost(options.bindHost ?? DEFAULT_BIND_HOST);
  const bootstrapTtlSeconds = validateBootstrapTtl(
    options.bootstrapTtlSeconds ?? DEFAULT_BOOTSTRAP_TTL_SECONDS,
  );
  const sessionTtlSeconds = validateSessionTtl(
    options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
  );
  const resolvedRuntime = resolveApplicationRuntime({
    profile: 'local',
    providers: options.providers,
  });
  const paths = resolveLocalRuntimePaths(options);
  const sourceRoot = resolve(options.sourceRoot ?? process.cwd());
  const appId = validateApplicationId(options.appId);
  await preflightLocalApplicationRoot(paths.root, sourceRoot, appId);
  const initializationLock = await acquireInitializationLock(paths.root);
  let db: DatabaseInterface | undefined;
  let initialization: LocalRuntimeInitialization | undefined;
  let initializationFailure: unknown;
  let initializationFailed = false;
  try {
    await preflightLocalApplicationRoot(paths.root, sourceRoot, appId);
    const acquired = await acquireLocalDatabase(paths, sourceRoot, appId);
    db = acquired.db;
    const { canonicalSourceRoot } = acquired;
    await prepareLocalFilesystem(paths, canonicalSourceRoot);
    await tuneLocalSqlite(db);
    await options.prepareDatabase?.(db);
    await ensureBootstrapTable(db);

    const runtime = new InitializedLocalApplicationRuntime({
      db,
      paths,
      bindHost,
      resolvedRuntime,
      bootstrapTtlSeconds,
      sessionTtlSeconds,
      backgroundJobs: options.backgroundJobs === true,
      paidCapabilities: options.paidCapabilities === true,
      now: options.now ?? (() => new Date()),
      canonicalSourceRoot,
    });
    const bootstrap = await runtime.ensureBootstrapInvitation();
    initialization = {
      runtime,
      bootstrap,
      diagnostics: await runtime.diagnostics(),
    };
  } catch (error) {
    initializationFailed = true;
    initializationFailure = db
      ? await closeDatabaseAfterFailure(db, error)
      : error;
    db = undefined;
  }

  try {
    await initializationLock.release();
  } catch (releaseError) {
    if (initializationFailed) {
      initializationFailure = preservePrimaryFailure(
        initializationFailure,
        releaseError,
        'initializationLockReleaseError',
        'Local runtime initialization and initialization-lock release both failed.',
      );
    } else if (db) {
      initializationFailed = true;
      initializationFailure = await closeDatabaseAfterFailure(db, releaseError);
      db = undefined;
    } else {
      initializationFailed = true;
      initializationFailure = releaseError;
    }
  }

  if (initializationFailed) throw initializationFailure;
  if (!initialization) {
    throw new Error('Local runtime initialization completed without a result.');
  }
  return initialization;
}

interface LocalApplicationRuntimeState {
  db: DatabaseInterface;
  paths: LocalRuntimePaths;
  bindHost: string;
  resolvedRuntime: ResolvedApplicationRuntime;
  bootstrapTtlSeconds: number;
  sessionTtlSeconds: number;
  backgroundJobs: boolean;
  paidCapabilities: boolean;
  now: () => Date;
  canonicalSourceRoot: string;
}

/** Initialized local runtime used by server startup and onboarding handlers. */
export interface LocalApplicationRuntime {
  readonly db: DatabaseInterface;
  readonly paths: LocalRuntimePaths;
  readonly bindHost: string;
  readonly resolvedRuntime: ResolvedApplicationRuntime;
  readonly backgroundJobsEnabled: boolean;
  readonly paidCapabilitiesEnabled: boolean;
  ensureBootstrapInvitation(): Promise<LocalOwnerBootstrapInvitation | null>;
  rotateBootstrapInvitation(): Promise<LocalOwnerBootstrapInvitation>;
  claimOwner(input: ClaimLocalOwnerInput): Promise<LocalOwnerClaimResult>;
  restoreSession(
    sessionId: string,
  ): ReturnType<SessionService['loadSessionContext']>;
  createEmbeddedJobRunner(config?: TaskRunnerConfig): Promise<TaskRunner>;
  diagnostics(): Promise<LocalRuntimeDiagnostics>;
}

class InitializedLocalApplicationRuntime implements LocalApplicationRuntime {
  readonly db: DatabaseInterface;
  readonly paths: LocalRuntimePaths;
  readonly bindHost: string;
  readonly resolvedRuntime: ResolvedApplicationRuntime;
  readonly backgroundJobsEnabled: boolean;
  readonly paidCapabilitiesEnabled: boolean;
  private readonly bootstrapTtlSeconds: number;
  private readonly sessionTtlSeconds: number;
  private readonly now: () => Date;
  private readonly canonicalSourceRoot: string;

  constructor(state: LocalApplicationRuntimeState) {
    this.db = state.db;
    this.paths = state.paths;
    this.bindHost = state.bindHost;
    this.resolvedRuntime = state.resolvedRuntime;
    this.bootstrapTtlSeconds = state.bootstrapTtlSeconds;
    this.sessionTtlSeconds = state.sessionTtlSeconds;
    this.backgroundJobsEnabled = state.backgroundJobs;
    this.paidCapabilitiesEnabled = state.paidCapabilities;
    this.now = state.now;
    this.canonicalSourceRoot = state.canonicalSourceRoot;
  }

  /**
   * Issue the first short-lived owner invitation when none is active.
   * Repeated startup never rotates an unexpired token or duplicates an owner.
   */
  async ensureBootstrapInvitation(): Promise<LocalOwnerBootstrapInvitation | null> {
    if (await findExistingOwner(this.db)) return null;
    const current = await readBootstrapRow(this.db);
    if (current?.consumed_at != null) return null;
    const now = this.now();
    const currentExpiry = parseStoredDate(current?.expires_at);
    if (
      current &&
      current.consumed_at == null &&
      currentExpiry !== null &&
      currentExpiry.getTime() > now.getTime()
    ) {
      return null;
    }
    return this.issueBootstrapInvitation(false);
  }

  /** Explicit recovery when an installer lost the one-time plaintext token. */
  async rotateBootstrapInvitation(): Promise<LocalOwnerBootstrapInvitation> {
    if (await findExistingOwner(this.db)) {
      throw new LocalRuntimeError(
        'bootstrap_claimed',
        'The local owner has already been claimed.',
      );
    }
    if ((await readBootstrapRow(this.db))?.consumed_at != null) {
      throw new LocalRuntimeError(
        'bootstrap_claimed',
        'The local owner bootstrap invitation has already been consumed.',
      );
    }
    const invitation = await this.issueBootstrapInvitation(true);
    if (!invitation) {
      if ((await readBootstrapRow(this.db))?.consumed_at != null) {
        throw new LocalRuntimeError(
          'bootstrap_claimed',
          'The local owner bootstrap invitation has already been consumed.',
        );
      }
      throw new LocalRuntimeError(
        'bootstrap_unavailable',
        'A local owner bootstrap invitation could not be issued.',
      );
    }
    return invitation;
  }

  /**
   * Consume a bootstrap token and atomically create normal identity/RBAC/session
   * records. The token transition and every record write share one transaction.
   */
  async claimOwner(
    input: ClaimLocalOwnerInput,
  ): Promise<LocalOwnerClaimResult> {
    validateOwnerInput(input);
    if (await findExistingOwner(this.db)) {
      throw new LocalRuntimeError(
        'bootstrap_claimed',
        'The local owner has already been claimed.',
      );
    }
    if (typeof this.db.transaction !== 'function') {
      throw new LocalRuntimeError(
        'bootstrap_unavailable',
        'Owner bootstrap requires a database adapter with transaction support.',
      );
    }

    const tokenHash = await this.hashBootstrapToken(input.token);
    const now = this.now();
    const nowIso = now.toISOString();
    return this.db.transaction(async (tx) => {
      const claimed = await tx.query(
        `UPDATE ${BOOTSTRAP_TABLE}
         SET consumed_at = ?
         WHERE slot = 1
           AND token_hash = ?
           AND consumed_at IS NULL
           AND expires_at > ?
         RETURNING expires_at`,
        nowIso,
        tokenHash,
        nowIso,
      );
      if (claimed.rows.length === 0) {
        await throwBootstrapClaimFailure(tx, now);
      }

      const concurrentOwner = await findExistingOwner(tx);
      if (concurrentOwner) {
        throw new LocalRuntimeError(
          'bootstrap_claimed',
          'The local owner has already been claimed.',
        );
      }

      return createLocalOwnerRecords(tx, input, this.sessionTtlSeconds);
    });
  }

  /** Restore the normal server-side session created by owner bootstrap. */
  async restoreSession(sessionId: string) {
    const service = new SessionService({ db: this.db });
    await service.initialize();
    return service.loadSessionContext(sessionId);
  }

  /**
   * Create an in-process persisted-job runner. Background work is default-off
   * and must be explicitly enabled by runtime configuration.
   */
  async createEmbeddedJobRunner(
    config: TaskRunnerConfig = {},
  ): Promise<TaskRunner> {
    if (!this.backgroundJobsEnabled) {
      throw new LocalRuntimeError(
        'capability_disabled',
        'Background jobs are disabled; enable them explicitly for this local application.',
      );
    }
    if (this.resolvedRuntime.providers.jobs.topology !== 'embedded') {
      throw new LocalRuntimeError(
        'invalid_configuration',
        'An embedded runner requires the local embedded job topology.',
      );
    }
    const runner = new TaskRunner({
      concurrency: 1,
      retention: false,
      ...config,
    });
    await runner.initialize(this.db);
    return runner;
  }

  /** Return a deterministic snapshot that never reads secret file contents. */
  async diagnostics(): Promise<LocalRuntimeDiagnostics> {
    const owner = await findExistingOwner(this.db);
    const bootstrap = await readBootstrapRow(this.db);
    const now = this.now();
    const expiresAt = parseStoredDate(bootstrap?.expires_at);
    let status: LocalBootstrapStatus = 'unavailable';
    if (owner || bootstrap?.consumed_at != null) status = 'claimed';
    else if (expiresAt && expiresAt.getTime() > now.getTime())
      status = 'available';
    else if (expiresAt) status = 'expired';

    return Object.freeze({
      schemaVersion: 1,
      runtime: this.resolvedRuntime,
      bind: Object.freeze({ host: this.bindHost, loopback: true as const }),
      paths: this.paths,
      storage: Object.freeze({
        database: 'sqlite-file' as const,
        assets: 'user-owned-directory' as const,
        secrets: 'mode-0600-local-file' as const,
      }),
      bootstrap: Object.freeze({
        status,
        expiresAt: expiresAt?.toISOString() ?? null,
        tokenValuesIncluded: false as const,
        tokenHashesIncluded: false as const,
      }),
      tenancy: Object.freeze({
        mode: 'real-default-tenant' as const,
        ui: 'hidden' as const,
      }),
      jobs: Object.freeze({
        topology: this.resolvedRuntime.providers.jobs.topology as
          | 'inline'
          | 'embedded',
        backgroundEnabled: this.backgroundJobsEnabled,
      }),
      paidCapabilitiesEnabled: this.paidCapabilitiesEnabled,
      secretValuesIncluded: false as const,
    });
  }

  private async issueBootstrapInvitation(
    replaceActive: boolean,
  ): Promise<LocalOwnerBootstrapInvitation | null> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await this.hashBootstrapToken(token);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.bootstrapTtlSeconds * 1000);
    const stored = await this.db.query(
      `INSERT INTO ${BOOTSTRAP_TABLE}
        (slot, token_hash, expires_at, consumed_at, created_at)
       VALUES (1, ?, ?, NULL, ?)
       ON CONFLICT(slot) DO UPDATE SET
         token_hash = excluded.token_hash,
         expires_at = excluded.expires_at,
         consumed_at = NULL,
         created_at = excluded.created_at
       WHERE ${BOOTSTRAP_TABLE}.consumed_at IS NULL
         AND (? = 1 OR ${BOOTSTRAP_TABLE}.expires_at <= ?)
       RETURNING token_hash`,
      tokenHash,
      expiresAt.toISOString(),
      now.toISOString(),
      replaceActive ? 1 : 0,
      now.toISOString(),
    );
    const persistedHash = (
      stored.rows[0] as { token_hash?: unknown } | undefined
    )?.token_hash;
    if (persistedHash !== tokenHash) return null;
    return Object.freeze({ token, expiresAt: expiresAt.toISOString() });
  }

  private async hashBootstrapToken(token: string): Promise<string> {
    const secret = await validateApplicationSecret(
      this.paths.applicationSecret,
      this.canonicalSourceRoot,
    );
    return createHmac('sha256', secret.trim()).update(token).digest('hex');
  }
}

async function createLocalOwnerRecords(
  db: DatabaseInterface,
  input: ClaimLocalOwnerInput,
  sessionTtlSeconds: number,
): Promise<LocalOwnerClaimResult> {
  const profileTypes = await ProfileTypeCollection.create({ db });
  const personType = await withSystemContext(() =>
    profileTypes.getOrCreateGlobalBySlug('person', {
      name: 'Person',
      description: 'An individual person',
    }),
  );
  const person = new Person({
    db,
    typeId: requireId(personType.id, 'Person profile type'),
    tenantId: null,
    name: input.name.trim(),
    email: input.email.trim(),
  });
  await person.initialize();
  await person.save();

  const users = await UserCollection.create({ db });
  const user = await users.create({
    profileId: requireId(person.id, 'Person'),
    email: input.email.trim(),
    status: UserStatus.ACTIVE,
    lastLoginAt: new Date(),
  });
  await user.save();

  const tenantService = new TenantService(
    { db },
    {
      mode: 'required',
      maxTenants: 1,
      defaultName: input.tenantName?.trim() || 'My Workspace',
    },
  );
  await tenantService.initialize();
  const { tenant, membership } = await tenantService.createTenantWithOwnership(
    requireId(user.id, 'User'),
    input.tenantName?.trim() || 'My Workspace',
    { slug: 'default' },
  );

  const sessions = await SessionCollection.create({ db });
  const session = await sessions.createSession({
    userId: requireId(user.id, 'User'),
    tenantId: requireId(tenant.id, 'Tenant'),
    ttl: sessionTtlSeconds,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
    data: { localOwner: true },
  });

  return Object.freeze({
    profileId: requireId(person.id, 'Person'),
    userId: requireId(user.id, 'User'),
    tenantId: requireId(tenant.id, 'Tenant'),
    membershipId: requireId(membership.id, 'Membership'),
    sessionId: requireId(session.id, 'Session'),
  });
}

async function findExistingOwner(
  db: DatabaseInterface,
): Promise<ExistingOwner | null> {
  const roles = await RoleCollection.create({ db });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  if (!ownerRole?.id) return null;
  const memberships = await MembershipCollection.create({ db });
  const ownerMemberships = await memberships.findByRole(ownerRole.id);
  const active = ownerMemberships.find(
    (membership) =>
      membership.status === MembershipStatus.ACTIVE &&
      typeof membership.userId === 'string' &&
      typeof membership.tenantId === 'string',
  );
  return active
    ? { userId: active.userId as string, tenantId: active.tenantId as string }
    : null;
}

async function throwBootstrapClaimFailure(
  db: DatabaseInterface,
  now: Date,
): Promise<never> {
  const row = await readBootstrapRow(db);
  if (!row) {
    throw new LocalRuntimeError(
      'bootstrap_unavailable',
      'No local owner bootstrap invitation is available.',
    );
  }
  if (row.consumed_at != null) {
    throw new LocalRuntimeError(
      'bootstrap_claimed',
      'The local owner bootstrap invitation has already been consumed.',
    );
  }
  const expiresAt = parseStoredDate(row.expires_at);
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
    throw new LocalRuntimeError(
      'bootstrap_expired',
      'The local owner bootstrap invitation has expired.',
    );
  }
  throw new LocalRuntimeError(
    'bootstrap_invalid',
    'The local owner bootstrap token is invalid.',
  );
}

async function readBootstrapRow(
  db: DatabaseInterface,
): Promise<BootstrapRow | null> {
  const result = await db.query(
    `SELECT expires_at, consumed_at
     FROM ${BOOTSTRAP_TABLE}
     WHERE slot = 1
     LIMIT 1`,
  );
  return (result.rows[0] as BootstrapRow | undefined) ?? null;
}

async function ensureBootstrapTable(db: DatabaseInterface): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${BOOTSTRAP_TABLE} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT NULL,
      created_at TEXT NOT NULL
    )`,
  );
}

async function tuneLocalSqlite(db: DatabaseInterface): Promise<void> {
  await db.query('PRAGMA foreign_keys = ON');
  await db.query('PRAGMA journal_mode = WAL');
  await db.query('PRAGMA synchronous = FULL');
  await db.query('PRAGMA busy_timeout = 5000');
}

interface PreparedLocalRoot {
  createdDirectories: string[];
  pendingMarker: string | null;
  pendingMarkerCreatedByAttempt: boolean;
  finalMarker: string;
}

interface LocalInitializationLock {
  release(): Promise<void>;
}

async function preflightLocalApplicationRoot(
  root: string,
  sourceRoot: string,
  appId: string,
): Promise<void> {
  for (let attempt = 0; attempt < PREFLIGHT_RETRY_LIMIT; attempt += 1) {
    try {
      await preflightLocalApplicationRootOnce(root, sourceRoot, appId);
      return;
    } catch (error) {
      if (!isMissingFile(error) && !hasMissingFileCause(error)) throw error;
      if (attempt === PREFLIGHT_RETRY_LIMIT - 1) {
        throw unsafeFilesystemEntry(
          'Local application data changed repeatedly during read-only preflight.',
          error,
        );
      }
      await new Promise<void>((resolveRetry) => setImmediate(resolveRetry));
    }
  }
}

async function preflightLocalApplicationRootOnce(
  root: string,
  sourceRoot: string,
  appId: string,
): Promise<void> {
  requireNoFollowSupport();
  const canonicalSourceRoot = await realpath(sourceRoot);
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw unsafeFilesystemEntry(
      'Local runtime storage requires a numeric current-user identity.',
    );
  }
  if (
    isInside(canonicalSourceRoot, root) ||
    isInside(root, canonicalSourceRoot)
  ) {
    throw unsafeFilesystemEntry(
      'Local application data must remain outside the canonical source tree.',
    );
  }

  let rootExists = true;
  for (const component of absolutePathComponents(root)) {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(component);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      rootExists = false;
      break;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw unsafeFilesystemEntry(
        `Local runtime path component must be a real directory: ${component}`,
      );
    }
    await assertCanonicalEntry(component, canonicalSourceRoot);
    const sharedStickyRoot = details.uid === 0 && (details.mode & 0o1000) !== 0;
    if (
      (details.uid !== currentUid && details.uid !== 0) ||
      ((details.mode & 0o022) !== 0 && !sharedStickyRoot)
    ) {
      throw unsafeFilesystemEntry(
        `Local runtime path ancestry does not have trusted-parent custody: ${component}`,
      );
    }
    await assertNoPermissiveDarwinAcl(component);
  }

  if (!rootExists) return;
  const rootDetails = await lstat(root);
  if (rootDetails.uid !== currentUid || (rootDetails.mode & 0o777) !== 0o700) {
    throw unsafeFilesystemEntry(
      `Existing local application data root must already be owned by the current user with mode 0700: ${root}`,
    );
  }
  await preflightDedicatedRoot(root, canonicalSourceRoot, appId);
}

async function preflightDedicatedRoot(
  root: string,
  canonicalSourceRoot: string,
  appId: string,
): Promise<void> {
  const finalMarker = resolve(root, `${ROOT_MARKER_PREFIX}${appId}`);
  const pendingMarker = resolve(root, `${ROOT_MARKER_PREFIX}${appId}.pending`);
  const entries = await readdir(root);
  const finalMarkerName = finalMarker.slice(root.length + 1);
  const pendingMarkerName = pendingMarker.slice(root.length + 1);
  const hasFinalMarker = entries.includes(finalMarkerName);
  const hasPendingMarker = entries.includes(pendingMarkerName);

  if (hasFinalMarker) {
    await validateRootMarker(finalMarker, canonicalSourceRoot);
    if (hasPendingMarker) {
      await validateRootMarker(pendingMarker, canonicalSourceRoot);
    }
    return;
  }
  if (hasPendingMarker) {
    await validateRootMarker(pendingMarker, canonicalSourceRoot);
    const permittedInterruptedEntries = new Set([
      pendingMarkerName,
      DATABASE_FILE_NAME,
      `${DATABASE_FILE_NAME}-shm`,
      `${DATABASE_FILE_NAME}-wal`,
    ]);
    if (entries.some((entry) => !permittedInterruptedEntries.has(entry))) {
      throw unsafeFilesystemEntry(
        'Interrupted local application root contains unexpected artifacts.',
      );
    }
    return;
  }
  if (entries.length > 0) {
    throw unsafeFilesystemEntry(
      'Existing local application data root is populated but has no valid ownership marker.',
    );
  }
}

async function assertNoPermissiveDarwinAcl(path: string): Promise<void> {
  if (platform() !== 'darwin') return;
  let listing: string;
  try {
    const result = await execFileAsync('/bin/ls', ['-lde', '--', path], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    listing = result.stdout;
  } catch (error) {
    throw unsafeFilesystemEntry(
      `Local runtime could not inspect macOS access controls: ${path}`,
      error,
    );
  }
  for (const line of listing.split('\n')) {
    if (!/^\s*\d+:/.test(line)) continue;
    const entry = line.match(/^\s*\d+:\s+.+\s+(allow|deny)\s+\S.*$/);
    if (entry?.[1] !== 'deny') {
      throw unsafeFilesystemEntry(
        `Local runtime path contains a permissive macOS access control list: ${path}`,
      );
    }
  }
}

async function acquireLocalDatabase(
  paths: LocalRuntimePaths,
  sourceRoot: string,
  appId: string,
): Promise<{
  canonicalSourceRoot: string;
  db: DatabaseInterface;
}> {
  requireNoFollowSupport();
  const canonicalSourceRoot = await realpath(sourceRoot);
  const createdDirectories = await ensureSafeDirectoryTree(
    paths.root,
    canonicalSourceRoot,
    true,
  );
  const prepared = await prepareDedicatedRoot(
    paths.root,
    canonicalSourceRoot,
    appId,
    createdDirectories,
  );
  let db: DatabaseInterface | undefined;
  try {
    db = await getDatabase({
      type: 'sqlite',
      url: paths.database,
      secureFile: {
        driver: 'node:sqlite',
        custody: 'trusted-parent',
        root: paths.root,
      },
    });
    await enforcePrivateDatabaseMode(paths.database, canonicalSourceRoot);
  } catch (error) {
    if (db) throw await closeDatabaseAfterFailure(db, error);
    if (prepared.pendingMarkerCreatedByAttempt) {
      await removeMarkerIfPresent(prepared.pendingMarker, canonicalSourceRoot);
      await removeCreatedDirectories(createdDirectories);
    }
    throw error;
  }
  if (!db) {
    throw new Error('Local runtime database acquisition returned no database.');
  }

  // Once SQLite acquisition succeeds, the database is an authoritative
  // artifact. Keep the pending marker through every promotion failure so a
  // later startup can resume rather than seeing an unmarked populated root.
  try {
    await publishRootMarker(prepared.finalMarker, canonicalSourceRoot);
    await removeMarkerIfPresent(prepared.pendingMarker, canonicalSourceRoot);
  } catch (error) {
    throw await closeDatabaseAfterFailure(db, error);
  }
  return { canonicalSourceRoot, db };
}

async function enforcePrivateDatabaseMode(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const database = await openSafeFile(
    path,
    constants.O_RDWR,
    0o600,
    'Local application database',
    canonicalSourceRoot,
  );
  try {
    await database.chmod(0o600);
    await database.sync();
  } finally {
    await database.close();
  }
}

async function closeDatabaseAfterFailure(
  db: DatabaseInterface,
  primaryFailure: unknown,
): Promise<unknown> {
  try {
    await db.close?.();
  } catch (cleanupFailure) {
    return preservePrimaryFailure(
      primaryFailure,
      cleanupFailure,
      'databaseCleanupError',
      'Local runtime initialization and database cleanup both failed.',
    );
  }
  return primaryFailure;
}

function preservePrimaryFailure(
  primaryFailure: unknown,
  secondaryFailure: unknown,
  secondaryProperty: string,
  aggregateMessage: string,
): unknown {
  if (primaryFailure instanceof Error) {
    try {
      Object.defineProperty(primaryFailure, secondaryProperty, {
        value: secondaryFailure,
        configurable: true,
      });
    } catch {
      // A frozen application error must remain primary even when secondary
      // failure context cannot be attached to it.
    }
    return primaryFailure;
  }
  return new AggregateError(
    [primaryFailure, secondaryFailure],
    aggregateMessage,
  );
}

async function prepareLocalFilesystem(
  paths: LocalRuntimePaths,
  canonicalSourceRoot: string,
): Promise<void> {
  await ensureSafeDirectoryTree(paths.assets, canonicalSourceRoot);
  await ensureSafeDirectoryTree(paths.secrets, canonicalSourceRoot);
  await ensureApplicationSecret(paths.applicationSecret, canonicalSourceRoot);
}

async function prepareDedicatedRoot(
  path: string,
  canonicalSourceRoot: string,
  appId: string,
  createdDirectories: string[],
): Promise<PreparedLocalRoot> {
  const finalMarker = resolve(path, `${ROOT_MARKER_PREFIX}${appId}`);
  const pendingMarker = resolve(path, `${ROOT_MARKER_PREFIX}${appId}.pending`);
  const entries = await readdir(path);
  const hasFinalMarker = entries.includes(finalMarker.slice(path.length + 1));
  const hasPendingMarker = entries.includes(
    pendingMarker.slice(path.length + 1),
  );

  if (hasFinalMarker) {
    await validateRootMarker(finalMarker, canonicalSourceRoot);
    if (hasPendingMarker) {
      await validateRootMarker(pendingMarker, canonicalSourceRoot);
    }
    return {
      createdDirectories,
      pendingMarker: hasPendingMarker ? pendingMarker : null,
      pendingMarkerCreatedByAttempt: false,
      finalMarker,
    };
  }

  if (hasPendingMarker) {
    await validateRootMarker(pendingMarker, canonicalSourceRoot);
    const permittedInterruptedEntries = new Set([
      pendingMarker.slice(path.length + 1),
      DATABASE_FILE_NAME,
      `${DATABASE_FILE_NAME}-shm`,
      `${DATABASE_FILE_NAME}-wal`,
    ]);
    if (entries.some((entry) => !permittedInterruptedEntries.has(entry))) {
      throw unsafeFilesystemEntry(
        'Interrupted local application root contains unexpected artifacts.',
      );
    }
    return {
      createdDirectories,
      pendingMarker,
      pendingMarkerCreatedByAttempt: false,
      finalMarker,
    };
  }

  if (entries.length > 0) {
    throw unsafeFilesystemEntry(
      'Existing local application data root is populated but has no valid ownership marker.',
    );
  }
  const pendingMarkerCreatedByAttempt = await publishRootMarker(
    pendingMarker,
    canonicalSourceRoot,
  );
  return {
    createdDirectories,
    pendingMarker,
    pendingMarkerCreatedByAttempt,
    finalMarker,
  };
}

async function acquireInitializationLock(
  root: string,
): Promise<LocalInitializationLock> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw unsafeFilesystemEntry(
      'Local runtime initialization locks require a numeric current-user identity.',
    );
  }
  const canonicalTemporaryRoot = await realpath('/tmp');
  const lockRoot = resolve(canonicalTemporaryRoot, `.smrt-${currentUid}`);
  try {
    await mkdir(lockRoot, { mode: 0o700 });
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  }
  const lockRootDetails = await lstat(lockRoot);
  if (
    !lockRootDetails.isDirectory() ||
    lockRootDetails.isSymbolicLink() ||
    lockRootDetails.uid !== currentUid ||
    (lockRootDetails.mode & 0o777) !== 0o700
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime lock directory must be current-user-owned with mode 0700: ${lockRoot}`,
    );
  }
  const lockKey = createHash('sha256')
    .update(normalizeFilesystemIdentity(root))
    .digest('hex')
    .slice(0, 32);
  const custodyRoot = resolve(lockRoot, lockKey);
  try {
    await mkdir(custodyRoot, { mode: 0o700 });
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  }
  const path = resolve(custodyRoot, 'initialization.sqlite');
  return acquireInitializationDatabaseLease(path, custodyRoot);
}

async function acquireInitializationDatabaseLease(
  path: string,
  custodyRoot: string,
): Promise<LocalInitializationLock> {
  const worker = new Worker(INITIALIZATION_LOCK_WORKER, {
    eval: true,
    workerData: {
      path,
      custodyRoot,
      timeout: INITIALIZATION_LOCK_TIMEOUT_MS,
      sqlModuleUrl: import.meta.resolve('@happyvertical/sql'),
    },
  });
  const acquisitionFailure = (cause: unknown) => {
    const failure = new LocalRuntimeError(
      'invalid_configuration',
      'Could not acquire the local runtime initialization lease within two minutes.',
    );
    Object.defineProperty(failure, 'cause', { value: cause });
    return failure;
  };
  let workerError: unknown;
  const exited = new Promise<never>((_resolve, reject) => {
    worker.once('error', (error) => {
      workerError = error;
    });
    worker.once('exit', (code) => {
      reject(
        acquisitionFailure(
          workerError ??
            new Error(`Initialization lock worker exited ${code}.`),
        ),
      );
    });
  });
  const acquired = new Promise<void>((resolvePromise, reject) => {
    const onMessage = (message: { type?: string; message?: string }) => {
      if (message.type === 'acquired') {
        worker.off('message', onMessage);
        resolvePromise();
      } else if (message.type === 'error') {
        worker.off('message', onMessage);
        reject(acquisitionFailure(new Error(message.message)));
      }
    };
    worker.on('message', onMessage);
  });
  await Promise.race([acquired, exited]);

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      const releaseCompleted = new Promise<void>((resolvePromise, reject) => {
        const onMessage = (message: { type?: string; error?: string }) => {
          if (message.type !== 'released') return;
          worker.off('message', onMessage);
          if (message.error) reject(new Error(message.error));
          else resolvePromise();
        };
        worker.on('message', onMessage);
        worker.postMessage({ type: 'release' });
      });
      try {
        await Promise.race([releaseCompleted, exited]);
      } finally {
        await worker.terminate();
      }
    },
  };
}

async function ensureSafeDirectoryTree(
  path: string,
  canonicalSourceRoot: string,
  dedicatedRoot = false,
): Promise<string[]> {
  const components = absolutePathComponents(path);
  const createdDirectories: string[] = [];
  for (const component of components) {
    let created = false;
    try {
      const details = await lstat(component);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw unsafeFilesystemEntry(
          `Local runtime path component must be a real directory: ${component}`,
        );
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      try {
        await mkdir(component, { mode: 0o700 });
        created = true;
        createdDirectories.push(component);
      } catch (mkdirError) {
        // A concurrent initializer may have created the component. It is still
        // opened and validated without following links below.
        if (!isFileAlreadyExists(mkdirError)) throw mkdirError;
      }
    }

    const directory = await openSafeDirectory(component, canonicalSourceRoot);
    try {
      await assertCanonicalEntry(component, canonicalSourceRoot);
      if (component === path && dedicatedRoot && !created) {
        await assertExistingDedicatedRoot(
          directory,
          component,
          canonicalSourceRoot,
        );
      }
      if (created || (component === path && !dedicatedRoot)) {
        await directory.chmod(0o700);
      }
    } finally {
      await directory.close();
    }
  }
  await validateExistingPathChain(path, canonicalSourceRoot, 'directory');
  return createdDirectories;
}

async function assertExistingDedicatedRoot(
  directory: FileHandle,
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const canonical = await realpath(path);
  if (
    isInside(canonicalSourceRoot, canonical) ||
    isInside(canonical, canonicalSourceRoot)
  ) {
    throw unsafeFilesystemEntry(
      'Local application data must be a dedicated directory that does not overlap the canonical source tree.',
    );
  }

  const details = await directory.stat();
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    details.uid !== currentUid ||
    (details.mode & 0o777) !== 0o700
  ) {
    throw unsafeFilesystemEntry(
      `Existing local application data root must already be owned by the current user with mode 0700: ${path}`,
    );
  }
}

async function publishRootMarker(
  path: string,
  canonicalSourceRoot: string,
): Promise<boolean> {
  let marker: FileHandle | undefined;
  let created = false;
  try {
    marker = await openSafeFile(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
      'Local application root marker',
      canonicalSourceRoot,
    );
    created = true;
    await marker.sync();
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  } finally {
    await marker?.close();
  }
  await validateRootMarker(path, canonicalSourceRoot);
  await syncDirectory(resolve(path, '..'), canonicalSourceRoot);
  return created;
}

async function validateRootMarker(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  await validateExistingPathChain(path, canonicalSourceRoot, 'file');
  const marker = await openSafeFile(
    path,
    constants.O_RDONLY,
    0o600,
    'Local application root marker',
    canonicalSourceRoot,
  );
  try {
    const details = await marker.stat();
    const currentUid = process.getuid?.();
    if (
      currentUid === undefined ||
      details.uid !== currentUid ||
      (details.mode & 0o777) !== 0o600 ||
      details.size !== 0
    ) {
      throw unsafeFilesystemEntry(
        `Local application root marker must be an empty current-user-owned mode-0600 file: ${path}`,
      );
    }
  } finally {
    await marker.close();
  }
}

async function removeMarkerIfPresent(
  path: string | null,
  canonicalSourceRoot: string,
): Promise<void> {
  if (path === null) return;
  try {
    await validateRootMarker(path, canonicalSourceRoot);
    await unlink(path);
    await syncDirectory(resolve(path, '..'), canonicalSourceRoot);
  } catch (error) {
    if (!isMissingFile(error) && !hasMissingFileCause(error)) throw error;
  }
}

async function removeCreatedDirectories(paths: string[]): Promise<void> {
  for (const path of paths.toReversed()) {
    try {
      await rmdir(path);
    } catch (error) {
      if (!isMissingFile(error) && !isDirectoryNotEmpty(error)) throw error;
    }
  }
}

async function ensureApplicationSecret(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const directoryPath = resolve(path, '..');
  const temporaryPath = resolve(
    directoryPath,
    `.${SECRET_FILE_NAME}.tmp-${randomBytes(16).toString('hex')}`,
  );
  let temporary: FileHandle | undefined;
  let failure: unknown;
  try {
    temporary = await openSafeFile(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
      'Temporary application secret',
      canonicalSourceRoot,
    );
    await temporary.writeFile(
      `${randomBytes(32).toString('base64url')}\n`,
      'utf8',
    );
    await temporary.sync();
    await temporary.close();
    temporary = undefined;

    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!isFileAlreadyExists(error)) throw error;
    }

    await validateApplicationSecret(path, canonicalSourceRoot);
    await syncDirectory(directoryPath, canonicalSourceRoot);
  } catch (error) {
    failure = error;
  }
  try {
    await temporary?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!isMissingFile(error)) failure ??= error;
  }
  if (failure !== undefined) throw failure;
  await removeStaleSecretTemps(directoryPath);
}

async function validateApplicationSecret(
  path: string,
  canonicalSourceRoot: string,
): Promise<string> {
  await validateExistingPathChain(path, canonicalSourceRoot, 'file');
  const file = await openSafeFile(
    path,
    constants.O_RDONLY,
    0o600,
    'Application secret',
    canonicalSourceRoot,
  );
  try {
    const details = await file.stat();
    const currentUid = process.getuid?.();
    const secret = await file.readFile('utf8');
    await validateExistingPathChain(path, canonicalSourceRoot, 'file');
    if (
      currentUid === undefined ||
      details.uid !== currentUid ||
      (details.mode & 0o777) !== 0o600 ||
      details.size !== 44 ||
      !/^[A-Za-z0-9_-]{43}\n$/.test(secret)
    ) {
      throw unsafeFilesystemEntry(
        'Application secret must be a complete current-user-owned mode-0600 value in the expected format.',
      );
    }
    return secret;
  } finally {
    await file.close();
  }
}

async function syncDirectory(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const directory = await openSafeDirectory(path, canonicalSourceRoot);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeStaleSecretTemps(directoryPath: string): Promise<void> {
  const prefix = `.${SECRET_FILE_NAME}.tmp-`;
  for (const entry of await readdir(directoryPath)) {
    if (!entry.startsWith(prefix)) continue;
    try {
      await unlink(resolve(directoryPath, entry));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

async function openSafeDirectory(path: string, canonicalSourceRoot: string) {
  let directory: FileHandle | undefined;
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await validateOpenHandlePath(
      directory,
      path,
      'directory',
      canonicalSourceRoot,
    );
    return directory;
  } catch (error) {
    await directory?.close();
    if (error instanceof LocalRuntimeError) throw error;
    throw unsafeFilesystemEntry(
      `Could not safely open local runtime directory: ${path}`,
      error,
    );
  }
}

async function openSafeFile(
  path: string,
  flags: number,
  mode: number,
  label: string,
  canonicalSourceRoot: string,
) {
  let file: FileHandle | undefined;
  try {
    file = await open(path, flags | constants.O_NOFOLLOW, mode);
    await validateOpenHandlePath(file, path, 'file', canonicalSourceRoot);
    return file;
  } catch (error) {
    await file?.close();
    if (error instanceof LocalRuntimeError || isFileAlreadyExists(error)) {
      throw error;
    }
    throw unsafeFilesystemEntry(
      `${label} could not be opened without following symbolic links.`,
      error,
    );
  }
}

async function validateOpenHandlePath(
  handle: FileHandle,
  path: string,
  expectedType: 'directory' | 'file',
  canonicalSourceRoot: string,
): Promise<void> {
  const opened = await handle.stat();
  const current = await lstat(path);
  const expectedDirectory = expectedType === 'directory';
  if (
    current.isSymbolicLink() ||
    (expectedDirectory ? !opened.isDirectory() : !opened.isFile()) ||
    (expectedDirectory ? !current.isDirectory() : !current.isFile()) ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime ${expectedType} changed while it was being opened: ${path}`,
    );
  }
  await validateExistingPathChain(path, canonicalSourceRoot, expectedType);
  const afterValidation = await lstat(path);
  if (
    afterValidation.isSymbolicLink() ||
    opened.dev !== afterValidation.dev ||
    opened.ino !== afterValidation.ino
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime ${expectedType} changed during validation: ${path}`,
    );
  }
}

async function validateExistingPathChain(
  path: string,
  canonicalSourceRoot: string,
  leafType: 'directory' | 'file',
): Promise<void> {
  const components = absolutePathComponents(path);
  for (const [index, component] of components.entries()) {
    const details = await lstat(component);
    const expectedFile = index === components.length - 1 && leafType === 'file';
    if (
      details.isSymbolicLink() ||
      (expectedFile ? !details.isFile() : !details.isDirectory())
    ) {
      throw unsafeFilesystemEntry(
        `Local runtime path contains an unsafe component: ${component}`,
      );
    }
    await assertCanonicalEntry(component, canonicalSourceRoot);
  }
}

async function assertCanonicalEntry(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const canonical = await realpath(path);
  if (!sameFilesystemPath(canonical, path)) {
    throw unsafeFilesystemEntry(
      `Local runtime path must not be redirected: ${path}`,
    );
  }
  if (isInside(canonicalSourceRoot, canonical)) {
    throw unsafeFilesystemEntry(
      'Local application data must remain outside the canonical source tree.',
    );
  }
}

function absolutePathComponents(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  const components = [root];
  for (const part of parts) {
    components.push(resolve(components.at(-1) as string, part));
  }
  return components;
}

function requireNoFollowSupport(): void {
  if (
    typeof constants.O_NOFOLLOW !== 'number' ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_DIRECTORY !== 'number' ||
    constants.O_DIRECTORY === 0
  ) {
    throw unsafeFilesystemEntry(
      'This platform cannot safely initialize local storage without no-follow filesystem support.',
    );
  }
}

function sameFilesystemPath(
  left: string,
  right: string,
  runtimePlatform: NodeJS.Platform = platform(),
): boolean {
  return (
    normalizeFilesystemIdentity(left, runtimePlatform) ===
    normalizeFilesystemIdentity(right, runtimePlatform)
  );
}

function usesCaseInsensitivePathGuards(
  runtimePlatform: NodeJS.Platform,
): boolean {
  return runtimePlatform === 'win32' || runtimePlatform === 'darwin';
}

function normalizeFilesystemIdentity(
  value: string,
  runtimePlatform: NodeJS.Platform = platform(),
): string {
  const normalized = resolve(value);
  return usesCaseInsensitivePathGuards(runtimePlatform)
    ? normalized.toLowerCase()
    : normalized;
}

function unsafeFilesystemEntry(message: string, cause?: unknown) {
  const error = new LocalRuntimeError('invalid_configuration', message);
  if (cause !== undefined)
    Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function validateBootstrapTtl(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_BOOTSTRAP_TTL_SECONDS
  ) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      `Owner bootstrap TTL must be an integer from 1 to ${MAX_BOOTSTRAP_TTL_SECONDS} seconds.`,
    );
  }
  return value;
}

function validateSessionTtl(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      'Session TTL must be a whole number of seconds greater than or equal to 1.',
    );
  }
  return value;
}

function validateOwnerInput(input: ClaimLocalOwnerInput): void {
  if (!input.token || !input.name.trim() || !input.email.trim()) {
    throw new LocalRuntimeError(
      'bootstrap_invalid',
      'Owner bootstrap requires a token, name, and email address.',
    );
  }
}

function normalizeLoopbackHost(value: string): string {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host === '::1') return host;
  const octets = host.split('.');
  if (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  ) {
    return host;
  }
  throw new LocalRuntimeError(
    'unsafe_public_exposure',
    'Owner bootstrap is restricted to a loopback IP literal. Use ::1 or 127.0.0.0/8.',
  );
}

/** Validate an explicit runtime identity. */
export function validateApplicationId(value: string): string {
  const appId = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(appId)) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      'appId must contain only lowercase letters, digits, dots, or hyphens.',
    );
  }
  return appId;
}

/** Encode a package/project identity into a collision-resistant runtime ID. */
export function encodeApplicationId(value: string): string {
  const source = value.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9.-]{0,62}$/.test(source)) return source;
  const digest = createHash('sha256')
    .update(value.trim())
    .digest('hex')
    .slice(0, 10);
  const slug =
    source
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      .slice(0, 52)
      .replace(/[^a-z0-9]+$/g, '') || 'app';
  return validateApplicationId(`${slug}-${digest}`);
}

function defaultApplicationDataRoot(
  runtimePlatform: NodeJS.Platform,
  runtimeHome: string,
  env: NodeJS.ProcessEnv,
): string {
  if (runtimePlatform === 'darwin') {
    return resolve(runtimeHome, 'Library', 'Application Support');
  }
  if (runtimePlatform === 'win32') {
    return resolve(env.LOCALAPPDATA ?? env.APPDATA ?? runtimeHome);
  }
  return resolve(env.XDG_DATA_HOME ?? resolve(runtimeHome, '.local', 'share'));
}

function isInside(
  parent: string,
  child: string,
  runtimePlatform: NodeJS.Platform = platform(),
): boolean {
  const normalizedParent = normalizeFilesystemIdentity(parent, runtimePlatform);
  const normalizedChild = normalizeFilesystemIdentity(child, runtimePlatform);
  const path = relative(normalizedParent, normalizedChild);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function parseStoredDate(value: unknown): Date | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} was not persisted with an id.`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function hasMissingFileCause(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'cause' in error &&
    isMissingFile((error as { cause?: unknown }).cause)
  );
}

function isFileAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOTEMPTY'
  );
}
