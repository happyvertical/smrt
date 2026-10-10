/**
 * npm registry access shared by the cookbook recipe index (#3748) and
 * `smrt kitchen` (#3750): which registry owns a package's scope (the way npm
 * and pnpm pick it, auth token included), and fetching and extracting a
 * package tarball without installing it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { extract } from 'tar';

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface RegistryOptions {
  /** Force one registry for every package (tests, mirrors). */
  registryUrl?: string;
  /** Directory whose `.npmrc` chain is consulted. */
  dir?: string;
  /** Exact version to try first (the framework line); falls back to latest. */
  versionHint?: string;
  fetchImpl?: FetchLike;
}

interface NpmrcEntries {
  values: Map<string, string>;
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_m, name) => process.env[name] ?? '');
}

/** Parse the `.npmrc` chain: project files up the tree first, then the user's. */
function readNpmrcChain(dir: string): NpmrcEntries {
  const files: string[] = [];
  let current = resolve(dir);
  while (true) {
    files.push(join(current, '.npmrc'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  files.push(join(homedir(), '.npmrc'));
  const values = new Map<string, string>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const match = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !values.has(match[1])) {
        values.set(match[1], expandEnv(match[2]));
      }
    }
  }
  return { values };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * The registry for a package, the way npm and pnpm pick it: the scope's
 * `@scope:registry` (`.npmrc` chain, then `npm config`), then
 * `npm_config_registry`, then an unscoped `registry=`, then npmjs.
 * Also returns an auth token configured for that registry's host.
 */
export function registryForPackage(
  packageName: string,
  dir: string = process.cwd(),
): { url: string; token?: string } {
  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : null;
  const rc = readNpmrcChain(dir);
  let url = scope ? rc.values.get(`${scope}:registry`) : undefined;
  if (scope && !url) {
    try {
      const out = execFileSync('npm', ['config', 'get', `${scope}:registry`], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }).trim();
      if (/^https?:\/\//.test(out)) url = out;
    } catch {
      // npm unavailable: fall through
    }
  }
  url ||=
    process.env.npm_config_registry ||
    rc.values.get('registry') ||
    'https://registry.npmjs.org/';
  url = trimSlash(url);
  const hostPath = url.replace(/^https?:/, '');
  const token =
    rc.values.get(`${hostPath}/:_authToken`) ??
    rc.values.get(`${hostPath.replace(/\/[^/]*$/, '')}/:_authToken`);
  return { url, token: token || undefined };
}

/** A package this CLI may fetch from a registry without installing it. */
export const SMRT_PACKAGE_NAME = /^@happyvertical\/smrt-[a-z0-9][a-z0-9-]*$/;

/** A registry-supplied version is a path segment in the planner cache. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The most a package tarball may weigh (the planner is about 70 MB). */
export const MAX_TARBALL_BYTES = 300 * 1024 * 1024;

export interface PackageLookup {
  /** The version the registry resolved. */
  version?: string;
  /** Registry the package came from. */
  registry: string;
  tarballUrl: string;
  /** Sent with the tarball request: empty unless it is on the registry's origin. */
  headers: Record<string, string>;
  /** The registry's `dist.integrity` (`sha512-<base64>`), checked on download. */
  integrity?: string;
}

export interface PackageTarball {
  version?: string;
  registry: string;
  data: ArrayBuffer;
}

/**
 * Ask the registry that owns a package's scope which version to use, without
 * downloading anything. Tries `versionHint` first (when given), then `latest`.
 * Returns null when the package or version is unavailable.
 */
export async function lookupPackage(
  packageName: string,
  options: RegistryOptions = {},
): Promise<PackageLookup | null> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const resolved = options.registryUrl
    ? { url: trimSlash(options.registryUrl), token: undefined }
    : registryForPackage(packageName, options.dir);
  const base = resolved.url;
  const headers: Record<string, string> = resolved.token
    ? { authorization: `Bearer ${resolved.token}` }
    : {};
  const encoded = packageName.replace('/', '%2F');
  interface RegistryMeta {
    version?: string;
    dist?: { tarball?: string; integrity?: string };
  }
  for (const version of [options.versionHint, 'latest']) {
    if (!version) continue;
    try {
      const response = await fetchImpl(`${base}/${encoded}/${version}`, {
        headers,
      });
      if (!response.ok) continue;
      const meta = (await response.json()) as RegistryMeta;
      const tarballUrl = meta.dist?.tarball;
      if (!tarballUrl) return null;
      if (meta.version !== undefined && !SEMVER.test(meta.version)) return null;
      // The registry names the tarball host. The scope's token goes only to the
      // registry's own origin (as npm does), and a plain-http tarball is
      // refused unless the registry itself is plain http.
      let tarball: URL;
      let registry: URL;
      try {
        tarball = new URL(tarballUrl);
        registry = new URL(base);
      } catch {
        return null;
      }
      const sameOrigin = tarball.origin === registry.origin;
      if (tarball.protocol !== 'https:' && !sameOrigin) return null;
      return {
        version: meta.version,
        registry: base,
        tarballUrl,
        headers: sameOrigin ? headers : {},
        integrity: meta.dist?.integrity,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Download the tarball a {@link lookupPackage} found. Null when unavailable. */
export async function downloadPackage(
  found: PackageLookup,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<PackageTarball | null> {
  try {
    const response = await fetchImpl(found.tarballUrl, {
      headers: found.headers,
    });
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    if (data.byteLength > MAX_TARBALL_BYTES) return null;
    if (found.integrity?.startsWith('sha512-')) {
      const actual = createHash('sha512')
        .update(Buffer.from(data))
        .digest('base64');
      if (`sha512-${actual}` !== found.integrity) return null;
    }
    return { version: found.version, registry: found.registry, data };
  } catch {
    return null;
  }
}

/** Look a package up and download its tarball. Null when unavailable. */
export async function fetchPackageTarball(
  packageName: string,
  options: RegistryOptions = {},
): Promise<PackageTarball | null> {
  const found = await lookupPackage(packageName, options);
  return found ? downloadPackage(found, options.fetchImpl) : null;
}

/**
 * Extract a tarball into `cwd` (entries keep their `package/` prefix). A
 * `filter` limits which entries are written.
 */
export async function extractTarball(
  data: ArrayBuffer,
  cwd: string,
  filter?: (path: string) => boolean,
): Promise<void> {
  await new Promise<void>((done, fail) => {
    const sink = extract({ cwd, ...(filter ? { filter } : {}) });
    sink.on('close', () => done());
    sink.on('error', fail);
    Readable.from(Buffer.from(data)).pipe(sink);
  });
}
