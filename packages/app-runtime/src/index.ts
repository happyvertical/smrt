/**
 * Safe, private, single-owner application runtime for the `local` profile.
 *
 * This Node-only subpath owns the small amount of operational composition that
 * does not belong in a generated application: user-owned paths, restrictive
 * local secret material, SQLite tuning, owner bootstrap, and an optional
 * embedded job runner. Domain schema preparation remains an explicit startup
 * step supplied by the application migration layer.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { parse, resolve, win32 } from 'node:path';
import {
  type ResolvedApplicationRuntime,
  type RuntimeProviderOverrides,
  resolveApplicationRuntime,
} from '@happyvertical/smrt-config';
import { setDatabaseSyncDeviceId } from '@happyvertical/smrt-core';
import { TaskRunner, type TaskRunnerConfig } from '@happyvertical/smrt-jobs';
import { Person, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  ensurePasswordPermissionsRegistered,
  MembershipCollection,
  MembershipStatus,
  PasswordCredentialService,
  type PasswordPolicyOptions,
  RoleCollection,
  SessionCollection,
  SessionService,
  type Tenant,
  TenantCollection,
  TenantService,
  TenantStatus,
  type TenantWithOwnershipResult,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  type CloudLinkChallenge,
  CloudLinkError,
  type CloudLinkExpectations,
  type CloudLinkIdentities,
  deriveCloudLinkKeyPair,
  signCloudLinkProof,
  verifyCloudLinkChallenge,
} from './cloud-link.js';
import {
  type InstallationCustodyReport,
  inspectInstallationCustody,
  stateRootOptions,
} from './installation-custody.js';
import {
  acquireInitializationLock,
  acquireLocalDatabase,
  BOOTSTRAP_TABLE,
  closeDatabaseAfterFailure,
  DATABASE_FILE_NAME,
  defaultApplicationDataRoot,
  installationUnverified,
  isInside,
  preflightLocalApplicationRoot,
  prepareLocalFilesystem,
  preservePrimaryFailure,
  SECRET_FILE_NAME,
  sameFilesystemPath,
  validateApplicationSecret,
  validateLocalStorageCustody,
} from './local-custody.js';
import {
  deriveLocalInstallationIdentity,
  type LocalInstallationIdentity,
} from './local-installation-identity.js';
import {
  createLocalMcpTokenStore,
  ensureLocalMcpTokenTable,
  type LocalMcpTokenStore,
} from './local-mcp-tokens.js';
import { LocalRuntimeError } from './local-runtime-error.js';
import {
  applicationStateRootSource,
  prepareApplicationStateRoot,
} from './state-root.js';
import {
  validateWindowsApplicationId,
  validateWindowsPath,
  WINDOWS_DERIVED_PATH_RESERVE,
} from './windows-paths.js';

export * from './application-identity.js';
export * from './cloud-link.js';
export * from './data-root-swap.js';
export * from './deployed-runtime.js';
export * from './installation-custody.js';
export { withLocalInitializationLock } from './local-custody.js';
export {
  DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS,
  type IssuedLocalMcpToken,
  type IssueLocalMcpTokenInput,
  isLocalMcpTokenPrincipal,
  LOCAL_MCP_TOKEN_PREFIX,
  LOCAL_MCP_TOKEN_PRINCIPAL,
  LOCAL_MCP_TOKEN_TABLE,
  type LocalMcpDesktopCredentialInput,
  type LocalMcpDesktopOwnerSession,
  type LocalMcpTokenPrincipal,
  type LocalMcpTokenRecord,
  type LocalMcpTokenStatus,
  type LocalMcpTokenStore,
  MAX_LOCAL_MCP_TOKEN_TTL_SECONDS,
} from './local-mcp-tokens.js';
export {
  LocalRuntimeError,
  type LocalRuntimeErrorCode,
} from './local-runtime-error.js';
export * from './operation-lock.js';
export * from './provider-readiness.js';
export * from './runtime-diagnostics.js';
export * from './stale-reclaim.js';
export * from './state-root.js';
export * from './vault-lease.js';
export * from './vault-restart.js';
export * from './vault-sync-state.js';
export * from './writer-lease.js';

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_BOOTSTRAP_TTL_SECONDS = 10 * 60;
const MAX_BOOTSTRAP_TTL_SECONDS = 15 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_OWNER_TENANT_SLUG = 'default';
const DEFAULT_OWNER_TENANT_NAME = 'My Workspace';
const OWNER_TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

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
  /**
   * The tenant `claimOwner()` creates or adopts for the owner. Defaults to a
   * new tenant with slug `default`; see {@link LocalOwnerTenantOptions}.
   */
  ownerTenant?: LocalOwnerTenantOptions;
  /** Server-only policy shared with the application password sign-in service. */
  passwordPolicy?: PasswordPolicyOptions;
  /** Testable clock. */
  now?: () => Date;
}

