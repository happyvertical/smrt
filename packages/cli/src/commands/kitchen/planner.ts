/**
 * Locating the planner for `smrt kitchen` (#3750).
 *
 * The planner package (`@happyvertical/smrt-planner`) carries a ~70 MB static
 * app, so the CLI does not depend on it. It is found, in order:
 *
 * 1. `--planner <dir>`: a packaged checkout (`pnpm package` in the planner repo).
 * 2. A cached copy under the user cache dir, one directory per version.
 * 3. The registry that owns the `@happyvertical` scope: the newest version is
 *    downloaded and extracted into the cache (no install, no dependencies).
 *
 * If none is available the error says how to fix it.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  downloadPackage,
  extractTarball,
  lookupPackage,
  type RegistryOptions,
} from '../cookbook/registry.js';

export const PLANNER_PACKAGE = '@happyvertical/smrt-planner';

export class PlannerError extends Error {}

/** The parts of the planner's `./core` the kitchen server uses. */
export interface PlannerCore {
  parseHostRequest(
    body: unknown,
  ): { ok: true; request: unknown } | { ok: false; error: string };
  buildHostPrompt(request: unknown): {
    system: string;
    messages: Array<{ role: string; content: string }>;
  };
  parseHostReply(text: string): {
    ok: boolean;
    reply: unknown;
    issues: string[];
  };
}

export interface PlannerInstall {
  /** The package root (holds `package.json`, `dist/`, `app/`). */
  root: string;
  /** Directory of the prebuilt static app. */
  appDir: string;
  /** Absolute path of the `./core` entry (plain Node ESM). */
  coreFile: string;
  version?: string;
  source: 'local' | 'cache' | 'registry';
}

/**
 * Where downloaded planners live: `$SMRT_CACHE_DIR/planner`, else the platform
 * user cache (`$XDG_CACHE_HOME`, `~/Library/Caches`, `%LOCALAPPDATA%`, `~/.cache`)
 * `/smrt/planner`. Each version is a subdirectory.
 */
export function plannerCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SMRT_CACHE_DIR) return join(env.SMRT_CACHE_DIR, 'planner');
  const base =
    env.XDG_CACHE_HOME ||
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : process.platform === 'win32'
        ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
        : join(homedir(), '.cache'));
  return join(base, 'smrt', 'planner');
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return exportTarget(record.default ?? record.import);
  }
  return undefined;
}

/** Validate a package directory as a packaged planner. */
export function inspectPlanner(
  root: string,
  source: PlannerInstall['source'],
): PlannerInstall {
  const dir = resolve(root);
  let pkg: { name?: string; version?: string; exports?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
  } catch {
    throw new PlannerError(
      `${dir} is not a planner package (no readable package.json)`,
    );
  }
  if (pkg.name !== PLANNER_PACKAGE) {
    throw new PlannerError(
      `${dir} is not ${PLANNER_PACKAGE} (package name is ${pkg.name ?? 'missing'})`,
    );
  }
  const exportsMap = pkg.exports as Record<string, unknown> | undefined;
  const core = exportTarget(exportsMap?.['./core']);
  const coreFile = core ? resolve(dir, core) : '';
  const appDir = join(dir, 'app');
  if (
    !core ||
    !existsSync(coreFile) ||
    !existsSync(join(appDir, 'index.html'))
  ) {
    throw new PlannerError(
      `${dir} is not packaged (missing ${!core || !existsSync(coreFile) ? 'dist/core' : 'app/index.html'}); run \`pnpm package\` in the planner checkout`,
    );
  }
  return { root: dir, appDir, coreFile, version: pkg.version, source };
}

const versionParts = (v: string) =>
  v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));

function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l - r;
    return String(l) < String(r) ? -1 : 1;
  }
  return 0;
}

function cachedVersions(cache: string): string[] {
  if (!existsSync(cache)) return [];
  return readdirSync(cache)
    .filter((name) => existsSync(join(cache, name, 'package', 'package.json')))
    .sort(compareVersions);
}

function tryInspect(root: string): PlannerInstall | undefined {
  try {
    return inspectPlanner(root, 'cache');
  } catch {
    return undefined;
  }
}

export interface ResolvePlannerOptions {
  /** `--planner`: a packaged planner directory. */
  planner?: string;
  cacheDir?: string;
  /** Directory whose `.npmrc` chain picks the registry. */
  dir?: string;
  registry?: RegistryOptions;
  log?: (message: string) => void;
}

/** Find the planner: `--planner`, the cache, then the registry. */
export async function resolvePlanner(
  options: ResolvePlannerOptions = {},
): Promise<PlannerInstall> {
  const log = options.log ?? (() => {});
  if (options.planner) return inspectPlanner(options.planner, 'local');

  const cache = options.cacheDir ?? plannerCacheDir();
  const found = await lookupPackage(PLANNER_PACKAGE, {
    dir: options.dir,
    ...options.registry,
  });
  if (found?.version) {
    const target = join(cache, found.version);
    const cached = tryInspect(join(target, 'package'));
    if (cached) return cached;
    log(
      `Downloading the planner ${found.version} (about 70 MB, cached after)…`,
    );
    const tarball = await downloadPackage(found, options.registry?.fetchImpl);
    if (tarball) {
      mkdirSync(cache, { recursive: true });
      const work = mkdtempSync(join(cache, '.download-'));
      try {
        await extractTarball(tarball.data, work);
        rmSync(target, { recursive: true, force: true });
        renameSync(work, target);
        const installed = inspectPlanner(join(target, 'package'), 'registry');
        log(`Planner ${found.version} cached in ${target}`);
        return installed;
      } catch (error) {
        rmSync(work, { recursive: true, force: true });
        throw error instanceof PlannerError
          ? error
          : new PlannerError(
              `Could not unpack ${PLANNER_PACKAGE}@${found.version}: ${error instanceof Error ? error.message : String(error)}`,
            );
      }
    }
  }

  // The registry did not answer: the newest cached copy is still good.
  for (const version of cachedVersions(cache).reverse()) {
    const cached = tryInspect(join(cache, version, 'package'));
    if (cached) {
      log(`Could not reach the registry; using the cached planner ${version}`);
      return cached;
    }
  }
  throw new PlannerError(
    `The planner (${PLANNER_PACKAGE}) is not available: it is not in ${cache} and the registry for the @happyvertical scope did not provide it.\n` +
      'Check your network and .npmrc, or point at a packaged checkout with --planner <dir> (run `pnpm package` in the planner repo).',
  );
}

/** Import the planner's plain-Node `./core`. */
export async function loadPlannerCore(
  install: PlannerInstall,
): Promise<PlannerCore> {
  try {
    return (await import(
      /* @vite-ignore */ pathToFileURL(install.coreFile).href
    )) as PlannerCore;
  } catch (error) {
    throw new PlannerError(
      `Could not load the planner core from ${install.coreFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
