/**
 * Reachability-based import check for the kept bundle (design 4.3, refined).
 *
 * Scanning every JavaScript file of every kept package is too blunt: a kept
 * package such as `@sveltejs/kit` ships build-time files (its Vite plugin)
 * that statically import `vite`, which a runtime bundle removes on purpose.
 * Those files never load in the sidecar. What matters is the code that CAN
 * load, so this module follows the module graph from the sidecar's entry
 * script:
 *
 * - Tier 1 (`static`): files reached through load-time edges only (`import`
 *   and `export ... from`, a top-level `require`). A load-time import of a
 *   removed package from such a file would crash the sidecar at start; it is
 *   a hard failure and cannot be acknowledged.
 * - Tier 2 (`lazy`): files reached through at least one `import()`, a
 *   `require` inside a function, or `*.resolve`. Any import of a removed
 *   package from there, static or not, is reported as a dynamic finding and
 *   needs an entry in `acknowledgedDynamicImports` (recorded verbatim in the
 *   report) so the product owner confirms the lazy path is not on the desktop
 *   path.
 *
 * Specifiers resolve the way Node does, over the kept tree only: relative
 * paths with extension and `index` probing, bare names through the dependency
 * graph (nearest `node_modules` first), package `exports` (with the `node`,
 * `import`/`require`, `module-sync` and `default` conditions and `*`
 * patterns), `main`, and `#imports`. Removed packages are findings, never
 * traversed. A specifier that does not resolve (an optional dependency that
 * is not installed) is counted, not failed. Non-literal `import(x)` stays a
 * residual risk covered by the host smoke start.
 *
 * Like the scan it refines, this is a heuristic over a hand-written lexer,
 * not a parser, and it does no I/O except through the injected `TreeFs`.
 */

import { builtinModules } from 'node:module';
import { posix, win32 } from 'node:path';
import { APP_ROOT, type DependencyGraph } from './graph.js';
import {
  isContained,
  nodeTreeFs,
  readRegularFile,
  type TreeFs,
} from './paths.js';
import { locatePackage } from './prune.js';
import {
  type AcknowledgedImport,
  extractImports,
  type ImportFinding,
  type ImportRef,
  type ImportScanReport,
  isAcknowledged,
  packageNameOf,
} from './scan-imports.js';

export interface ReachOptions {
  /** Absolute root of the copied application build (`.../app/build`). */
  readonly buildRoot: string;
  /** Absolute root of the copied `node_modules`. */
  readonly modulesRoot: string;
  /** Entry script, absolute, inside `buildRoot` or `modulesRoot`. */
  readonly entry: string;
  readonly graph: DependencyGraph;
  /** Packages that were removed (ids not in this set are kept). */
  readonly keep: ReadonlySet<string>;
  readonly acknowledged?: readonly AcknowledgedImport[];
  readonly fs?: TreeFs;
  readonly platform?: NodeJS.Platform;
  /** Per-file cap; larger files are listed as unscanned. Default 8 MiB. */
  readonly maxFileBytes?: number;
  /** Stop after this many files. Default 100 000. */
  readonly maxFiles?: number;
}