/**
 * Bootstrap tenant selection for `claimOwner()` (#3032).
 *
 * The claim never writes over an existing tenant: when a tenant with `slug`
 * already exists the claim fails closed with `owner_tenant_conflict` unless
 * `adoptExisting` is set, and adoption itself fails closed unless that tenant
 * is an active root tenant with no memberships of any status.
 */
export interface LocalOwnerTenantOptions {
  /**
   * Slug of the owner's tenant: lowercase letters, digits, and inner hyphens,
   * at most 64 characters. Default `default`.
   */
  readonly slug?: string;
  /**
   * Name of a newly created tenant when the claim supplies no `tenantName`.
   * Default `My Workspace`. An adopted tenant keeps its own name.
   */
  readonly name?: string;
  /**
   * Adopt an application-seeded tenant with `slug` instead of failing: the
   * owner gets an owner membership in it and its id (and every row that
   * points at it) is kept. When no tenant has the slug, one is created.
   * Default false.
   */
  readonly adoptExisting?: boolean;
}

interface ResolvedOwnerTenant {
  readonly slug: string;
  readonly name: string;
  readonly adoptExisting: boolean;
}

/**
 * Claim the secure local database root before a standalone migration command
 * opens SQLite. This does not create application schema or bootstrap records.
 */
export async function prepareLocalDatabaseStorage(
  options: ResolveLocalRuntimePathsOptions,
): Promise<LocalRuntimePaths> {
  const paths = resolveLocalRuntimePaths(options);
  const sourceRoot = resolveSourceRoot(options);
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

/**
 * Verify an already-initialized local database root without creating or
 * changing any filesystem/database artifact. Operator read/copy/import paths
 * use this boundary before opening SQLite outside the runtime bootstrap.
 */
export async function validateLocalDatabaseStorage(
  options: ResolveLocalRuntimePathsOptions,
): Promise<LocalRuntimePaths> {
  const paths = resolveLocalRuntimePaths(options);
  const sourceRoot = resolveSourceRoot(options);
  const appId = validateApplicationId(options.appId);
  await validateLocalStorageCustody(paths, sourceRoot, appId);
  return paths;
}

/** Options for {@link openLocalMcpTokenStore}. */
export interface OpenLocalMcpTokenStoreOptions
  extends ResolveLocalRuntimePathsOptions {
  /** Testable clock. */
  now?: () => Date;
}

/** A {@link LocalMcpTokenStore} over its own connection; call `close()`. */
export interface OpenedLocalMcpTokenStore extends LocalMcpTokenStore {
  close(): Promise<void>;
}

/**
 * Open the local MCP token store of an already-initialized application for
 * an operator command (`smrt app token`). It validates the existing storage
 * custody exactly like `validateLocalDatabaseStorage()` and opens SQLite
 * without running migrations or owner bootstrap. It does not take the writer
 * lease: issuing or revoking a token while the web process runs is the
 * expected use, and revocation takes effect on the next request.
 */
export async function openLocalMcpTokenStore(
  options: OpenLocalMcpTokenStoreOptions,
): Promise<OpenedLocalMcpTokenStore> {
  const paths = await validateLocalDatabaseStorage(options);
  const canonicalSourceRoot = await realpath(resolveSourceRoot(options));
  // Uncached: `close()` must never close a connection another caller in
  // this process (for example the web runtime) shares.
  const db = await getDatabase({
    type: 'sqlite',
    url: paths.database,
    cache: false,
    secureFile: {
      driver: 'node:sqlite',
      custody: 'trusted-parent',
      root: paths.root,
    },
  });
  try {
    await tuneLocalSqlite(db);
    await ensureLocalMcpTokenTable(db);
  } catch (error) {
    throw await closeDatabaseAfterFailure(db, error);
  }
  const store = localMcpTokenStore(
    db,
    paths,
    canonicalSourceRoot,
    options.now ?? (() => new Date()),
  );
  return Object.freeze({
    issue: store.issue,
    list: store.list,
    revoke: store.revoke,
    verify: store.verify,
    close: async () => {
      await db.close?.();
    },
  });
}

/** The local half of a cloud link (#4806); holds no secret material. */
export interface LocalCloudLinkIdentity {
  /** The public device ID. */
  readonly installationId: string;
  readonly identities: CloudLinkIdentities;
  /** Raw Ed25519 link public key, base64url. */
  readonly linkPublicKey: string;
  /**
   * Check a challenge against this installation and the operator's
   * expectations (`verifyCloudLinkChallenge()`), then sign it. The seed is
   * re-read for each signature and never retained.
   */
  signProof(
    challenge: unknown,
    expected: LocalCloudLinkExpectations,
  ): Promise<{ challenge: CloudLinkChallenge; signature: string }>;
}

/** Operator expectations for {@link LocalCloudLinkIdentity.signProof}. */
export type LocalCloudLinkExpectations = Omit<
  CloudLinkExpectations,
  'appId' | 'installationId' | 'linkPublicKey'
>;

/** Options for {@link openLocalCloudLinkIdentity}. */
export interface OpenLocalCloudLinkIdentityOptions
  extends ResolveLocalRuntimePathsOptions {
  /**
   * The installation a per-user cloud migration began at this location (#4806).
   * Beginning retires the location before the bundle is exported, yet the
   * per-user link can only be made after that bundle is imported, so a
   * location retired for this exact installation may still sign the per-user
   * link of its own migration, and nothing else: a shared-target challenge is
   * refused. The caller must have checked its migration record
   * (`openMigrationCloudLinkIdentity` in `@happyvertical/smrt-cli/app`).
   */
  retiredInstallationId?: string;
}

/**
 * Open the link identity of an initialized local installation. Refuses unless
 * custody is `in-custody`: an arrived copy, a retired location or a seed
 * mismatch cannot link, except the narrow `retiredInstallationId` case above.
 * Read-only; it never opens the database.
 */
export async function openLocalCloudLinkIdentity(
  options: OpenLocalCloudLinkIdentityOptions,
): Promise<LocalCloudLinkIdentity> {
  const paths = await validateLocalDatabaseStorage(options);
  const canonicalSourceRoot = await realpath(
    resolve(options.sourceRoot ?? process.cwd()),
  );
  const retiredFor = options.retiredInstallationId;
  const unverified = (report: InstallationCustodyReport) => {
    const stateOptions = stateRootOptions(options);
    return installationUnverified(report, {
      stateRoot: prepareApplicationStateRoot(stateOptions),
      source: applicationStateRootSource(stateOptions),
    });
  };
  const custodyUsable = (report: InstallationCustodyReport) =>
    report.status === 'in-custody' ||
    (retiredFor !== undefined &&
      report.status === 'retired' &&
      report.installationId === retiredFor);
  const report = await inspectInstallationCustody(options);
  if (!custodyUsable(report)) throw unverified(report);
  const readIdentity = async () => {
    const secret = await validateApplicationSecret(
      paths.applicationSecret,
      canonicalSourceRoot,
    );
    return {
      identity: deriveLocalInstallationIdentity(secret),
      keys: deriveCloudLinkKeyPair(secret),
    };
  };
  const { identity, keys } = await readIdentity();
  if (identity.deviceId !== report.installationId) {
    throw unverified(report);
  }
  const identities: CloudLinkIdentities = Object.freeze({
    tenantId: identity.tenantId,
    ownerId: identity.ownerId,
    profileId: identity.profileId,
    membershipId: identity.membershipId,
  });
  const linkPublicKey = keys.publicKey;
  return Object.freeze({
    installationId: identity.deviceId,
    identities,
    linkPublicKey,
    async signProof(value: unknown, expected: LocalCloudLinkExpectations) {
      const challenge = verifyCloudLinkChallenge(value, {
        ...expected,
        appId: validateApplicationId(options.appId),
        installationId: identity.deviceId,
        linkPublicKey,
      });
      if (retiredFor !== undefined && challenge.target !== 'per-user') {
        throw new CloudLinkError(
          'challenge_mismatch',
          'A retired location can only sign the per-user link of its own migration.',
        );
      }
      if (
        challenge.target === 'per-user' &&
        (challenge.accountId !== identities.ownerId ||
          challenge.tenantId !== identities.tenantId)
      ) {
        throw new CloudLinkError(
          'challenge_mismatch',
          'A per-user link must be signed in as the imported local owner and tenant.',
        );
      }
      const custody = await inspectInstallationCustody(options);
      if (
        !custodyUsable(custody) ||
        custody.installationId !== identity.deviceId
      ) {
        throw unverified(custody);
      }
      const current = await readIdentity();
      if (current.keys.publicKey !== linkPublicKey) {
        throw new LocalRuntimeError(
          'installation_unverified',
          'The installation seed changed while linking; nothing was signed.',
        );
      }
      return {
        challenge,
        signature: signCloudLinkProof(
          current.keys.privateKey,
          challenge,
          identities,
        ),
      };
    },
  });
}

function localMcpTokenStore(
  db: DatabaseInterface,
  paths: LocalRuntimePaths,
  canonicalSourceRoot: string,
  now: () => Date,
): LocalMcpTokenStore {
  return createLocalMcpTokenStore({
    db,
    now,
    readSecret: () =>
      validateApplicationSecret(paths.applicationSecret, canonicalSourceRoot),
    findOwner: findExistingOwner,
    fail: (code, message) => new LocalRuntimeError(code, message),
  });
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
  /** Optional initial owner password, stored atomically with the owner claim. */
  password?: string;
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

/**
 * Fixed, secret-free surface for a failed application migration.
 *
 * A migration driver message is a likely carrier of a connection string,
 * credential, filesystem path, or environment value, so the caller's text is
 * never surfaced. The original error is retained as a non-enumerable `cause`
 * for private logs only.
 */
export const MIGRATION_FAILED_MESSAGE =
  'The application migration step failed; run pnpm app:setup and inspect the private migration logs.';

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
  if (runtimePlatform === 'win32') {
    return resolveWindowsRuntimePaths(options, appId, runtimeHome, env);
  }
  const defaultRoot = defaultApplicationDataRoot(
    runtimePlatform,
    runtimeHome,
    env,
  );
  const root = resolve(options.dataDirectory ?? resolve(defaultRoot, appId));
  const sourceRoot = resolveSourceRoot(options);

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

/** The absolute source checkout, resolved with the flavour of the platform. */
function resolveSourceRoot(options: ResolveLocalRuntimePathsOptions): string {
  const runtimePlatform = options.platform ?? platform();
  const source = options.sourceRoot ?? process.cwd();
  return runtimePlatform === 'win32' ? win32.resolve(source) : resolve(source);
}

/**
 * The Windows branch of {@link resolveLocalRuntimePaths}: the Windows lexical
 * rule (W1) applies to the root *before* resolution can fold aliases away, the
 * appId must be a plain NTFS name, and the default root is the machine-local
 * `%LOCALAPPDATA%` (never the roaming profile or the home directory).
 */
function resolveWindowsRuntimePaths(
  options: ResolveLocalRuntimePathsOptions,
  appId: string,
  runtimeHome: string,
  env: NodeJS.ProcessEnv,
): LocalRuntimePaths {
  validateWindowsApplicationId(appId);
  const root = validateWindowsPath(
    options.dataDirectory ??
      win32.join(defaultApplicationDataRoot('win32', runtimeHome, env), appId),
    'Local application data directory',
    WINDOWS_DERIVED_PATH_RESERVE,
  );
  const sourceRoot = resolveSourceRoot({ ...options, platform: 'win32' });
  if (
    sameFilesystemPath(root, runtimeHome, 'win32') ||
    sameFilesystemPath(root, win32.parse(root).root, 'win32') ||
    isInside(sourceRoot, root, 'win32') ||
    isInside(root, sourceRoot, 'win32')
  ) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      'Local application data must be a dedicated directory that does not overlap the source tree.',
    );
  }
  return Object.freeze({
    root,
    database: win32.join(root, DATABASE_FILE_NAME),
    assets: win32.join(root, 'assets'),
    secrets: win32.join(root, 'secrets'),
    applicationSecret: win32.join(root, 'secrets', SECRET_FILE_NAME),
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
  const ownerTenant = resolveOwnerTenant(options.ownerTenant);
  const resolvedRuntime = resolveApplicationRuntime({
    profile: 'local',
    providers: options.providers,
  });
  const paths = resolveLocalRuntimePaths(options);
  const sourceRoot = resolveSourceRoot(options);
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
    const identity = await prepareLocalFilesystem(
      paths,
      canonicalSourceRoot,
      db,
      options,
    );
    setDatabaseSyncDeviceId(db, identity.deviceId);
    await tuneLocalSqlite(db);
    try {
      await options.prepareDatabase?.(db);
    } catch (migrationFailure) {
      throw migrationFailed(migrationFailure);
    }
    await ensureBootstrapTable(db);
    await ensureLocalMcpTokenTable(db);

    const runtime = new InitializedLocalApplicationRuntime({
      db,
      paths,
      bindHost,
      resolvedRuntime,
      bootstrapTtlSeconds,
      sessionTtlSeconds,
      backgroundJobs: options.backgroundJobs === true,
      paidCapabilities: options.paidCapabilities === true,
      ownerTenant,
      passwordPolicy: options.passwordPolicy,
      identity,
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
  identity: LocalInstallationIdentity;
  db: DatabaseInterface;
  paths: LocalRuntimePaths;
  bindHost: string;
  resolvedRuntime: ResolvedApplicationRuntime;
  bootstrapTtlSeconds: number;
  sessionTtlSeconds: number;
  backgroundJobs: boolean;
  paidCapabilities: boolean;
  ownerTenant: ResolvedOwnerTenant;
  passwordPolicy?: PasswordPolicyOptions;
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
  /**
   * Owner-minted bearer tokens for local MCP clients. Always present on a
   * runtime returned by {@link initializeLocalApplicationRuntime}; optional
   * only so structural test doubles stay valid. Absent means "no tokens":
   * callers fail closed.
   */
  readonly mcpTokens?: LocalMcpTokenStore;
}

class InitializedLocalApplicationRuntime implements LocalApplicationRuntime {
  readonly db: DatabaseInterface;
  readonly paths: LocalRuntimePaths;
  readonly bindHost: string;
  readonly resolvedRuntime: ResolvedApplicationRuntime;
  readonly backgroundJobsEnabled: boolean;
  readonly paidCapabilitiesEnabled: boolean;
  readonly mcpTokens: LocalMcpTokenStore;
  private readonly bootstrapTtlSeconds: number;
  private readonly sessionTtlSeconds: number;
  private readonly ownerTenant: ResolvedOwnerTenant;
  private readonly passwordPolicy?: PasswordPolicyOptions;
  private readonly now: () => Date;
  private readonly canonicalSourceRoot: string;
  private readonly identity: LocalInstallationIdentity;

  constructor(state: LocalApplicationRuntimeState) {
    this.db = state.db;
    this.paths = state.paths;
    this.bindHost = state.bindHost;
    this.resolvedRuntime = state.resolvedRuntime;
    this.bootstrapTtlSeconds = state.bootstrapTtlSeconds;
    this.sessionTtlSeconds = state.sessionTtlSeconds;
    this.ownerTenant = state.ownerTenant;
    this.passwordPolicy = state.passwordPolicy;
    this.backgroundJobsEnabled = state.backgroundJobs;
    this.paidCapabilitiesEnabled = state.paidCapabilities;
    this.now = state.now;
    this.canonicalSourceRoot = state.canonicalSourceRoot;
    this.identity = state.identity;
    this.mcpTokens = localMcpTokenStore(
      state.db,
      state.paths,
      state.canonicalSourceRoot,
      state.now,
    );
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
    // A token that cannot claim is rejected before seeding, so a wrong,
    // replayed, or expired token stays read-only and never pays for a
    // catalog-wide write (#3323). This is a preflight only: the conditional
    // UPDATE in the claim transaction below remains the single authority.
    if (!(await isBootstrapTokenClaimable(this.db, tokenHash, nowIso))) {
      await throwBootstrapClaimFailure(this.db, now);
    }
    // Generated write routes require `<collection>.<action>` grants (#2977),
    // so the owner role must hold the default role matrix over the manifest
    // permission catalog, not only the role itself. Seeding is idempotent and
    // additive, and commits in its own transaction before the claim
    // transaction.
    if (input.password) ensurePasswordPermissionsRegistered();
    const roles = await RoleCollection.create({ db: this.db });
    await roles.seedSystemRoles({ seedPermissions: true });
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

      return createLocalOwnerRecords(
        tx,
        input,
        this.sessionTtlSeconds,
        this.ownerTenant,
        this.identity,
        this.passwordPolicy,
      );
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
  ownerTenant: ResolvedOwnerTenant,
  identity: LocalInstallationIdentity,
  passwordPolicy?: PasswordPolicyOptions,
): Promise<LocalOwnerClaimResult> {
  // Resolve the tenant before writing anything: `Tenant` upserts on its slug,
  // so creating over an existing slug would replace that row with a new id
  // and orphan every row that points at it (#3032).
  const tenants = await TenantCollection.create({ db });
  const existingTenant = await tenants.findBySlug(ownerTenant.slug);
  const defaultTenant = ownerTenant.slug === DEFAULT_OWNER_TENANT_SLUG;
  const reservedTenant = defaultTenant
    ? await tenants.get(identity.tenantId)
    : null;
  if (reservedTenant && reservedTenant.id !== existingTenant?.id) {
    throw new LocalRuntimeError(
      'owner_tenant_conflict',
      'The reserved local tenant identity is already in use.',
    );
  }
  const users = await UserCollection.create({ db });
  if (
    (await users.get(identity.ownerId)) ||
    (await users.findByEmail(input.email.trim()))
  ) {
    throw new LocalRuntimeError(
      'owner_identity_conflict',
      'The local owner identity is already in use.',
    );
  }
  const memberships = await MembershipCollection.create({ db });
  if (existingTenant) {
    await assertAdoptableOwnerTenant(existingTenant, ownerTenant, memberships);
  }

  const profileTypes = await ProfileTypeCollection.create({ db });
  const personType = await withSystemContext(() =>
    profileTypes.getOrCreateGlobalBySlug('person', {
      name: 'Person',
      description: 'An individual person',
    }),
  );
  const person = new Person({
    db,
    id: identity.profileId,
    _skipLoad: true,
    typeId: requireId(personType.id, 'Person profile type'),
    tenantId: null,
    name: input.name.trim(),
    email: input.email.trim(),
  });
  await person.initialize();
  person.requireInsertOnSave({ preserveDerivedSlug: true });
  await person.save();

  const user = await users.create({
    id: identity.ownerId,
    _insertOnly: true,
    profileId: requireId(person.id, 'Person'),
    email: input.email.trim(),
    status: UserStatus.ACTIVE,
    lastLoginAt: new Date(),
  });
  const userId = requireId(user.id, 'User');

  let ownership: TenantWithOwnershipResult;
  if (existingTenant) {
    const roles = await RoleCollection.create({ db });
    const ownerRole = await roles.findSystemRoleBySlug(
      DEFAULT_ROLE_SLUGS.OWNER,
    );
    ownership = {
      tenant: existingTenant,
      membership: await memberships.create({
        id: identity.membershipId,
        _insertOnly: true,
        userId,
        tenantId: requireId(existingTenant.id, 'Tenant'),
        roleId: requireId(ownerRole?.id, 'Owner role'),
        status: MembershipStatus.ACTIVE,
      }),
    };
  } else {
    const tenantName = input.tenantName?.trim() || ownerTenant.name;
    const service = await TenantService.create(
      { db },
      { mode: 'required', maxTenants: 1, defaultName: tenantName },
    );
    ownership = await service.createTenantWithOwnership(userId, tenantName, {
      slug: ownerTenant.slug,
      reservedIdentity: {
        tenantId: defaultTenant ? identity.tenantId : undefined,
        membershipId: identity.membershipId,
      },
    });
  }
  const { tenant, membership } = ownership;

  // Bind the owner's profile to the actual created or adopted tenant before
  // committing the claim; the shared Person profile type remains global.
  person.tenantId = requireId(tenant.id, 'Tenant');
  await person.save();

  const sessions = await SessionCollection.create({ db });
  const session = await sessions.createSession({
    userId,
    tenantId: requireId(tenant.id, 'Tenant'),
    ttl: sessionTtlSeconds,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
    data: { localOwner: true },
    authMethod: input.password ? 'password' : 'local-bootstrap',
  });

  if (input.password) {
    const passwords = await PasswordCredentialService.create({
      db,
      sessionTtl: sessionTtlSeconds,
      password: passwordPolicy,
    });
    await passwords.setPassword({
      actor: {
        user,
        membership: membership as never,
        permissions: [],
        tenantId: requireId(tenant.id, 'Tenant'),
        sessionId: requireId(session.id, 'Session'),
        authMethod: 'password',
        parent: null,
      },
      userId,
      password: input.password,
    });
  }

  return Object.freeze({
    profileId: requireId(person.id, 'Person'),
    userId,
    tenantId: requireId(tenant.id, 'Tenant'),
    membershipId: requireId(membership.id, 'Membership'),
    sessionId: requireId(session.id, 'Session'),
  });
}

async function assertAdoptableOwnerTenant(
  tenant: Tenant,
  ownerTenant: ResolvedOwnerTenant,
  memberships: MembershipCollection,
): Promise<void> {
  if (!ownerTenant.adoptExisting) {
    throw new LocalRuntimeError(
      'owner_tenant_conflict',
      'A tenant with the owner tenant slug already exists; set ownerTenant.adoptExisting to adopt it or choose another slug.',
    );
  }
  // Only an untouched, application-seeded tenant may be adopted. A child
  // tenant can grant inherited access through its parent, and any membership
  // (active, invited, or suspended) means someone else already has a claim.
  const tenantId = requireId(tenant.id, 'Tenant');
  if (
    tenant.status !== TenantStatus.ACTIVE ||
    tenant.parentTenantId ||
    (await memberships.findByTenant(tenantId)).length > 0
  ) {
    throw new LocalRuntimeError(
      'owner_tenant_conflict',
      'The existing owner tenant cannot be adopted: it must be an active root tenant with no memberships.',
    );
  }
}

function resolveOwnerTenant(
  options: LocalOwnerTenantOptions | undefined,
): ResolvedOwnerTenant {
  const slug = options?.slug ?? DEFAULT_OWNER_TENANT_SLUG;
  if (typeof slug !== 'string' || !OWNER_TENANT_SLUG_PATTERN.test(slug)) {
    throw new LocalRuntimeError(
      'invalid_configuration',
      'ownerTenant.slug must be 1-64 lowercase letters, digits, or inner hyphens.',
    );
  }
  const name =
    typeof options?.name === 'string' && options.name.trim()
      ? options.name.trim()
      : DEFAULT_OWNER_TENANT_NAME;
  return Object.freeze({
    slug,
    name,
    adoptExisting: options?.adoptExisting === true,
  });
}

async function findExistingOwner(
  db: DatabaseInterface,
  requireUnique = false,
): Promise<ExistingOwner | null> {
  const roles = await RoleCollection.create({ db });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  if (!ownerRole?.id) return null;
  const memberships = await MembershipCollection.create({ db });
  const ownerMemberships = await memberships.findByRole(ownerRole.id);
  const activeOwners = ownerMemberships.filter(
    (membership) =>
      membership.status === MembershipStatus.ACTIVE &&
      typeof membership.userId === 'string' &&
      typeof membership.tenantId === 'string',
  );
  const active = activeOwners[0];
  return active && (!requireUnique || activeOwners.length === 1)
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

async function isBootstrapTokenClaimable(
  db: DatabaseInterface,
  tokenHash: string,
  nowIso: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 AS claimable
     FROM ${BOOTSTRAP_TABLE}
     WHERE slot = 1
       AND token_hash = ?
       AND consumed_at IS NULL
       AND expires_at > ?
     LIMIT 1`,
    tokenHash,
    nowIso,
  );
  return result.rows.length > 0;
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

function migrationFailed(cause: unknown): LocalRuntimeError {
  const failure = new LocalRuntimeError(
    'migration_failed',
    MIGRATION_FAILED_MESSAGE,
  );
  Object.defineProperty(failure, 'cause', {
    value: cause,
    configurable: true,
  });
  return failure;
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
