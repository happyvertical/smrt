import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';

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
  return String(options.explicitId || packageName || basename(sourceRoot))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {{appId: string, explicitStateDirectory?: string}} options
 */
export function resolveApplicationStateRoot(options) {
  if (options.explicitStateDirectory) {
    return resolve(options.explicitStateDirectory);
  }
  if (platform() === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      options.appId,
      'state',
    );
  }
  if (platform() === 'win32') {
    return join(
      process.env.LOCALAPPDATA || homedir(),
      options.appId,
      'state',
    );
  }
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    options.appId,
  );
}