export interface ReachReport extends ImportScanReport {
  readonly staticFiles: number;
  readonly lazyFiles: number;
  /** Bare specifiers that resolved to nothing installed (count only). */
  readonly unresolved: number;
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);
const SCRIPT = /\.(?:m?js|cjs)$/i;
const IMPORT_CONDITIONS: ReadonlySet<string> = new Set([
  'node',
  'import',
  'module-sync',
  'default',
]);
const REQUIRE_CONDITIONS: ReadonlySet<string> = new Set([
  'node',
  'require',
  'default',
]);

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve one `exports`/`imports` target for `match` (the `*` capture). */
function resolveTarget(
  target: Json,
  match: string | undefined,
  conditions: ReadonlySet<string>,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined;
  if (typeof target === 'string') {
    return match === undefined ? target : target.replaceAll('*', match);
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveTarget(item, match, conditions, depth + 1);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (isRecord(target)) {
    for (const [key, value] of Object.entries(target)) {
      if (conditions.has(key)) {
        const resolved = resolveTarget(value, match, conditions, depth + 1);
        if (resolved !== undefined) return resolved;
      }
    }
  }
  return undefined;
}

/** Match `subpath` (`.` or `./x`) against an `exports`/`imports` map. */
function matchMap(
  map: Record<string, Json>,
  subpath: string,
  conditions: ReadonlySet<string>,
): string | undefined {
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) {
    return resolveTarget(map[subpath], undefined, conditions);
  }
  let best: { key: string; match: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.length >= key.length - 1 &&
      subpath.endsWith(suffix)
    ) {
      const match = subpath.slice(
        prefix.length,
        subpath.length - suffix.length,
      );
      if (best === undefined || prefix.length > best.key.indexOf('*')) {
        best = { key, match };
      }
    }
  }
  return best === undefined
    ? undefined
    : resolveTarget(map[best.key], best.match, conditions);
}

/** Package-relative target of `subpath` through the manifest's `exports`. */
export function resolvePackageEntry(
  manifest: Record<string, Json>,
  subpath: string,
  conditions: ReadonlySet<string>,
): string | undefined {
  const exportsField = manifest.exports;
  if (exportsField !== undefined && exportsField !== null) {
    let map: Record<string, Json>;
    if (
      isRecord(exportsField) &&
      Object.keys(exportsField).some((key) => key.startsWith('.'))
    ) {
      map = exportsField;
    } else {
      map = { '.': exportsField };
    }
    return matchMap(map, subpath, conditions);
  }
  if (subpath === '.') {
    const main =
      typeof manifest.main === 'string' && manifest.main.length > 0
        ? manifest.main
        : 'index.js';
    return main.startsWith('./') ? main : `./${main}`;
  }
  return subpath;
}

interface Edge {
  readonly ref: ImportRef;
  /** Set when the specifier resolves to a removed package. */
  readonly removed?: string;
  /** Kept files the specifier can resolve to (several for static refs). */
  readonly targets: readonly string[];
}

interface Parsed {
  readonly info: { owner: string; display: string; from: string };
  readonly edges: readonly Edge[];
  readonly nonLiteral: ReturnType<typeof extractImports>['nonLiteral'];
}

