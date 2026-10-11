/**
 * @happyvertical/smrt-svelte/cookbook/server
 *
 * Node-only loading for a cookbook app's `+layout.server.ts` (#3749): read and
 * validate `smrt.cookbook.json`, read the installed packages' manifests and
 * return the plain-JSON data `CookbookApp` takes. Also re-exports the pure,
 * Svelte-free builder so a server can derive the shell without a DOM.
 */
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Cookbook } from '@happyvertical/smrt-types';
import {
  type CookbookManifest,
  catalogFromManifests,
  narrowCatalog,
} from './catalog.js';
import type { CookbookCatalog } from './types.js';

export { buildCookbookShell } from './build.js';
export {
  type CookbookManifest,
  catalogFromManifests,
  narrowCatalog,
  packageIdOf,
} from './catalog.js';
export { resolveCookbookTheme } from './theme.js';
export type * from './types.js';

export const COOKBOOK_FILE = 'smrt.cookbook.json';

/** The result of validating a cookbook document (`validateCookbook` in smrt-core). */
export type CookbookValidation =
  | { ok: true; cookbook: Cookbook; warnings?: string[] }
  | { ok: false; errors: string[] };

export type CookbookValidator = (
  document: unknown,
  options?: { recipes?: Iterable<string> },
) => CookbookValidation;

/** What `+layout.server.ts` returns and `CookbookApp` takes. Plain JSON. */
export interface CookbookAppData {
  cookbook: Cookbook;
  /** Only the recipes and models the cookbook uses. */
  catalog: CookbookCatalog;
  /** The validator's warnings. */
  warnings: string[];
}

export interface LoadCookbookAppOptions {
  /** Project root; default `process.cwd()`. */
  root?: string;
  /** Cookbook file relative to `root`; default {@link COOKBOOK_FILE}. */
  file?: string;
  /**
   * Packages whose `manifest.json` to read. Default: every dependency of the
   * project's `package.json` that exports `./manifest.json`.
   */
  packages?: readonly string[];
  /**
   * The validator. Default: `validateCookbook` from
   * `@happyvertical/smrt-core/cookbook`, which the app depends on.
   */
  validate?: CookbookValidator;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function defaultValidator(): Promise<CookbookValidator> {
  try {
    const mod = (await import(
      /* @vite-ignore */ '@happyvertical/smrt-core/cookbook'
    )) as { validateCookbook: CookbookValidator };
    return mod.validateCookbook;
  } catch (error) {
    throw new Error(
      'loadCookbookApp needs @happyvertical/smrt-core (it validates the ' +
        'cookbook); install it or pass `validate`. ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** Dependencies of the project that publish a manifest. */
async function manifestPackages(root: string): Promise<string[]> {
  const pkg = (await readJson(join(root, 'package.json'))) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
}

/**
 * Read a package's `manifest.json` through its `./manifest.json` (or
 * `./manifest`) export; `null` when the package has none or is not installed.
 */
export async function readInstalledManifest(
  root: string,
  packageName: string,
): Promise<CookbookManifest | null> {
  const require = createRequire(join(resolve(root), 'package.json'));
  for (const subpath of ['manifest.json', 'manifest']) {
    try {
      const path = require.resolve(`${packageName}/${subpath}`);
      const manifest = (await readJson(path)) as Partial<CookbookManifest>;
      if (manifest && typeof manifest === 'object' && manifest.packageName) {
        return manifest as CookbookManifest;
      }
    } catch {
      // Not exported or not installed: try the next subpath.
    }
  }
  return null;
}

/** Read the manifests of `packages`, skipping those that have none. */
export async function readInstalledManifests(
  root: string,
  packages?: readonly string[],
): Promise<CookbookManifest[]> {
  const names = packages ?? (await manifestPackages(root));
  const found = await Promise.all(
    names.map((name) => readInstalledManifest(root, name)),
  );
  return found.filter((m): m is CookbookManifest => m !== null);
}

/**
 * Load and validate the project's cookbook and resolve it against the
 * installed packages' recipes. Throws when the cookbook is missing or invalid
 * (the message lists every problem), including a recipe no installed package
 * declares.
 */
export async function loadCookbookApp(
  options: LoadCookbookAppOptions = {},
): Promise<CookbookAppData> {
  const root = resolve(options.root ?? process.cwd());
  const file = options.file ?? COOKBOOK_FILE;
  const validate = options.validate ?? (await defaultValidator());
  let document: unknown;
  try {
    document = await readJson(join(root, file));
  } catch (error) {
    throw new Error(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifests = await readInstalledManifests(root, options.packages);
  const full = catalogFromManifests(manifests);
  const result = validate(document, {
    recipes: full.recipes.map((r) => r.id),
  });
  if (!result.ok) {
    throw new Error(
      `${file} is not a valid cookbook:\n- ${result.errors.join('\n- ')}`,
    );
  }
  const { cookbook } = result;
  const warnings = [...(result.warnings ?? [])];
  return {
    cookbook,
    catalog: narrowCatalog(full, {
      recipes: cookbook.recipes,
      features: cookbook.features ?? [],
    }),
    warnings,
  };
}

/** Whether `root` has a cookbook file (for apps that fall back to a plain shell). */
export async function hasCookbook(
  root: string = process.cwd(),
  file: string = COOKBOOK_FILE,
): Promise<boolean> {
  try {
    await access(join(resolve(root), file));
    return true;
  } catch {
    return false;
  }
}
