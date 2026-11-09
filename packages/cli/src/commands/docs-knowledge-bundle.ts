/**
 * Knowledge-bundle half of `smrt docs:agents` (#4689).
 *
 * Renders the "Find it by intent" section of `.agents/smrt-framework.md` from
 * the OKF intent index and exports the OKF pages for the installed packages
 * into `<output dir>/smrt-knowledge/`. The on-disk contract (layout,
 * `bundle.json`, version stamping) lives in `@happyvertical/smrt-dev-mcp/knowledge`
 * (`okf-bundle.ts`) so the freshness gate reads exactly what this writes.
 *
 * Where the pages come from — never the monorepo checkout in a consumer:
 *  - component page: `<package>/dist/smrt-knowledge.okf.md`, shipped by every
 *    published package; inside the monorepo the committed
 *    `docs/knowledge/components/<name>.md` is the fallback.
 *  - intent pages: `dist/knowledge/intents/` of the installed `smrt-cli` (or
 *    of the running CLI when it is not a project dependency); inside the
 *    monorepo the committed `docs/knowledge/intents/`.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OKF_BUNDLE_DIR_NAME,
  OKF_BUNDLE_FORMAT,
  OKF_BUNDLE_MANIFEST,
  OKF_SHIPPED_COMPONENT_PAGE,
  OKF_SHIPPED_INTENTS_DIR,
  type OkfBundleManifest,
  type OkfBundlePackage,
  readOkfBundleManifest,
  stampPackageVersion,
} from '@happyvertical/smrt-dev-mcp/knowledge';

/** The subset of an installed package the bundle needs. */
export interface BundlePackage {
  name: string;
  version: string;
  /** Every distinct installed version, ascending, when workspace members differ. */
  versions?: string[];
  directory?: string;
  /** Identity the package was discovered under; `name` must equal it when set. */
  specifier?: string;
}

export interface IntentRow {
  /** Display name, e.g. `Background work and retries`. */
  intent: string;
  slug: string;
  /** Unscoped names of the home packages, e.g. `smrt-jobs`. */
  homes: string[];
  entryPoint: string;
  /** The original table row, kept verbatim for the filtered index. */
  raw: string;
}

export interface IntentSource {
  dir: string;
  /** Version of the package that supplied the pages; undefined in the monorepo. */
  version?: string;
}

const ROW =
  /^\| (.+?) \| \[[^\]]+\]\(\/intents\/([a-z0-9-]+)\.md\) \| (.+?) \| (.+?) \| .* \|$/;

/** Strict npm package name: optional lowercase scope, no path segments. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isValidPackageName(name: unknown): name is string {
  return typeof name === 'string' && PACKAGE_NAME.test(name);
}

/**
 * `target` resolved under `root`, or a thrown error when it escapes (`..`,
 * absolute segments). Every bundle write and delete goes through this.
 */
