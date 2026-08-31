/**
 * Safe, private, single-owner application runtime for the `local` profile.
 *
 * This Node-only subpath owns the small amount of operational composition that
 * does not belong in a generated application: user-owned paths, restrictive
 * local secret material, SQLite tuning, owner bootstrap, and an optional
 * embedded job runner. Domain schema preparation remains an explicit startup
 * step supplied by the application migration layer.
 */

import { createHmac, randomBytes } from 'node:crypto';
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
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

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_BOOTSTRAP_TTL_SECONDS = 10 * 60;
const MAX_BOOTSTRAP_TTL_SECONDS = 15 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const BOOTSTRAP_TABLE = '_smrt_local_owner_bootstrap';
const SECRET_FILE_NAME = 'application.secret';
const DATABASE_FILE_NAME = 'application.sqlite';

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
  /** Testable platform override. */
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
  /** Normal authenticated session lifetime. */
  sessionTtlSeconds?: number;
  /** Explicit opt-in for persisted background work. Default false. */
  backgroundJobs?: boolean;
  /** Explicit opt-in for application-defined paid capabilities. Default false. */
  paidCapabilities?: boolean;
  /** Testable clock. */
  now?: () => Date;
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
  const appId = normalizeAppId(options.appId);
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

  if (isInside(sourceRoot, root)) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      'Local application data must be stored outside the source tree.',
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
  const resolvedRuntime = resolveApplicationRuntime({
    profile: 'local',
    providers: options.providers,
  });
  const paths = resolveLocalRuntimePaths(options);
  const sourceRoot = resolve(options.sourceRoot ?? process.cwd());
  const canonicalSourceRoot = await prepareLocalFilesystem(paths, sourceRoot);
  const db = await getDatabase({
    type: 'sqlite',
    url: paths.database,
    secureFile: {
      driver: 'node:sqlite',
      custody: 'trusted-parent',
      root: paths.root,
    },
  });
  await tuneLocalSqlite(db);
  await options.prepareDatabase?.(db);
  await ensureBootstrapTable(db);

  const runtime = new LocalApplicationRuntime({
    db,
    paths,
    bindHost,
    resolvedRuntime,
    bootstrapTtlSeconds,
    sessionTtlSeconds: options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
    backgroundJobs: options.backgroundJobs === true,
    paidCapabilities: options.paidCapabilities === true,
    now: options.now ?? (() => new Date()),
    canonicalSourceRoot,
  });
  const bootstrap = await runtime.ensureBootstrapInvitation();
  return {
    runtime,
    bootstrap,
    diagnostics: await runtime.diagnostics(),
  };
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
export class LocalApplicationRuntime {
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
    const invitation = await this.issueBootstrapInvitation(true);
    if (!invitation) {
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
       WHERE ? = 1
          OR ${BOOTSTRAP_TABLE}.consumed_at IS NOT NULL
          OR ${BOOTSTRAP_TABLE}.expires_at <= ?
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
    const secret = await readSafeFile(
      this.paths.applicationSecret,
      this.canonicalSourceRoot,
      'Application secret',
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

async function prepareLocalFilesystem(
  paths: LocalRuntimePaths,
  sourceRoot: string,
): Promise<string> {
  requireNoFollowSupport();
  const canonicalSourceRoot = await realpath(sourceRoot);
  await ensureSafeDirectoryTree(paths.root, canonicalSourceRoot);
  await ensureSafeDirectoryTree(paths.assets, canonicalSourceRoot);
  await ensureSafeDirectoryTree(paths.secrets, canonicalSourceRoot);

  const database = await openSafeFile(
    paths.database,
    constants.O_RDWR | constants.O_CREAT,
    0o600,
    'SQLite database',
    canonicalSourceRoot,
  );
  await database.chmod(0o600);
  await database.close();
  await validateExistingPathChain(paths.database, canonicalSourceRoot, 'file');

  await ensureApplicationSecret(paths.applicationSecret, canonicalSourceRoot);
  return canonicalSourceRoot;
}

async function ensureSafeDirectoryTree(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const components = absolutePathComponents(path);
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
      } catch (mkdirError) {
        // A concurrent initializer may have created the component. It is still
        // opened and validated without following links below.
        if (!isFileAlreadyExists(mkdirError)) throw mkdirError;
      }
    }

    const directory = await openSafeDirectory(component, canonicalSourceRoot);
    try {
      if (created || component === path) await directory.chmod(0o700);
      await assertCanonicalEntry(component, canonicalSourceRoot);
    } finally {
      await directory.close();
    }
  }
  await validateExistingPathChain(path, canonicalSourceRoot, 'directory');
}

async function ensureApplicationSecret(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  let secret: FileHandle;
  try {
    secret = await openSafeFile(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
      'Application secret',
      canonicalSourceRoot,
    );
    await secret.writeFile(
      `${randomBytes(32).toString('base64url')}\n`,
      'utf8',
    );
    await secret.sync();
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
    secret = await openSafeFile(
      path,
      constants.O_RDONLY,
      0o600,
      'Application secret',
      canonicalSourceRoot,
    );
  }
  try {
    await secret.chmod(0o600);
  } finally {
    await secret.close();
  }
  await validateExistingPathChain(path, canonicalSourceRoot, 'file');
}

async function readSafeFile(
  path: string,
  canonicalSourceRoot: string,
  label: string,
): Promise<string> {
  await validateExistingPathChain(path, canonicalSourceRoot, 'file');
  const file = await openSafeFile(
    path,
    constants.O_RDONLY,
    0o600,
    label,
    canonicalSourceRoot,
  );
  try {
    const contents = await file.readFile('utf8');
    await validateExistingPathChain(path, canonicalSourceRoot, 'file');
    return contents;
  } finally {
    await file.close();
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

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform() === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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
  if (host === 'localhost' || host === '::1') return host;
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
    'Owner bootstrap is restricted to a loopback bind. Use localhost, ::1, or 127.0.0.0/8.',
  );
}

function normalizeAppId(value: string): string {
  const appId = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(appId)) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      'appId must contain only lowercase letters, digits, dots, or hyphens.',
    );
  }
  return appId;
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

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
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

function isFileAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}
