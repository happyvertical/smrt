/**
 * Application identity, private state root, and operator-artifact path
 * custody for the `smrt app` command group.
 *
 * Ported from the template's `scripts/smrt-runtime-identity.mjs` with the
 * same files, names, and error messages so a running application and these
 * commands share one lock domain.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import {
  encodeApplicationId,
  resolveLocalRuntimePaths,
  validateApplicationId,
} from '@happyvertical/smrt-app-runtime';
import { errorCode } from './errors.js';

/** Inputs for {@link resolveApplicationId}. */
export interface ResolveApplicationIdOptions {
  /** Application checkout. Defaults to `process.cwd()`. */
  sourceRoot?: string;
  /** Package name; read from `<sourceRoot>/package.json` when omitted. */
  packageName?: string;
  /** Explicit `SMRT_APP_ID`; validated, never encoded. */
  explicitId?: string;
}

/**
 * Resolve one stable identity for CLI, development, and app operations.
 */
export function resolveApplicationId(
  options: ResolveApplicationIdOptions = {},
): string {
  const sourceRoot = options.sourceRoot || process.cwd();
  let packageName: unknown = options.packageName;
  if (!packageName) {
    packageName = (
      JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')) as {
        name?: unknown;
      }
    ).name;
  }
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    throw new Error('package.json must declare a non-empty package name.');
  }
  return options.explicitId
    ? validateApplicationId(options.explicitId)
    : encodeApplicationId(packageName);
}

/** Inputs for the state-root resolvers. */
export interface ApplicationStateRootOptions {
  appId: string;
  dataDirectory?: string;
  sourceRoot?: string;
  /** Testable platform override. */
  platformName?: NodeJS.Platform | string;
  /** Testable home-directory override. */
  homeDirectory?: string;
  /** Testable environment override. */
  environment?: Record<string, string | undefined>;
}

/**
 * State is derived from the canonical application/data identity. It is not an
 * independent override because every process and operator command must share
 * one lock domain for a given database root.
 */
export function resolveApplicationStateRoot(
  options: ApplicationStateRootOptions,
): string {
  const paths = resolveLocalRuntimePaths({
    appId: options.appId,
    dataDirectory: options.dataDirectory,
    sourceRoot: options.sourceRoot,
  });
  const platformName = options.platformName || platform();
  const homeDirectory = options.homeDirectory || homedir();
  const environment = options.environment || process.env;
  const stateBase =
    platformName === 'darwin'
      ? join(homeDirectory, 'Library', 'Application Support')
      : platformName === 'win32'
        ? environment.LOCALAPPDATA || homeDirectory
        : environment.XDG_STATE_HOME || join(homeDirectory, '.local', 'state');
  const dataIdentity = createHash('sha256')
    .update(resolve(paths.root))
    .digest('hex')
    .slice(0, 12);
  return resolve(stateBase, `.${options.appId}-${dataIdentity}-state`);
}

function databaseTargetIdentity(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    const sslMode = target.searchParams.get('sslmode');
    target.username = '';
    target.password = '';
    target.search = '';
    target.hash = '';
    if (sslMode) target.searchParams.set('sslmode', sslMode);
    return target.toString();
  } catch {
    return resolve(value);
  }
}

/** Runtime selection the fingerprint covers. */
export interface FingerprintRuntime {
  profile: string;
  providers: unknown;
}

/**
 * Secret-safe identity used to reject stale managed processes after profile,
 * provider, database-target, or listener configuration changes.
 */
export function runtimeConfigurationFingerprint(
  runtime: FingerprintRuntime,
  environment: Record<string, string | undefined> = process.env,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        profile: runtime.profile,
        providers: runtime.providers,
        databaseTarget: databaseTargetIdentity(environment.DATABASE_URL),
        host: environment.HOST || null,
        port: environment.PORT || null,
        origin: environment.ORIGIN || null,
        backgroundJobs: environment.SMRT_BACKGROUND_JOBS === 'true',
        readinessModules: {
          authentication: environment.SMRT_AUTH_READINESS_MODULE || null,
          assets: environment.SMRT_ASSETS_READINESS_MODULE || null,
          secrets: environment.SMRT_SECRETS_READINESS_MODULE || null,
        },
        mcpAuthorization: {
          resource: environment.SMRT_MCP_RESOURCE || null,
          issuer: environment.SMRT_MCP_ISSUER || null,
          jwksUri: environment.SMRT_MCP_JWKS_URI || null,
          scopes: environment.SMRT_MCP_SCOPES || null,
        },
      }),
    )
    .digest('hex');
}