/** Follow the module graph from the entry and report removed-package imports. */
export async function scanReachable(
  options: ReachOptions,
): Promise<ReachReport> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  const flavor = platform === 'win32' ? win32 : posix;
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 100_000;
  const acknowledgedList = options.acknowledged ?? [];

  const unscanned: string[] = [];
  let unresolved = 0;

  const manifests = new Map<string, Record<string, Json> | undefined>();
  const manifestOf = async (
    dir: string,
  ): Promise<Record<string, Json> | undefined> => {
    if (manifests.has(dir)) return manifests.get(dir);
    let parsed: Record<string, Json> | undefined;
    try {
      const text = Buffer.from(
        await readRegularFile(
          flavor.join(dir, 'package.json'),
          2 * 1024 * 1024,
          { fs },
        ),
      ).toString('utf8');
      const value = JSON.parse(text) as Json;
      parsed = isRecord(value) ? value : undefined;
    } catch {
      parsed = undefined;
    }
    manifests.set(dir, parsed);
    return parsed;
  };

  const isFile = async (path: string): Promise<boolean> => {
    try {
      return (await fs.lstat(path)).isFile();
    } catch {
      return false;
    }
  };

  /** Probe `base` like Node's file resolution; the first regular script wins. */
  const probe = async (base: string): Promise<string | undefined> => {
    const candidates = SCRIPT.test(base)
      ? [base]
      : [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`];
    candidates.push(
      flavor.join(base, 'index.js'),
      flavor.join(base, 'index.mjs'),
      flavor.join(base, 'index.cjs'),
    );
    for (const candidate of candidates) {
      if (SCRIPT.test(candidate) && (await isFile(candidate))) {
        return candidate;
      }
    }
    return undefined;
  };

  const within = (path: string): boolean =>
    isContained(options.buildRoot, path, platform, true) ||
    isContained(options.modulesRoot, path, platform, true);

  const describeFile = (path: string): Parsed['info'] => {
    if (isContained(options.modulesRoot, path, platform)) {
      const rel = flavor
        .relative(options.modulesRoot, path)
        .split(flavor.sep)
        .join('/');
      const located = locatePackage(rel.split('/'));
      if (located !== undefined) {
        const marker = located.packageDir.split('/');
        const name = marker.slice(marker.lastIndexOf('node_modules') + 1);
        return {
          owner: `node_modules/${located.packageDir}`,
          display: `node_modules/${rel}`,
          from: name.join('/'),
        };
      }
      return { owner: APP_ROOT, display: `node_modules/${rel}`, from: rel };
    }
    const rel = flavor
      .relative(options.buildRoot, path)
      .split(flavor.sep)
      .join('/');
    const display = `app/build/${rel}`;
    return { owner: APP_ROOT, display, from: display };
  };

  const packageDirOf = (id: string): string =>
    flavor.join(options.modulesRoot, ...id.split('/').slice(1));

  /** Resolve a bare specifier from `owner` to a kept file, or `undefined`. */
  const resolveBare = async (
    owner: string,
    specifier: string,
    name: string,
    conditions: ReadonlySet<string>,
  ): Promise<string | undefined> => {
    const id = options.graph.resolve(owner, name);
    if (id === undefined) return undefined;
    const dir = packageDirOf(id);
    const manifest = await manifestOf(dir);
    if (manifest === undefined) return undefined;
    const rest = specifier.slice(name.length);
    const subpath = rest === '' ? '.' : `.${rest}`;
    const target = resolvePackageEntry(manifest, subpath, conditions);
    if (target === undefined || !target.startsWith('./')) return undefined;
    const absolute = flavor.join(dir, ...target.slice(2).split('/'));
    return isContained(dir, absolute, platform) ? probe(absolute) : undefined;
  };

  const parsedCache = new Map<string, Parsed | undefined>();

  const parse = async (path: string): Promise<Parsed | undefined> => {
    if (parsedCache.has(path)) return parsedCache.get(path);
    const info = describeFile(path);
    let text: string;
    try {
      text = Buffer.from(
        await readRegularFile(path, maxFileBytes, { fs }),
      ).toString('utf8');
    } catch {
      unscanned.push(info.display);
      parsedCache.set(path, undefined);
      return undefined;
    }
    const extracted = extractImports(text);
    const edges: Edge[] = [];
    for (const ref of extracted.refs) {
      const specifier = ref.specifier;
      if (
        specifier.startsWith('node:') ||
        BUILTINS.has(specifier) ||
        /^(?:data|https?|file):/i.test(specifier)
      ) {
        continue;
      }
      // Static references may be `import` or a top-level `require`, and the
      // lexer cannot tell which: follow both resolutions.
      const conditionSets: ReadonlySet<string>[] =
        ref.kind === 'static'
          ? [IMPORT_CONDITIONS, REQUIRE_CONDITIONS]
          : ref.kind === 'require'
            ? [REQUIRE_CONDITIONS]
            : [IMPORT_CONDITIONS];

      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const base = flavor.resolve(flavor.dirname(path), specifier);
        const target = within(base) ? await probe(base) : undefined;
        edges.push({
          ref,
          targets: target !== undefined && within(target) ? [target] : [],
        });
        continue;
      }
      if (specifier.startsWith('#')) {
        const targets: string[] = [];
        if (info.owner !== APP_ROOT) {
          const dir = packageDirOf(info.owner);
          const map = (await manifestOf(dir))?.imports;
          if (isRecord(map)) {
            for (const conditions of conditionSets) {
              const target = matchMap(map, specifier, conditions);
              if (target?.startsWith('./')) {
                const absolute = flavor.join(
                  dir,
                  ...target.slice(2).split('/'),
                );
                const file = isContained(dir, absolute, platform)
                  ? await probe(absolute)
                  : undefined;
                if (file !== undefined) targets.push(file);
              }
            }
          }
        }
        edges.push({ ref, targets: [...new Set(targets)] });
        continue;
      }
      const name = packageNameOf(specifier);
      if (name === undefined) continue;
      const id = options.graph.resolve(info.owner, name);
      if (id !== undefined && !options.keep.has(id)) {
        edges.push({ ref, removed: name, targets: [] });
        continue;
      }
      const targets: string[] = [];
      for (const conditions of conditionSets) {
        const target = await resolveBare(
          info.owner,
          specifier,
          name,
          conditions,
        );
        if (target !== undefined && within(target)) targets.push(target);
      }
      if (targets.length === 0) unresolved += 1;
      edges.push({ ref, targets: [...new Set(targets)] });
    }
    const parsed: Parsed = { info, edges, nonLiteral: extracted.nonLiteral };
    parsedCache.set(path, parsed);
    return parsed;
  };

  /** Breadth-first walk; `follow` decides which edges are traversed. */
  const walk = async (
    follow: (edge: Edge) => boolean,
  ): Promise<Map<string, Parsed>> => {
    const reached = new Map<string, Parsed>();
    const queue = [options.entry];
    const queued = new Set(queue);
    for (let index = 0; index < queue.length; index += 1) {
      const path = queue[index] as string;
      if (reached.size >= maxFiles) {
        unscanned.push(describeFile(path).display);
        continue;
      }
      const parsed = await parse(path);
      if (parsed === undefined) continue;
      reached.set(path, parsed);
      for (const edge of parsed.edges) {
        if (!follow(edge)) continue;
        for (const target of edge.targets) {
          if (!queued.has(target)) {
            queued.add(target);
            queue.push(target);
          }
        }
      }
    }
    return reached;
  };

  // Load-time reachability first, then everything that could load.
  const loadTime = await walk((edge) => edge.ref.kind === 'static');
  const everything = await walk(() => true);

  const staticFindings: ImportFinding[] = [];
  const dynamicFindings: ImportFinding[] = [];
  const acknowledgedFindings: ImportFinding[] = [];
  const nonLiteral: ImportScanReport['nonLiteral'][number][] = [];

  for (const [path, parsed] of [...everything].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    for (const unknown of parsed.nonLiteral) {
      nonLiteral.push({
        path: parsed.info.display,
        via: unknown.via,
        line: unknown.line,
      });
    }
    const inLoadSet = loadTime.has(path);
    for (const edge of parsed.edges) {
      if (edge.removed === undefined) continue;
      const finding: ImportFinding = {
        path: parsed.info.display,
        package: edge.removed,
        specifier: edge.ref.specifier,
        kind: inLoadSet && edge.ref.kind === 'static' ? 'static' : 'dynamic',
        line: edge.ref.line,
      };
      if (finding.kind === 'static') staticFindings.push(finding);
      else if (
        isAcknowledged(
          {
            owner: parsed.info.owner,
            path: parsed.info.display,
            from: parsed.info.from,
            text: '',
          },
          finding,
          acknowledgedList,
        )
      ) {
        acknowledgedFindings.push(finding);
      } else dynamicFindings.push(finding);
    }
  }

  return {
    filesScanned: everything.size,
    static: staticFindings,
    dynamic: dynamicFindings,
    acknowledged: acknowledgedFindings,
    nonLiteral,
    unscanned: [...new Set(unscanned)].sort(),
    staticFiles: loadTime.size,
    lazyFiles: everything.size - loadTime.size,
    unresolved,
  };
}
