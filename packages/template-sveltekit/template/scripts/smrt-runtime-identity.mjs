import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import {
  encodeApplicationId,
  resolveLocalRuntimePaths,
  validateApplicationId,
} from '@happyvertical/smrt-app-runtime';

/**
 * Resolve one stable identity for CLI, development, and app operations.
 * @param {{sourceRoot?: string, packageName?: string, explicitId?: string}} [options]
 */
export function resolveApplicationId(options = {}) {
  const sourceRoot = options.sourceRoot || process.cwd();
  let packageName = options.packageName;
  if (!packageName) {
    packageName = JSON.parse(
      readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
    ).name;
  }
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    throw new Error('package.json must declare a non-empty package name.');
  }
  return options.explicitId
    ? validateApplicationId(options.explicitId)
    : encodeApplicationId(packageName);
}

/**
 * State is derived from the canonical application/data identity. It is not an
 * independent override because every process and operator command must share
 * one lock domain for a given database root.
 * @param {{appId: string, dataDirectory?: string, sourceRoot?: string}} options
 */
export function resolveApplicationStateRoot(options) {
  const paths = resolveLocalRuntimePaths({
    appId: options.appId,
    dataDirectory: options.dataDirectory,
    sourceRoot: options.sourceRoot,
  });
  return resolve(dirname(paths.root), `.${options.appId}-state`);
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const relative = child.slice(parent.length);
  return (
    child === parent ||
    (child.startsWith(parent) && (relative.startsWith('/') || relative.startsWith('\\')))
  );
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;
}

/**
 * Create or verify the private, app-bound state/lock directory.
 * @param {{appId: string, dataDirectory?: string, sourceRoot?: string}} options
 */
export function prepareApplicationStateRoot(options) {
  const sourceRoot = realpathSync(resolve(options.sourceRoot || process.cwd()));
  const stateRoot = resolveApplicationStateRoot(options);
  if (isInside(sourceRoot, stateRoot) || isInside(stateRoot, sourceRoot)) {
    throw new Error('Application state must remain outside the source tree.');
  }
  const currentUid = process.getuid?.();
  let component = parse(stateRoot).root;
  for (const part of stateRoot.slice(component.length).split(/[\\/]+/).filter(Boolean)) {
    component = join(component, part);
    try {
      const details = lstatSync(component);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`Application state path component is unsafe: ${component}`);
      }
      const sharedStickyRoot = details.uid === 0 && (details.mode & 0o1000) !== 0;
      if (
        currentUid !== undefined &&
        ((details.uid !== currentUid && details.uid !== 0) ||
          ((details.mode & 0o022) !== 0 && !sharedStickyRoot))
      ) {
        throw new Error(`Application state path lacks trusted custody: ${component}`);
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
        throw new Error(`Application state path component is unsafe: ${component}`);
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
    throw new Error('Application state root must be current-user-owned mode 0700.');
  }
  const markerPath = join(stateRoot, `.smrt-state-${validateApplicationId(options.appId)}`);
  let descriptor;
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
