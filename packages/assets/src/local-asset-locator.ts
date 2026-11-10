const PREFIX = 'asset-local:';

/** Identify the portable locator namespace without accepting the key yet. */
export function isLocalAssetLocator(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encode a validated raw key as a persisted local asset locator. */
export function makeLocalAssetLocator(key: string): string {
  validateKey(key);
  return PREFIX + key;
}

/** Decode a portable locator to a validated key relative to the asset root. */
export function localAssetKey(locator: string): string {
  if (!isLocalAssetLocator(locator)) {
    throw new Error('Expected a portable local asset locator');
  }
  const key = locator.slice(PREFIX.length);
  validateKey(key);
  return key;
}

function validateKey(key: string): void {
  for (const segment of key.split('/')) {
    if (
      !/^[A-Za-z0-9_-]/.test(segment) ||
      /[^A-Za-z0-9_.-]/.test(segment) ||
      segment.includes('..') ||
      segment.endsWith('.') ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)
    ) {
      throw new Error('Invalid portable local asset key');
    }
  }
}

// Like the files SDK, Node filesystem APIs are only loaded when storage is
// used. Asset models remain importable from provider-neutral entry points.
export function requireLocalAssetRoot(root: string): string {
  if (typeof process === 'undefined' || !process.getBuiltinModule) {
    throw new Error('Portable local asset storage requires Node.js');
  }
  const { isAbsolute, resolve } = process.getBuiltinModule('node:path');
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new Error(
      'Portable local asset storage requires an absolute basePath',
    );
  }
  return resolve(root);
}

export function keyFromLegacyFileLocator(
  root: string,
  locator: string,
): string {
  const { sep } = process.getBuiltinModule('node:path');
  const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');
  const normalizeSeparators = (path: string) =>
    sep === '\\' ? path.replaceAll('\\', '/') : path;
  const prefix = `file://${normalizeSeparators(root).replace(/\/$/, '')}/`;
  let candidate = normalizeSeparators(locator);
  if (!candidate.startsWith(prefix)) {
    // Logical import uses pathToFileURL, unlike the old AssetStore's raw
    // file:// interpolation. Only accept a canonical round trip: URL parsing
    // must not silently hide traversal, separators, a query or a fragment.
    try {
      const decoded = fileURLToPath(locator);
      if (pathToFileURL(decoded).href === locator) {
        candidate = `file://${normalizeSeparators(decoded)}`;
      }
    } catch {
      // Reject malformed URLs via the same containment check.
    }
  }
  if (!candidate.startsWith(prefix)) {
    throw new Error(
      'Portable local asset locator must stay under the configured root',
    );
  }
  const key = candidate.slice(prefix.length);
  validateKey(key);
  return key;
}

/**
 * Refuse links and non-files beneath the trusted configured root. This
 * inspection assumes the host prevents untrusted concurrent filesystem edits.
 */
export async function checkLocalAssetPath(
  root: string,
  key: string,
): Promise<void> {
  validateKey(key);
  const { lstat } = process.getBuiltinModule('node:fs/promises');
  const { join } = process.getBuiltinModule('node:path');
  const segments = ['', ...key.split('/')];
  let path = root;
  for (const [index, segment] of segments.entries()) {
    if (segment) path = join(path, segment);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) return;
    const leaf = index === segments.length - 1;
    if (leaf ? !stat.isFile() || stat.nlink > 1 : !stat.isDirectory()) {
      throw new Error('Invalid portable local asset path');
    }
  }
}