export function containedPath(root: string, target: string): string {
  const base = resolve(root);
  const full = resolve(base, target);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Refusing to write outside ${base}: ${target}`);
  }
  return full;
}

/**
 * Throws when `path` exists as a symlink. `containedPath` is lexical, so a
 * checkout that ships `.agents/smrt-knowledge` as a link would otherwise have
 * the bundle's wholesale directory replacement land wherever the link points.
 */
export function assertNotSymlink(path: string): void {
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    return;
  }
  if (link) throw new Error(`Refusing to write through a symlink: ${path}`);
}

/**
 * Whether a package may supply bundle file names: a plain npm name that equals
 * the identity its directory was discovered under (a mismatching name could
 * claim another package's page or point the target elsewhere).
 */
export function isBundleSafePackage(pkg: BundlePackage): boolean {
  if (
    isValidPackageName(pkg.name) &&
    !(pkg.specifier && pkg.name !== pkg.specifier)
  ) {
    return true;
  }
  console.warn(
    `   ⚠️  Skipping ${JSON.stringify(pkg.name)} in the knowledge bundle: invalid package name or it does not match its directory`,
  );
  return false;
}

export function unscopedName(name: string): string {
  return name.replace(/^@[^/]+\//, '');
}

/** Parses the intent index table; the rows are the only structure relied on. */
export function parseIntentIndex(markdown: string): IntentRow[] {
  const rows: IntentRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = ROW.exec(line);
    if (!match) continue;
    const homes = [...match[3].matchAll(/\(\/components\/([^)]+)\.md\)/g)].map(
      (home) => home[1],
    );
    rows.push({
      intent: match[1],
      slug: match[2],
      homes,
      entryPoint: match[4],
      raw: line,
    });
  }
  return rows;
}

/** Intents with at least one installed home package, in index order. */
export function filterInstalledIntents(
  rows: IntentRow[],
  installed: ReadonlyMap<string, string>,
): IntentRow[] {
  return rows.filter((row) => row.homes.some((home) => installed.has(home)));
}

/** The intent index with rows for intents without an installed home removed. */
export function filterIntentIndexMarkdown(
  markdown: string,
  keptSlugs: ReadonlySet<string>,
): string {
  return markdown
    .split('\n')
    .filter((line) => {
      const match = ROW.exec(line.replace(/\r$/, ''));
      return !match || keptSlugs.has(match[2]);
    })
    .join('\n');
}

/**
 * The leading "Find it by intent" section, or [] when no intent has an
 * installed home. `pagesDir` is the bundle directory relative to the file the
 * section is written into.
 */
export function renderIntentSection(
  rows: IntentRow[],
  installed: ReadonlyMap<string, string>,
  pagesDir = OKF_BUNDLE_DIR_NAME,
): string[] {
  const kept = filterInstalledIntents(rows, installed);
  if (kept.length === 0) return [];
  const lines = [
    '## Find it by intent',
    '',
    `Before hand-rolling infrastructure, check whether an installed SMRT package already provides it. Each page names the entry point and the reason not to roll your own; they live in \`${pagesDir}/\` next to this file, where a concept ID such as \`/intents/background-work.md\` resolves against that directory. Only intents with an installed home package are listed.`,
    '',
    '| Intent | Reach for | Installed package(s) | Page |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of kept) {
    const homes = row.homes
      .filter((home) => installed.has(home))
      .map((home) => `${home}@${installed.get(home)}`)
      .join(', ');
    lines.push(
      `| ${row.intent} | ${row.entryPoint} | ${homes} | [${row.slug}](${pagesDir}/intents/${row.slug}.md) |`,
    );
  }
  lines.push('');
  return lines;
}

function findOwnPackageRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (
          JSON.parse(readFileSync(manifest, 'utf8')).name ===
          '@happyvertical/smrt-cli'
        ) {
          return current;
        }
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageVersion(dir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/** Finds the intent pages; null when none are reachable (the section is then omitted). */
export function resolveIntentSource(options: {
  monorepoRoot: string | null;
  /** Real directory of the installed `smrt-cli`, when the project has it. */
  installedCliDirectory?: string;
}): IntentSource | null {
  const candidates: IntentSource[] = [];
  if (options.monorepoRoot) {
    candidates.push({
      dir: join(options.monorepoRoot, 'docs', 'knowledge', 'intents'),
    });
  }
  for (const root of [options.installedCliDirectory, findOwnPackageRoot()]) {
    if (!root) continue;
    candidates.push({
      dir: join(root, 'dist', OKF_SHIPPED_INTENTS_DIR),
      version: packageVersion(root),
    });
  }
  return (
    candidates.find((candidate) =>
      existsSync(join(candidate.dir, 'index.md')),
    ) ?? null
  );
}

export function loadIntentRows(source: IntentSource): IntentRow[] {
  return parseIntentIndex(readFileSync(join(source.dir, 'index.md'), 'utf8'));
}

function componentPageSource(
  pkg: BundlePackage,
  monorepoRoot: string | null,
): string | null {
  const candidates: string[] = [];
  if (pkg.directory) {
    candidates.push(join(pkg.directory, 'dist', OKF_SHIPPED_COMPONENT_PAGE));
  }
  if (monorepoRoot) {
    candidates.push(
      join(
        monorepoRoot,
        'docs',
        'knowledge',
        'components',
        `${unscopedName(pkg.name)}.md`,
      ),
    );
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

export interface BundleExportResult {
  bundleDir: string;
  components: number;
  intents: number;
  /** Installed packages that ship no knowledge page (older releases, templates). */
  withoutPages: string[];
  exportedAt: string;
}

/**
 * Writes `<bundleDir>/{components,intents}/` and `bundle.json`. The two page
 * directories are replaced wholesale so uninstalled packages and retired
 * intents never linger; nothing else under `bundleDir` is touched. Returns null
 * (writing nothing) when no page is reachable.
 */
export function exportKnowledgeBundle(options: {
  bundleDir: string;
  packages: BundlePackage[];
  monorepoRoot: string | null;
  intentSource: IntentSource | null;
  intentRows: IntentRow[];
  exportedBy: string;
  now?: Date;
}): BundleExportResult | null {
  const safePackages = options.packages.filter(isBundleSafePackage);
  const installed = new Map(
    safePackages.map((pkg) => [unscopedName(pkg.name), pkg.version]),
  );

  const pages = new Map<string, string>();
  const manifestPackages: OkfBundlePackage[] = [];
  const withoutPages: string[] = [];
  for (const pkg of [...safePackages].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const source = componentPageSource(pkg, options.monorepoRoot);
    if (!source) {
      withoutPages.push(pkg.name);
      continue;
    }
    const concept = `/components/${unscopedName(pkg.name)}.md`;
    pages.set(
      concept,
      stampPackageVersion(readFileSync(source, 'utf8'), pkg.version),
    );
    manifestPackages.push({
      name: pkg.name,
      version: pkg.version,
      ...(pkg.versions && pkg.versions.length > 1
        ? { versions: pkg.versions }
        : {}),
      concept,
    });
  }

  const intentSlugs: string[] = [];
  if (options.intentSource) {
    const kept = filterInstalledIntents(options.intentRows, installed);
    const keptSlugs = new Set(kept.map((row) => row.slug));
    const stamp = (text: string) =>
      options.intentSource?.version
        ? stampPackageVersion(text, options.intentSource.version)
        : text;
    for (const row of kept) {
      const path = join(options.intentSource.dir, `${row.slug}.md`);
      if (!existsSync(path)) continue;
      pages.set(`/intents/${row.slug}.md`, stamp(readFileSync(path, 'utf8')));
      intentSlugs.push(row.slug);
    }
    if (intentSlugs.length > 0) {
      pages.set(
        '/intents/index.md',
        stamp(
          filterIntentIndexMarkdown(
            readFileSync(join(options.intentSource.dir, 'index.md'), 'utf8'),
            keptSlugs,
          ),
        ),
      );
    }
  }

  if (pages.size === 0) return null;

  const hash = createHash('sha256');
  for (const concept of [...pages.keys()].sort()) {
    hash.update(`${concept}\0${pages.get(concept)}\0`);
  }
  for (const entry of manifestPackages) {
    if (entry.versions) {
      hash.update(`${entry.name}\0${entry.versions.join(',')}\0`);
    }
  }
  const contentHash = `sha256:${hash.digest('hex')}`;

  let previous: OkfBundleManifest | null = null;
  try {
    previous = readOkfBundleManifest(options.bundleDir);
  } catch {
    // An unreadable manifest is replaced.
  }
  const exportedAt =
    previous?.contentHash === contentHash
      ? previous.exportedAt
      : (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Resolve and contain every destination before anything is deleted or written.
  const writes = [...pages].map(
    ([concept, text]) =>
      [
        containedPath(options.bundleDir, concept.replace(/^\/+/, '')),
        text,
      ] as const,
  );
  const manifestPath = containedPath(options.bundleDir, OKF_BUNDLE_MANIFEST);
  const pageDirs = ['components', 'intents'].map((dir) =>
    containedPath(options.bundleDir, dir),
  );
  for (const path of [resolve(options.bundleDir), ...pageDirs, manifestPath]) {
    assertNotSymlink(path);
  }
  for (const dir of pageDirs) rmSync(dir, { recursive: true, force: true });
  for (const [target, text] of writes) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  const manifest: OkfBundleManifest = {
    format: OKF_BUNDLE_FORMAT,
    exportedBy: options.exportedBy,
    exportedAt,
    contentHash,
    packages: manifestPackages,
    intents: intentSlugs,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    bundleDir: options.bundleDir,
    components: manifestPackages.length,
    intents: intentSlugs.length,
    withoutPages,
    exportedAt,
  };
}

/** Leftover listing helper for tests and diagnostics. */
export function listBundleConcepts(bundleDir: string): string[] {
  const out: string[] = [];
  for (const dir of ['components', 'intents']) {
    const full = join(bundleDir, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort()) out.push(`/${dir}/${name}`);
  }
  return out;
}