function isInside(parent: string, child: string): boolean {
  const relative = child.slice(parent.length);
  return (
    child === parent ||
    (child.startsWith(parent) &&
      (relative.startsWith('/') || relative.startsWith('\\')))
  );
}

/** Inputs for {@link assertExternalArtifactPath}. */
export interface ExternalArtifactPathOptions {
  sourceRoot: string;
  path: string;
  /** Message label, e.g. `Backup destination`. Defaults to `Artifact`. */
  label?: string;
}

/**
 * Resolve an operator-selected artifact through its nearest existing ancestor
 * and reject paths that could place application data in or over the checkout.
 */
export function assertExternalArtifactPath(
  options: ExternalArtifactPathOptions,
): string {
  const canonicalSource = realpathSync(resolve(options.sourceRoot));
  const missingSegments: string[] = [];
  let existingAncestor = resolve(options.path);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalPath = resolve(
    realpathSync(existingAncestor),
    ...missingSegments,
  );
  if (
    isInside(canonicalSource, canonicalPath) ||
    isInside(canonicalPath, canonicalSource)
  ) {
    throw new Error(
      `${options.label || 'Artifact'} must remain outside the source tree.`,
    );
  }
  return canonicalPath;
}

/** Owner check seam; production uses the real process uid. */
export interface StateCustodyOptions {
  /**
   * Testable uid override (e.g. to prove a foreign owner is rejected). It can
   * only substitute a uid; it cannot disable the ownership check.
   */
  currentUid?: number;
}

/**
 * Create or verify the private, app-bound state/lock directory.
 */
export function prepareApplicationStateRoot(
  options: ApplicationStateRootOptions & StateCustodyOptions,
): string {
  const sourceRoot = realpathSync(resolve(options.sourceRoot || process.cwd()));
  const stateRoot = resolveApplicationStateRoot(options);
  if (isInside(sourceRoot, stateRoot) || isInside(stateRoot, sourceRoot)) {
    throw new Error('Application state must remain outside the source tree.');
  }
  const currentUid = options.currentUid ?? process.getuid?.();
  let component = parse(stateRoot).root;
  for (const part of stateRoot
    .slice(component.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    component = join(component, part);
    try {
      const details = lstatSync(component);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(
          `Application state path component is unsafe: ${component}`,
        );
      }
      const sharedStickyRoot =
        details.uid === 0 && (details.mode & 0o1000) !== 0;
      if (
        currentUid !== undefined &&
        ((details.uid !== currentUid && details.uid !== 0) ||
          ((details.mode & 0o022) !== 0 && !sharedStickyRoot))
      ) {
        throw new Error(
          `Application state path lacks trusted custody: ${component}`,
        );
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      try {
        mkdirSync(component, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      const created = lstatSync(component);
      if (
        created.isSymbolicLink() ||
        !created.isDirectory() ||
        (currentUid !== undefined && created.uid !== currentUid) ||
        (created.mode & 0o777) !== 0o700
      ) {
        throw new Error(
          `Application state path component is unsafe: ${component}`,
        );
      }
    }
  }
  const rootDetails = lstatSync(stateRoot);
  if (
    rootDetails.isSymbolicLink() ||
    !rootDetails.isDirectory() ||
    (currentUid !== undefined && rootDetails.uid !== currentUid) ||
    (rootDetails.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      'Application state root must be current-user-owned mode 0700.',
    );
  }
  const markerPath = join(
    stateRoot,
    `.smrt-state-${validateApplicationId(options.appId)}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const marker = lstatSync(markerPath);
    if (
      marker.isSymbolicLink() ||
      !marker.isFile() ||
      marker.size !== 0 ||
      (currentUid !== undefined && marker.uid !== currentUid) ||
      (marker.mode & 0o777) !== 0o600
    ) {
      throw new Error('Application state marker is unsafe.');
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return stateRoot;
}
