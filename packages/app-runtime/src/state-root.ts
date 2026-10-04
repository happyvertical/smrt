/**
 * Private, app-bound state root shared by the running web process and the
 * `smrt app` operator commands (`writer.lease`, `operation.lock`, onboarding
 * handoff files).
 *
 * The path is derived from the canonical application/data identity so every
 * process managing one database root shares one lock domain. Moved here from
 * `@happyvertical/smrt-cli/app` (which re-exports it) so the web process does
 * not depend on the CLI package; files, names, and error messages are
 * unchanged from the template's former `scripts/smrt-runtime-identity.mjs`.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { errorCode } from './error-code.js';
import { resolveLocalRuntimePaths, validateApplicationId } from './index.js';

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

function isInside(parent: string, child: string): boolean {
  const relative = child.slice(parent.length);
  return (
    child === parent ||
    (child.startsWith(parent) &&
      (relative.startsWith('/') || relative.startsWith('\\')))
  );
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

/**
 * Hand-off files `smrt app setup` / `recover` leave in the private state root.
 * They hold the loopback `/setup?token=` URL, so they are spent once the owner
 * claim commits.
 */
export const ONBOARDING_HANDOFF_FILES: readonly string[] = Object.freeze([
  'onboarding.json',
  'onboarding-launch.html',
]);

/**
 * Remove the onboarding hand-off files from `stateRoot`. Missing files are
 * fine. Call only after the owner claim transaction has committed.
 */
export function removeOnboardingHandoff(stateRoot: string): void {
  for (const file of ONBOARDING_HANDOFF_FILES) {
    rmSync(join(stateRoot, file), { force: true });
  }
}
