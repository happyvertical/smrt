/**
 * Pure logic for the browser reachability gate (#3621, epic #3622).
 *
 * Kept free of Vite/Vitest imports so detection, chain reporting, model
 * package discovery and the ratchet decision are unit-testable without
 * running a bundle.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * Non-built-in modules that must never be reachable from a model package
 * root entry because they only work in Node (servers, native drivers,
 * config/file loaders). `node:` built-ins and their bare aliases (`fs`,
 * `worker_threads`, ...) are always forbidden and are matched separately.
 *
 * Justification per entry:
 *  - pg, pg-pool, pg-native, pg-query-stream: PostgreSQL TCP driver (net/tls).
 *    Browser persistence goes through `@happyvertical/sql/pglite`.
 *  - better-sqlite3, libsql, @libsql/client: native SQLite bindings / Node
 *    client (loads `.node` addons or node:fs).
 *  - duckdb, @duckdb/node-api, @duckdb/node-bindings: native DuckDB bindings.
 *  - express, cors, helmet, fastify, @hono/node-server: HTTP servers; model
 *    roots must not bundle a server bootstrap (#3616).
 *  - cosmiconfig, jiti: filesystem config discovery and TS runtime loader
 *    (#2838).
 *  - sharp, @resvg/resvg-js, @napi-rs/canvas: native image/raster addons.
 *  Any specifier ending in `.node` (a native addon binary) is forbidden too,
 *  which covers per-platform optional dependencies of those packages.
 */
export const FORBIDDEN_NODE_ONLY_MODULES = [
  'pg',
  'pg-pool',
  'pg-native',
  'pg-query-stream',
  'better-sqlite3',
  'libsql',
  '@libsql/client',
  'duckdb',
  '@duckdb/node-api',
  '@duckdb/node-bindings',
  'express',
  'cors',
  'helmet',
  'fastify',
  '@hono/node-server',
  'cosmiconfig',
  'jiti',
  'sharp',
  '@resvg/resvg-js',
  '@napi-rs/canvas',
] as const;

const BUILTINS = new Set(
  builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]),
);

/** Returns the forbidden module name a specifier/id refers to, if any. */
export function matchForbiddenModule(id: string): string | undefined {
  if (id.endsWith('.node')) return id;
  if (id.startsWith('node:')) return id;
  // A trailing slash (`punycode/`, `string_decoder/`) is the conventional
  // spelling for the userland npm package of the same name, not the built-in.
  if (!id.endsWith('/') && !id.startsWith('.') && !path.isAbsolute(id)) {
    // Bare built-in (and subpaths such as `fs/promises`).
    const bare = id.split('/')[0] ?? id;
    if (BUILTINS.has(id) || BUILTINS.has(bare)) return `node:${id}`;
  }
  for (const name of FORBIDDEN_NODE_ONLY_MODULES) {
    if (
      id === name ||
      id.startsWith(`${name}/`) ||
      id.includes(`/node_modules/${name}/`)
    ) {
      return name;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Import-chain reporting
// ---------------------------------------------------------------------------

/** importer id → ids it imports (as Rollup's `importedIds` + dynamic). */
export type ImportGraph = Map<string, readonly string[]>;

/**
 * Shortest import chain from `entry` to `target` (inclusive), or undefined
 * when unreachable. Breadth-first so the report names the most direct edge.
 */
export function findImportChain(
  graph: ImportGraph,
  entry: string,
  target: string,
): string[] | undefined {
  if (entry === target) return [entry];
  const parent = new Map<string, string>([[entry, entry]]);
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i] as string;
    for (const next of graph.get(current) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, current);
      if (next === target) {
        const chain = [next];
        let cursor = current;
        while (cursor !== entry) {
          chain.unshift(cursor);
          cursor = parent.get(cursor) as string;
        }
        chain.unshift(entry);
        return chain;
      }
      queue.push(next);
    }
  }
  return undefined;
}

