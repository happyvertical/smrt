/**
 * Consumer-facing contract for the exported OKF knowledge bundle (#4689).
 *
 * `smrt docs:agents` writes `<dir of the output file>/smrt-knowledge/` (by
 * default `.agents/smrt-knowledge/`) into a consumer project:
 *
 *   bundle.json                 manifest (below)
 *   components/<unscoped>.md    one OKF component page per installed package
 *                               that ships one, `package_version` re-stamped
 *                               from the installed `package.json`
 *   intents/index.md            the intent index, rows limited to intents with
 *                               an installed home package
 *   intents/<slug>.md           those intents' pages
 *
 * Concept IDs keep the monorepo form (`/components/smrt-jobs.md`), resolved
 * against the bundle directory. A link to the page of an uninstalled package
 * dangles by design.
 *
 * This module owns the shape shared by the writer (`smrt-cli`) and the
 * freshness gate (`check-knowledge-freshness` / `dev:knowledge-check`), so the
 * two cannot drift. It has no side effects beyond reading the filesystem.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { KnowledgeIssue } from './index.js';

export const OKF_BUNDLE_FORMAT = 'smrt-okf-bundle/1';
export const OKF_BUNDLE_DIR_NAME = 'smrt-knowledge';
export const OKF_BUNDLE_MANIFEST = 'bundle.json';
/** Project-relative directories a bundle may live under (`docs:agents`, `docs:claude`). */
export const OKF_BUNDLE_PARENT_DIRS = ['.agents', '.claude'] as const;
/** File a published package ships its component page as, next to `smrt-knowledge.json`. */
export const OKF_SHIPPED_COMPONENT_PAGE = 'smrt-knowledge.okf.md';
/** Directory under a home package's `dist/` that ships the full intent pages. */
export const OKF_SHIPPED_INTENTS_DIR = 'knowledge/intents';
/**
 * Packages that ship the full intent set: `smrt-cli` (the `docs:agents` export
 * source) and this package (the trusted duplicate-detection index, #4690).
 * Mirrored by `INTENT_HOME_PACKAGES` in `scripts/ship-knowledge-pages.mjs`.
 */
export const OKF_INTENT_HOME_PACKAGES = [
  '@happyvertical/smrt-cli',
  '@happyvertical/smrt-dev-mcp',
] as const;
/** Bundles older than this draw a warning even when every version matches. */
export const OKF_BUNDLE_MAX_AGE_DAYS = 90;

export interface OkfBundlePackage {
  /** Full package name, e.g. `@happyvertical/smrt-jobs`. */
  name: string;
  /**
   * Installed version at export time; equals the page's `package_version`. In a
   * pnpm workspace consumer where members install different versions of one
   * package, this is the highest and the exported page is that version's.
   */
  version: string;
  /**
   * Every distinct installed version, ascending. Present only when a workspace
   * has version skew (more than one); absent for the common single-version case.
   */
  versions?: string[];
  /** Concept ID of the exported page, e.g. `/components/smrt-jobs.md`. */
  concept: string;
}

