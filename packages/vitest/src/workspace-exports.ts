import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The runtime target an export condition object resolves to for a Node test
 * run: `import`, then `default`, then `svelte` (nested condition objects are
 * followed). `types` and `browser` are never runtime targets here.
 */
function exportRuntimeTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const conditions = value as Record<string, unknown>;
  for (const condition of ['import', 'default', 'svelte']) {
    const target = exportRuntimeTarget(conditions[condition]);
    if (target) return target;
  }
  return null;
}

/**
 * Source file a built export target was compiled from (#2954): `./dist/<p>.js`
 * maps to `src/<p>.ts`, `src/<p>.svelte.ts`, `src/<p>/index.ts`, or, for
 * `svelte-package` layouts, the same under `src/lib/`. Returns `null` for
 * targets outside `dist/` or with no matching source file.
 */
function sourceForExportTarget(
  packageRoot: string,
  target: string,
): string | null {
  const match = /^\.\/dist\/(.+?)\.(?:m?js)$/.exec(target);
  if (!match) return null;
  const built = match[1];
  for (const base of ['src', 'src/lib']) {
    for (const candidate of [
      `${base}/${built}.ts`,
      `${base}/${built}.svelte.ts`,
      `${base}/${built}/index.ts`,
    ]) {
      const path = join(packageRoot, candidate);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/**
 * Every exact (non-pattern) JavaScript subpath a workspace package exports,
 * with the source file it is built from, or `null` when no source file can be
 * derived. Read from the package's own `exports` map, so a newly exported
 * subpath is covered without editing this file (#2954).
 */
export function getWorkspaceExportSources(
  packageRoot: string,
): Array<{ subpath: string; target: string; source: string | null }> {
  let exportsMap: unknown;
  try {
    exportsMap = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf-8'),
    ).exports;
  } catch {
    return [];
  }
  if (!exportsMap || typeof exportsMap !== 'object') return [];
  const entries: Array<{
    subpath: string;
    target: string;
    source: string | null;
  }> = [];
  for (const [subpath, value] of Object.entries(
    exportsMap as Record<string, unknown>,
  )) {
    if (!subpath.startsWith('.') || subpath.includes('*')) continue;
    const target = exportRuntimeTarget(value);
    if (!target || !/\.m?js$/.test(target)) continue;
    entries.push({
      subpath,
      target,
      source: sourceForExportTarget(packageRoot, target),
    });
  }
  return entries;
}

/**
 * The concrete runtime target (`./dist/...`) a workspace package's exports
 * map gives `subpath`, exact or pattern, or `null` when it exports none.
 */
export function workspaceExportTarget(
  packageRoot: string,
  subpath: string,
): string | null {
  let exportsMap: unknown;
  try {
    exportsMap = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf-8'),
    ).exports;
  } catch {
    return null;
  }
  if (!exportsMap || typeof exportsMap !== 'object') return null;
  const entries = exportsMap as Record<string, unknown>;
  if (subpath in entries) return exportRuntimeTarget(entries[subpath]);
  // Node picks the pattern with the longest prefix before `*`.
  const patterns = Object.entries(entries)
    .filter(([pattern]) => pattern.includes('*'))
    .sort(([left], [right]) => right.indexOf('*') - left.indexOf('*'));
  for (const [pattern, value] of patterns) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      !subpath.startsWith(prefix) ||
      !subpath.endsWith(suffix) ||
      subpath.length < prefix.length + suffix.length
    ) {
      continue;
    }
    const target = exportRuntimeTarget(value);
    if (!target?.includes('*')) continue;
    return target
      .split('*')
      .join(subpath.slice(prefix.length, subpath.length - suffix.length));
  }
  return null;
}

/**
 * Source file for the concrete `subpath` a consumer imports from a workspace
 * package — exact or pattern export (`"./utils/*": "./dist/utils/*"`) — for
 * the per-import resolution in {@link smrtVitestPlugin} (#2954). Exact
 * subpaths are normally aliased statically; pattern subpaths can only be
 * mapped per import. A JavaScript target maps like an exact export; another
 * asset (CSS, JSON) maps to the same relative path under `src/` or
 * `src/lib/`. Returns `null` when nothing is exported there or no source
 * file exists.
 */
export function resolveWorkspaceExportSource(
  packageRoot: string,
  subpath: string,
): string | null {
  const concrete = workspaceExportTarget(packageRoot, subpath);
  if (!concrete) return null;
  const jsSource = sourceForExportTarget(packageRoot, concrete);
  if (jsSource) return jsSource;
  const asset = /^\.\/dist\/(.+)$/.exec(concrete);
  if (asset && !/\.m?js$/.test(concrete)) {
    for (const base of ['src', 'src/lib']) {
      const path = join(packageRoot, base, asset[1]);
      if (existsSync(path)) return path;
    }
  }
  return null;
}
