import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_PREFIX } from './exclusions.ts';
import type { RawKnowledge, RawManifest, RawPackage } from './extract.ts';

const run = promisify(execFile);

export const DEFAULT_REGISTRY = 'https://npm.happyvertical.com';

interface SearchResponse {
  total: number;
  objects: { package: { name: string } }[];
}

interface Packument {
  'dist-tags': { latest: string };
  versions: Record<
    string,
    {
      description?: string;
      exports?: Record<string, string | { default?: string }>;
      dist: { tarball: string };
    }
  >;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Every `@happyvertical/smrt-*` package name the registry's search lists. The
 * search index lags behind publishes, so it supplies names only; versions and
 * contents come from each package's own packument.
 */
export async function discoverPackageNames(
  registry: string,
): Promise<string[]> {
  const names = new Set<string>();
  const size = 250;
  for (let from = 0; ; from += size) {
    const page = await getJson<SearchResponse>(
      `${registry}/-/v1/search?text=${encodeURIComponent(PACKAGE_PREFIX)}&size=${size}&from=${from}`,
    );
    for (const { package: pkg } of page.objects) {
      if (pkg.name.startsWith(PACKAGE_PREFIX)) names.add(pkg.name);
    }
    if (page.objects.length < size) break;
  }
  return [...names].sort();
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Fetch a package's latest version and read its `./manifest.json` export and
 * the `smrt-knowledge.json` beside it. Returns null for packages that export
 * no manifest (tooling, runtime and UI libraries).
 */
export async function fetchPackage(
  registry: string,
  packageName: string,
): Promise<RawPackage | null> {
  const packument = await getJson<Packument>(
    `${registry}/${packageName.replace('/', '%2f')}`,
  );
  const version = packument['dist-tags'].latest;
  const meta = packument.versions[version];
  const entry = meta.exports?.['./manifest.json'];
  const manifestPath = typeof entry === 'string' ? entry : entry?.default;
  if (!manifestPath) return null;

  const dir = await mkdtemp(join(tmpdir(), 'smrt-catalog-'));
  try {
    // Tarballs are served from the registry's own host regardless of the
    // absolute URL the packument records.
    const tarball = new URL(meta.dist.tarball);
    const response = await fetch(`${registry}${tarball.pathname}`);
    if (!response.ok) {
      throw new Error(`GET ${tarball.pathname} -> ${response.status}`);
    }
    const archive = join(dir, 'package.tgz');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await run('tar', ['-xzf', archive, '-C', dir]);

    const manifestFile = join(dir, 'package', manifestPath);
    const manifest = await readJson<RawManifest>(manifestFile);
    if (!manifest)
      throw new Error(`${packageName}: unreadable ${manifestPath}`);
    const knowledge = await readJson<RawKnowledge>(
      join(dirname(manifestFile), 'smrt-knowledge.json'),
    );
    return {
      packageName,
      version,
      description: meta.description ?? '',
      manifest,
      knowledge,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