/** Shortens absolute ids for readable chains (`…/packages/x/dist/y.js`). */
export function shortenId(id: string, workspaceRoot: string): string {
  const rel = id.startsWith(workspaceRoot)
    ? path.relative(workspaceRoot, id)
    : id;
  const nm = rel.lastIndexOf('node_modules/');
  return nm >= 0 ? rel.slice(nm + 'node_modules/'.length) : rel;
}

/** A forbidden module reached from a package root, with absolute-id chain. */
export interface ForbiddenFinding {
  kind: 'forbidden';
  /** The forbidden module, e.g. `node:fs` or `pg`. */
  module: string;
  /** entry → … → importer → forbidden specifier (absolute/bare ids). */
  chain: string[];
}

/** A named export the importee's browser surface does not provide. */
export interface MissingExportFinding {
  kind: 'missing-export';
  name: string;
  /** Absolute id of the module that lacks the export. */
  exporter: string;
  /** Absolute id of the module importing it. */
  importer: string;
}

/** Any other bundler failure (unresolved import, syntax, ...). */
export interface BuildErrorFinding {
  kind: 'build-error';
  message: string;
  file?: string;
}

export type Finding =
  | ForbiddenFinding
  | MissingExportFinding
  | BuildErrorFinding;

export function collectForbiddenFindings(
  graph: ImportGraph,
  entry: string,
  forbiddenIds: Iterable<string>,
): ForbiddenFinding[] {
  const out: ForbiddenFinding[] = [];
  for (const id of forbiddenIds) {
    const chain = findImportChain(graph, entry, id) ?? [entry, id];
    out.push({
      kind: 'forbidden',
      module: matchForbiddenModule(id) ?? id,
      chain,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ownership attribution
// ---------------------------------------------------------------------------

/** A finding plus the gated package responsible for fixing it. */
export interface OwnedFinding {
  finding: Finding;
  /** Package name that owns the fix. */
  owner: string;
}

function edgeKey(f: ForbiddenFinding): string {
  return `${f.module}@${f.chain[f.chain.length - 2] ?? ''}`;
}

/**
 * smrt-core server/transport APIs. A model root that imports one of these is
 * bundling a server bootstrap (#3616); core's browser entry deliberately does
 * not export them, so the bundler reports them as missing exports.
 */
export const SERVER_ONLY_CORE_EXPORTS: ReadonlySet<string> = new Set([
  'startRestServer',
  'createRestServer',
  'createSmrtServer',
  'createMCPServer',
  'SmrtMCPServer',
  'setupSwaggerUI',
]);

function packageOfFile(
  file: string,
  packages: readonly { name: string; dir: string }[],
): string | undefined {
  if (!path.isAbsolute(file)) return undefined;
  return packages.find(
    (p) => file === p.dir || file.startsWith(p.dir + path.sep),
  )?.name;
}

/**
 * Every model package depends on others, so a single defect in smrt-core
 * would otherwise fail all of its dependents and make the expected-failures
 * list a copy of the dependency graph. Attribute each raw finding to the
 * package that owns the fix:
 *
 *  - forbidden module: if the chain passes through another gated package D
 *    whose own root build reports the same edge (same forbidden module from
 *    the same importing module), D owns it and the dependent inherits it. Otherwise (own code, third-party edge, or a
 *    non-root subpath of D that D's root does not reach) the entry package
 *    owns it.
 *  - missing export: the package whose root entry lacks the export owns it.
 *  - anything else: the package being built.
 */
export function attributeFindings(
  packages: readonly ModelPackage[],
  raw: ReadonlyMap<string, readonly Finding[]>,
): Map<string, OwnedFinding[]> {
  const owned = new Map<string, OwnedFinding[]>(
    packages.map((p) => [p.name, []]),
  );
  const rootEntries = new Map(packages.map((p) => [p.entry, p.name]));
  // Edges (forbidden module + the module that imports it) each package's own
  // root build reaches; a dependent inherits an edge only when the very same
  // edge is reported by the dependency.
  const edgesOf = new Map<string, Set<string>>(
    packages.map((p) => [
      p.name,
      new Set(
        (raw.get(p.name) ?? [])
          .filter((f): f is ForbiddenFinding => f.kind === 'forbidden')
          .map(edgeKey),
      ),
    ]),
  );

  for (const pkg of packages) {
    for (const finding of raw.get(pkg.name) ?? []) {
      if (finding.kind === 'forbidden') {
        const inheritedFrom = finding.chain
          .slice(1, -1)
          .map((id) => packageOfFile(id, packages))
          .find(
            (n) => n && n !== pkg.name && edgesOf.get(n)?.has(edgeKey(finding)),
          );
        // The dependency reports it from its own (shorter) chain.
        if (inheritedFrom) continue;
        owned.get(pkg.name)?.push({ finding, owner: pkg.name });
      } else if (finding.kind === 'missing-export') {
        const exporterPkg = rootEntries.get(finding.exporter);
        // A server-only API imported by a model root is the importer's
        // server bootstrap; any other gap is the exporter's browser surface.
        const owner = SERVER_ONLY_CORE_EXPORTS.has(finding.name)
          ? (packageOfFile(finding.importer, packages) ?? pkg.name)
          : exporterPkg && exporterPkg !== pkg.name
            ? exporterPkg
            : pkg.name;
        owned.get(owner)?.push({ finding, owner });
      } else {
        owned.get(pkg.name)?.push({ finding, owner: pkg.name });
      }
    }
  }
  return owned;
}

export function formatOwned(
  owned: readonly OwnedFinding[],
  workspaceRoot: string,
  limit = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  const modules = [
    ...new Set(
      owned.flatMap(({ finding }) =>
        finding.kind === 'forbidden' ? [finding.module] : [],
      ),
    ),
  ];
  if (modules.length) {
    lines.push(
      `    ${modules.length} forbidden modules: ${modules.join(', ')}`,
    );
  }
  const seen = new Set<string>();
  let shown = 0;
  for (const { finding } of owned) {
    if (finding.kind === 'forbidden') {
      if (seen.has(finding.module)) continue;
      seen.add(finding.module);
      if (shown++ >= limit) continue;
      lines.push(
        `    reaches ${finding.module}\n        ${finding.chain
          .map((c) => shortenId(c, workspaceRoot))
          .join('\n         -> ')}`,
      );
    } else if (finding.kind === 'missing-export') {
      const key = `export:${finding.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (shown++ >= limit) continue;
      lines.push(
        `    missing export "${finding.name}" (${shortenId(finding.exporter, workspaceRoot)}), imported by ${shortenId(finding.importer, workspaceRoot)}`,
      );
    } else {
      lines.push(`    build error: ${finding.message}`);
    }
  }
  const hidden = seen.size - Math.min(seen.size, limit);
  if (hidden > 0) lines.push(`    ... and ${hidden} more`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Model package discovery
// ---------------------------------------------------------------------------

/**
 * Publishable packages that look like model packages (declare `@smrt()`
 * business objects) but are deliberately NOT gated, with the reason.
 */
export const MODEL_PACKAGE_EXCLUSIONS: Record<string, string> = {
  '@happyvertical/smrt-cli':
    'command-line tool; its `@smrt(` matches are scaffold template text, and a CLI is Node-only by definition',
};

/** Always gated even when no decorated class is found in source. */
export const ALWAYS_GATED = ['@happyvertical/smrt-core'];

/**
 * Publishable workspace packages that are intentionally not model packages
 * even without decorators (documented so the exclusion list is the full
 * story): app-cli, vitest, smrt-dev-mcp, scanner, config, mcp-* transports,
 * smrt-ui/svelte/web/workbench/playground (UI, no business objects), types,
 * assets-* providers, and the templates are Node/UI tooling, not models.
 */
export interface ModelPackage {
  name: string;
  dir: string;
  /** Absolute path of the resolved root entry for browser conditions. */
  entry: string;
}

const TEST_PATH = /(__tests__|\.spec\.|\.test\.|\/fixtures\/|\/test-utils\/)/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function hasDecoratedSmrtClass(srcDir: string): boolean {
  let exists = false;
  try {
    exists = statSync(srcDir).isDirectory();
  } catch {
    return false;
  }
  if (!exists) return false;
  for (const file of walk(srcDir)) {
    if (!/\.(ts|svelte)$/.test(file) || TEST_PATH.test(file)) continue;
    if (/^[ \t]*@smrt\(/m.test(readFileSync(file, 'utf8'))) return true;
  }
  return false;
}

/** Conditions Vite applies to a client (browser) production build. */
export const BROWSER_CONDITIONS = [
  'browser',
  'module',
  'import',
  'production',
  'svelte',
  'default',
];

/** Resolves a package.json `exports['.']` target for the given conditions. */
export function resolveExportTarget(
  target: unknown,
  conditions: readonly string[] = BROWSER_CONDITIONS,
): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const r = resolveExportTarget(item, conditions);
      if (r) return r;
    }
    return undefined;
  }
  if (target && typeof target === 'object') {
    // Object key order is the priority order (Node/Vite semantics).
    for (const [key, value] of Object.entries(target)) {
      if (key === 'types') continue;
      if (conditions.includes(key)) {
        const r = resolveExportTarget(value, conditions);
        if (r) return r;
      }
    }
  }
  return undefined;
}

export function discoverModelPackages(workspaceRoot: string): ModelPackage[] {
  const packagesDir = path.join(workspaceRoot, 'packages');
  const found: ModelPackage[] = [];
  for (const entry of readdirSync(packagesDir).sort()) {
    const dir = path.join(packagesDir, entry);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    const name = manifest.name as string;
    if (manifest.private) continue;
    if (name in MODEL_PACKAGE_EXCLUSIONS) continue;
    if (
      !ALWAYS_GATED.includes(name) &&
      !hasDecoratedSmrtClass(path.join(dir, 'src'))
    ) {
      continue;
    }
    const exportsField = manifest.exports as
      | Record<string, unknown>
      | undefined;
    const rootTarget =
      exportsField && '.' in exportsField
        ? resolveExportTarget(exportsField['.'])
        : ((manifest.module ?? manifest.main) as string | undefined);
    if (!rootTarget) {
      throw new Error(`${name}: no resolvable root entry in package.json`);
    }
    found.push({ name, dir, entry: path.resolve(dir, rootTarget) });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Ratchet
// ---------------------------------------------------------------------------

export interface ExpectedFailure {
  /** Tracking issue; the fix PR for it removes this entry. */
  issue: string;
  /** One-line description of the known breakage. */
  reason: string;
}

export interface RatchetResult {
  /** Failing packages not on the expected list. */
  unexpected: string[];
  /** Listed packages that now pass (stale entries to delete). */
  stale: string[];
  /** Expected-list keys that are not model packages at all. */
  unknown: string[];
  ok: boolean;
}

export function evaluateRatchet(
  failing: ReadonlySet<string>,
  gated: readonly string[],
  expected: Readonly<Record<string, ExpectedFailure>>,
): RatchetResult {
  const gatedSet = new Set(gated);
  const unexpected = [...failing].filter((p) => !(p in expected)).sort();
  const stale = Object.keys(expected)
    .filter((p) => gatedSet.has(p) && !failing.has(p))
    .sort();
  const unknown = Object.keys(expected)
    .filter((p) => !gatedSet.has(p))
    .sort();
  return {
    unexpected,
    stale,
    unknown,
    ok: !unexpected.length && !stale.length && !unknown.length,
  };
}