export interface OkfBundleManifest {
  format: typeof OKF_BUNDLE_FORMAT;
  exportedBy: string;
  /**
   * First export of this exact content. Re-running `docs:agents` with nothing
   * changed keeps it, so the committed bundle does not churn.
   */
  exportedAt: string;
  /** `sha256:` over the exported pages and package versions. */
  contentHash: string;
  packages: OkfBundlePackage[];
  /** Exported intent slugs. */
  intents: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Reads a top-level scalar from a page's YAML frontmatter, unquoted. */
export function readFrontmatterScalar(
  page: string,
  key: string,
): string | undefined {
  const match = FRONTMATTER.exec(page);
  if (!match) return undefined;
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1]);
  if (!line) return undefined;
  const raw = line[1].trim();
  return raw.replace(/^(["'])(.*)\1$/, '$2');
}

/**
 * Sets `package_version` in a page's frontmatter, leaving every other field
 * byte-identical. The value is quoted when the page quotes its scalars.
 */
export function stampPackageVersion(page: string, version: string): string {
  const match = FRONTMATTER.exec(page);
  if (!match) return page;
  const front = match[1];
  const existing = /^package_version:[ \t]*(["']?).*$/m.exec(front);
  const quote = existing?.[1] ?? '"';
  const line = `package_version: ${quote}${version}${quote}`;
  const nextFront = existing
    ? front.replace(/^package_version:.*$/m, line)
    : `${front}\n${line}`;
  return page.replace(front, nextFront);
}

export function readOkfBundleManifest(
  bundleDir: string,
): OkfBundleManifest | null {
  const path = join(bundleDir, OKF_BUNDLE_MANIFEST);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as OkfBundleManifest;
  if (
    parsed?.format !== OKF_BUNDLE_FORMAT ||
    !Array.isArray(parsed.packages) ||
    typeof parsed.exportedAt !== 'string'
  ) {
    throw new Error(`unrecognised bundle manifest format in ${path}`);
  }
  return parsed;
}

/**
 * Orders two semver strings (`1.2.3`, `1.2.3-beta.1`): numeric core first, a
 * prerelease sorts below its release, prerelease identifiers compare per semver.
 * Unparseable input falls back to a plain string compare, so the order is total
 * and deterministic.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
      value,
    );
    return match
      ? {
          core: [Number(match[1]), Number(match[2]), Number(match[3])],
          pre: match[4]?.split('.') ?? [],
        }
      : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return right.pre.length - left.pre.length;
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) return Number(l) - Number(r);
    if (lNum !== rNum) return lNum ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** Highest installed version of `name` across `installRoots`, if any. */
function installedVersion(
  installRoots: string[],
  name: string,
): string | undefined {
  let highest: string | undefined;
  for (const rootDir of installRoots) {
    const path = join(rootDir, 'node_modules', name, 'package.json');
    if (!existsSync(path)) continue;
    try {
      const version = JSON.parse(readFileSync(path, 'utf8')).version;
      if (
        typeof version === 'string' &&
        (highest === undefined || compareVersions(version, highest) > 0)
      ) {
        highest = version;
      }
    } catch {
      // An unreadable manifest is not an installed package.
    }
  }
  return highest;
}

/** Installed `@happyvertical/*` packages whose published artifact ships a page. */
function installedPackagesShippingPages(installRoots: string[]): string[] {
  const names = new Set<string>();
  for (const rootDir of installRoots) {
    const scopeDir = join(rootDir, 'node_modules', '@happyvertical');
    if (!existsSync(scopeDir)) continue;
    for (const entry of readdirSync(scopeDir)) {
      if (existsSync(join(scopeDir, entry, 'dist', OKF_SHIPPED_COMPONENT_PAGE)))
        names.add(`@happyvertical/${entry}`);
    }
  }
  return [...names].sort();
}

export interface OkfBundleFreshnessOptions {
  now?: Date;
  maxAgeDays?: number;
  /**
   * Directories whose `node_modules` count as installed. Defaults to `rootDir`;
   * a pnpm workspace consumer passes the root plus every member, matching what
   * `docs:agents` exported.
   */
  installRoots?: string[];
}

/**
 * Reports each exported bundle's age and whether it still matches
 * `node_modules`. Drift is `stale-okf-bundle`, which the caller downgrades to a
 * warning outside strict mode like every other `stale-*` finding; the age is an
 * `info` line, escalating to `okf-bundle-aged` past the age limit. Projects
 * without an exported bundle yield nothing.
 */
export function checkOkfBundleFreshness(
  rootDir: string,
  options: OkfBundleFreshnessOptions = {},
): KnowledgeIssue[] {
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? OKF_BUNDLE_MAX_AGE_DAYS;
  const installRoots = options.installRoots ?? [rootDir];
  const issues: KnowledgeIssue[] = [];

  for (const parent of OKF_BUNDLE_PARENT_DIRS) {
    const bundleDir = join(rootDir, parent, OKF_BUNDLE_DIR_NAME);
    const where = relative(rootDir, bundleDir);
    let manifest: OkfBundleManifest | null;
    try {
      manifest = readOkfBundleManifest(bundleDir);
    } catch (error) {
      issues.push({
        severity: 'warning',
        code: 'okf-bundle-invalid',
        message: `Exported OKF bundle manifest is unreadable (${error instanceof Error ? error.message : String(error)}). Rerun \`smrt docs:agents\`.`,
        file: join(where, OKF_BUNDLE_MANIFEST),
      });
      continue;
    }
    if (!manifest) continue;

    const exportedMs = Date.parse(manifest.exportedAt);
    const ageDays = Number.isNaN(exportedMs)
      ? undefined
      : Math.max(0, Math.floor((now.getTime() - exportedMs) / 86_400_000));
    const summary = `${manifest.packages.length} package page(s), ${manifest.intents.length} intent page(s), exported ${manifest.exportedAt}`;
    if (ageDays === undefined) {
      issues.push({
        severity: 'warning',
        code: 'okf-bundle-invalid',
        message: `Exported OKF bundle has an invalid exportedAt (${manifest.exportedAt}). Rerun \`smrt docs:agents\`.`,
        file: join(where, OKF_BUNDLE_MANIFEST),
      });
    } else if (ageDays > maxAgeDays) {
      issues.push({
        severity: 'warning',
        code: 'okf-bundle-aged',
        message: `Exported OKF bundle is ${ageDays} days old (limit ${maxAgeDays}; ${summary}). Rerun \`smrt docs:agents\`.`,
        file: join(where, OKF_BUNDLE_MANIFEST),
      });
    } else {
      issues.push({
        severity: 'info',
        code: 'okf-bundle-age',
        message: `Exported OKF bundle is ${ageDays} day(s) old (${summary}).`,
        file: join(where, OKF_BUNDLE_MANIFEST),
      });
    }

    const exported = new Set<string>();
    for (const entry of manifest.packages) {
      exported.add(entry.name);
      const pagePath = join(bundleDir, entry.concept.replace(/^\/+/, ''));
      const pageFile = join(where, entry.concept.replace(/^\/+/, ''));
      const stamped = existsSync(pagePath)
        ? readFrontmatterScalar(
            readFileSync(pagePath, 'utf8'),
            'package_version',
          )
        : undefined;
      if (stamped === undefined) {
        issues.push({
          severity: 'error',
          code: 'stale-okf-bundle',
          message: `Exported OKF page for ${entry.name} is missing or has no package_version. Rerun \`smrt docs:agents\`.`,
          file: pageFile,
          packageName: entry.name,
        });
        continue;
      }
      const installed = installedVersion(installRoots, entry.name);
      if (installed === undefined) {
        issues.push({
          severity: 'error',
          code: 'stale-okf-bundle',
          message: `Exported OKF page for ${entry.name} (${stamped}) but the package is no longer installed. Rerun \`smrt docs:agents\`.`,
          file: pageFile,
          packageName: entry.name,
        });
      } else if (installed !== stamped) {
        issues.push({
          severity: 'error',
          code: 'stale-okf-bundle',
          message: `Exported OKF page for ${entry.name} is stamped ${stamped} but ${installed} is installed. Rerun \`smrt docs:agents\`.`,
          file: pageFile,
          packageName: entry.name,
        });
      }
    }

    for (const name of installedPackagesShippingPages(installRoots)) {
      if (exported.has(name)) continue;
      issues.push({
        severity: 'error',
        code: 'stale-okf-bundle',
        message: `${name} is installed and ships a knowledge page the exported OKF bundle does not include. Rerun \`smrt docs:agents\`.`,
        file: join(where, OKF_BUNDLE_MANIFEST),
        packageName: name,
      });
    }
  }

  return issues;
}
