import { asciiLower } from '../internal/grammar.js';
import type {
  ContentInspector,
  FilterDecision,
  FilterEntry,
  TreeEntry,
} from './paths.js';
import { BundleTreeError } from './tree-errors.js';

/**
 * File-level pruning of kept packages and the secret deny-list.
 *
 * The functions here are pure filters for `walkTree`/`copyTree`: a pruned
 * entry is never copied (`skip`), a secret hit rejects the whole tree
 * (`secret_file`, thrown from the filter) because a secret in a bundle is a
 * build problem to fix, not noise to drop silently. Paths seen by the
 * filters are relative to the tree root with forward slashes. For
 * `node_modules` the root is the `node_modules` directory itself.
 *
 * Pruning (design 4.4) is conservative by construction:
 * - Directory rules (`docs`, `test`, `tests`, `example(s)`) apply only at a
 *   package root, `__tests__` and `.github` anywhere, and never to a
 *   directory that the package's `main`/`module`/`exports`/`bin` points into.
 * - Documentation is dropped but `LICENSE*`, `LICENCE*`, `NOTICE*` and
 *   `COPYING*` always stay (compliance), as does `package.json`.
 * - Foreign `prebuilds/<os>-<arch>[-libc]/` and `napi-vN/<os>/<arch>/`
 *   directories are dropped against an explicit target; native verification
 *   is a separate, later stage.
 */

// ---------------------------------------------------------------------------
// Target and package context
// ---------------------------------------------------------------------------

/** Minimal structural target; the triple table lives in `targets.ts`. */
export interface PruneTarget {
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly arch: 'x64' | 'arm64';
  /** Linux only. Absent means "do not prune by libc". */
  readonly libc?: 'glibc' | 'musl';
}

/** Entry points per package directory (relative to the `node_modules` root). */
export type PackageEntryPaths = ReadonlyMap<string, readonly string[]>;

// ---------------------------------------------------------------------------
// Secret deny-list
// ---------------------------------------------------------------------------

const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  '.env',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmrc',
  '.netrc',
  '.htpasswd',
  '.git-credentials',
  '.git',
  '.svn',
  '.hg',
  '.smrt',
  '.ssh',
  '.aws',
  '.gnupg',
]);

/** Names that only count as secrets when they are files (a directory called `credentials` is code). */
const SECRET_FILE_ONLY_NAMES: ReadonlySet<string> = new Set([
  'credentials',
  'credentials.json',
]);

const SECRET_NAME_PREFIXES: readonly string[] = [
  '.env.',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
];

const SECRET_EXTENSIONS: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.kdbx',
  '.sqlite',
  '.sqlite3',
  '.sqlite-wal',
  '.sqlite-shm',
  '.db',
  '.db-wal',
  '.db-shm',
];

/**
 * True when `name` (a single path segment, any kind) is on the secret
 * deny-list: environment files, package-manager credentials, private keys
 * and certificates, version-control directories, `.smrt` data directories
 * and SQLite/database files.
 */
export function isSecretName(
  name: string,
  kind: 'file' | 'dir' | 'symlink' | 'special' = 'file',
): boolean {
  const lower = asciiLower(name);
  if (SECRET_FILE_NAMES.has(lower)) return true;
  if (kind !== 'dir' && SECRET_FILE_ONLY_NAMES.has(lower)) return true;
  if (SECRET_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  return SECRET_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface SecretFilterOptions {
  /**
   * Exact tree-relative paths that may be present although their name is on
   * the deny-list (for example a reviewed public CA bundle). Recorded by the
   * caller; never a pattern.
   */
  readonly allow?: ReadonlySet<string>;
}

/**
 * Filter that throws `secret_file` (with the offending relative path as the
 * subject) for any deny-listed name, whatever its kind.
 */
export function createSecretFilter(
  options: SecretFilterOptions = {},
): (entry: FilterEntry) => FilterDecision {
  return (entry) => {
    if (
      isSecretName(entry.name, entry.kind) &&
      options.allow?.has(entry.rel) !== true
    ) {
      throw new BundleTreeError('secret_file', { subjects: [entry.rel] });
    }
    return 'keep';
  };
}

// ---------------------------------------------------------------------------
// Secret content scan
// ---------------------------------------------------------------------------

export interface SecretPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * High-confidence patterns only (design 6, T9). Each is anchored on a fixed
 * prefix and a minimum length so that ordinary code does not match. Add a
 * pattern only with a negative test.
 */
export const SECRET_CONTENT_PATTERNS: readonly SecretPattern[] = Object.freeze([
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { id: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'slack-token', pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}/ },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-project-key', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  // Legacy OpenAI keys: `sk-` then 32+ unbroken alphanumerics. A hyphen after
  // `sk-ant` (Anthropic) or any later hyphen ends the run, and `\b` rejects
  // words such as `task-` or `risk-`.
  { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'stripe-live-key', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
]);

/** Longest suffix kept between chunks so a token split across chunks matches. */
const SCAN_TAIL_CHARS = 256;

/** Scan state for one file. Reports pattern ids only, never matched text. */
export class SecretScanner {
  private tail = '';
  private readonly found = new Set<string>();

  push(chunk: Uint8Array): void {
    const text =
      this.tail +
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(
        'latin1',
      );
    for (const { id, pattern } of SECRET_CONTENT_PATTERNS) {
      if (pattern.test(text)) this.found.add(id);
    }
    this.tail = text.slice(-SCAN_TAIL_CHARS);
  }

  /** Pattern ids seen so far, sorted. */
  ids(): string[] {
    return [...this.found].sort();
  }
}

/** Scan a complete buffer; returns the sorted pattern ids that matched. */
export function scanSecretContent(content: Uint8Array): string[] {
  const scanner = new SecretScanner();
  scanner.push(content);
  return scanner.ids();
}

export type SecretContentPolicy = 'fail' | 'warn';

export interface ContentFinding {
  readonly rel: string;
  readonly patterns: readonly string[];
}

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.node',
  '.wasm',
  '.dylib',
  '.so',
  '.dll',
  '.exe',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.ogg',
  '.gz',
  '.br',
  '.zip',
  '.pdf',
  '.onnx',
  '.bin',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : asciiLower(name.slice(dot));
}

export interface ContentScanOptions {
  /**
   * `fail` (default, design O5): a hit throws `secret_content` once the file
   * has been read, which aborts the bundle before anything is published.
   * `warn`: hits are collected in `findings` and the bundle continues.
   */
  readonly policy?: SecretContentPolicy;
  /** Largest file scanned; bigger files are skipped. Default 16 MiB. */
  readonly maxScanBytes?: number;
  /** Extra gate on top of the built-in binary-extension skip. */
  readonly include?: (entry: TreeEntry) => boolean;
}

export interface ContentScan {
  /** Pass to `copyTree({ inspect })`. */
  readonly inspect: (entry: TreeEntry) => ContentInspector | undefined;
  /** Hits so far; with policy `warn` this is the whole result. */
  readonly findings: readonly ContentFinding[];
}

/** Build the content-scan hook for `copyTree`. */
export function createContentScan(
  options: ContentScanOptions = {},
): ContentScan {
  const policy = options.policy ?? 'fail';
  const maxScanBytes = options.maxScanBytes ?? 16 * 1024 * 1024;
  const findings: ContentFinding[] = [];
  return {
    findings,
    inspect(entry) {
      const name = entry.rel.slice(entry.rel.lastIndexOf('/') + 1);
      if (
        entry.size > maxScanBytes ||
        BINARY_EXTENSIONS.has(extensionOf(name)) ||
        options.include?.(entry) === false
      ) {
        return undefined;
      }
      const scanner = new SecretScanner();
      return {
        push: (chunk) => scanner.push(chunk),
        finish() {
          const patterns = scanner.ids();
          if (patterns.length === 0) return;
          if (policy === 'fail') {
            throw new BundleTreeError('secret_content', {
              subjects: [entry.rel],
            });
          }
          findings.push({ rel: entry.rel, patterns });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pruning rules
// ---------------------------------------------------------------------------

export type PruneRule =
  | 'removed-package'
  | 'source-map'
  | 'types'
  | 'typescript-source'
  | 'docs'
  | 'tests'
  | 'ci'
  | 'static-library'
  | 'tooling-config'
  | 'foreign-native'
  | 'os-junk';

const LICENSE_NAME = /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i;
const DOC_BASENAME =
  /^(?:readme|changelog|changes|history|contributing)(?:\.(?:md|markdown|txt|rst))?$/i;
const TOOLING_CONFIG =
  /^(?:\.npmignore|\.gitignore|\.gitattributes|\.editorconfig|\.travis\.yml|\.eslintrc(?:\..+)?|\.prettierrc(?:\..+)?|tsconfig(?:\..+)?\.json|.+\.tsbuildinfo)$/i;
const STATIC_LIBRARY = /\.(?:a|lib|o|obj|pdb|exp|ilk)$/i;

const PACKAGE_ROOT_TEST_DIRS: ReadonlySet<string> = new Set(['test', 'tests']);
const PACKAGE_ROOT_DOC_DIRS: ReadonlySet<string> = new Set([
  'docs',
  'doc',
  'example',
  'examples',
]);

const PLATFORMS = new Set([
  'darwin',
  'linux',
  'win32',
  'android',
  'freebsd',
  'openbsd',
  'netbsd',
  'sunos',
  'aix',
]);
const ARCHES = new Set([
  'x64',
  'arm64',
  'arm',
  'ia32',
  'ppc64',
  's390x',
  'mips',
  'mipsel',
  'riscv64',
  'loong64',
]);
const PREBUILD_DIR =
  /^([a-z0-9]+)-([a-z0-9]+(?:\+[a-z0-9]+)*)(?:-(musl|glibc))?$/;

function prebuildMatches(
  name: string,
  target: PruneTarget,
): boolean | undefined {
  const match = PREBUILD_DIR.exec(name);
  if (match === null) return undefined;
  const [, platform, arches, libc] = match;
  if (
    platform === undefined ||
    arches === undefined ||
    !PLATFORMS.has(platform) ||
    !arches.split('+').every((arch) => ARCHES.has(arch))
  ) {
    return undefined;
  }
  if (platform !== target.platform) return false;
  if (!arches.split('+').includes(target.arch)) return false;
  if (libc !== undefined && target.libc !== undefined && libc !== target.libc) {
    return false;
  }
  return true;
}

/** True when `dir` is a `prebuilds/` or `napi-vN/` subdirectory for another target. */
function isForeignNativeDir(
  inner: readonly string[],
  target: PruneTarget,
): boolean {
  const name = inner[inner.length - 1];
  const parent = inner[inner.length - 2];
  const grand = inner[inner.length - 3];
  if (name === undefined) return false;
  if (parent === 'prebuilds') return prebuildMatches(name, target) === false;
  if (parent !== undefined && /^napi-v\d+$/.test(parent)) {
    return PLATFORMS.has(name) && name !== target.platform;
  }
  if (
    grand !== undefined &&
    /^napi-v\d+$/.test(grand) &&
    parent !== undefined
  ) {
    return (
      parent === target.platform && ARCHES.has(name) && name !== target.arch
    );
  }
  return false;
}

function normalizeEntry(path: string): string {
  let value = path.replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  const star = value.indexOf('*');
  if (star !== -1) value = value.slice(0, value.lastIndexOf('/', star) + 1);
  return value.replace(/\/+$/, '');
}

/**
 * Collect the file or directory paths a `package.json` points at:
 * `main`, `module`, `browser` (string form), `bin` (string or map) and every
 * string inside `exports`. Paths are package-relative, `./` stripped and
 * truncated before any `*`.
 */
export function collectEntryPaths(manifest: unknown): string[] {
  const out = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null) return;
    if (typeof value === 'string') {
      const normalized = normalizeEntry(value);
      if (normalized.length > 0 && !normalized.startsWith('..')) {
        out.add(normalized);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  if (manifest !== null && typeof manifest === 'object') {
    const record = manifest as Record<string, unknown>;
    visit(record.main, 0);
    visit(record.module, 0);
    if (typeof record.browser === 'string') visit(record.browser, 0);
    visit(record.bin, 0);
    visit(record.exports, 0);
  }
  return [...out].sort();
}

interface PackageLocation {
  /** Package directory relative to the `node_modules` root. */
  readonly packageDir: string;
  /** Path segments inside the package. Empty for the package root itself. */
  readonly inner: readonly string[];
}

/** Split a `node_modules`-relative path at its innermost package. */
export function locatePackage(
  segments: readonly string[],
): PackageLocation | undefined {
  const marker = segments.lastIndexOf('node_modules');
  const start = marker + 1;
  const first = segments[start];
  if (first === undefined) return undefined;
  const length = first.startsWith('@') ? 2 : 1;
  if (segments.length < start + length) return undefined;
  return {
    packageDir: segments.slice(0, start + length).join('/'),
    inner: segments.slice(start + length),
  };
}

export interface PruneOptions {
  /** Keep `*.map` files (`--keep-sourcemaps`). */
  readonly keepSourceMaps?: boolean;
  /** Needed for the foreign-native rule. */
  readonly target?: PruneTarget;
  /** Entry points per package dir, to protect referenced directories. */
  readonly entryPaths?: PackageEntryPaths;
  /** Package directories (relative to the `node_modules` root) to drop. */
  readonly removedDirs?: ReadonlySet<string>;
  readonly secrets?: SecretFilterOptions;
}

export interface PruneFilter {
  readonly filter: (entry: FilterEntry) => FilterDecision;
  /** Entries skipped so far, per rule. */
  summary(): Readonly<Record<string, number>>;
}

function referenced(
  entryPaths: readonly string[] | undefined,
  inner: readonly string[],
): boolean {
  if (entryPaths === undefined) return false;
  const path = inner.join('/');
  return entryPaths.some(
    (entry) => entry === path || entry.startsWith(`${path}/`),
  );
}

/** Classify one `node_modules`-relative entry; `undefined` means keep. */
export function classifyPrune(
  entry: FilterEntry,
  options: PruneOptions = {},
): PruneRule | undefined {
  const segments = entry.rel.split('/');
  if (entry.kind === 'dir' && options.removedDirs?.has(entry.rel) === true) {
    return 'removed-package';
  }
  const located = locatePackage(segments);
  if (located === undefined || located.inner.length === 0) return undefined;
  const { inner, packageDir } = located;
  const name = entry.name;
  const lower = asciiLower(name);

  if (entry.kind === 'dir') {
    if (lower.endsWith('.dsym')) return 'static-library';
    if (
      options.target !== undefined &&
      isForeignNativeDir(inner, options.target)
    ) {
      return 'foreign-native';
    }
    const entries = options.entryPaths?.get(packageDir);
    if (referenced(entries, inner)) return undefined;
    if (lower === '__tests__') return 'tests';
    if (lower === '.github') return 'ci';
    if (inner.length === 1) {
      if (PACKAGE_ROOT_TEST_DIRS.has(lower)) return 'tests';
      if (PACKAGE_ROOT_DOC_DIRS.has(lower)) return 'docs';
    }
    return undefined;
  }

  if (entry.kind !== 'file') return undefined;
  if (inner.length === 1 && lower === 'package.json') return undefined;
  if (LICENSE_NAME.test(name)) return undefined;
  if (lower === '.ds_store') return 'os-junk';
  if (lower.endsWith('.map')) {
    return options.keepSourceMaps === true ? undefined : 'source-map';
  }
  if (/\.d\.[cm]?ts$/.test(lower)) return 'types';
  if (/\.[cm]?ts$/.test(lower)) return 'typescript-source';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'docs';
  if (DOC_BASENAME.test(name)) return 'docs';
  if (STATIC_LIBRARY.test(lower)) return 'static-library';
  if (TOOLING_CONFIG.test(name)) return 'tooling-config';
  return undefined;
}

/**
 * Filter for the `node_modules` tree: removed packages, then pruning, then
 * the secret deny-list. Order matters: a deny-listed file inside a directory
 * that is pruned or removed is dropped with it, one inside a kept package
 * fails the bundle.
 */
export function createNodeModulesFilter(
  options: PruneOptions = {},
): PruneFilter {
  const secret = createSecretFilter(options.secrets);
  const counts: Record<string, number> = {};
  return {
    filter(entry) {
      const rule = classifyPrune(entry, options);
      if (rule !== undefined) {
        counts[rule] = (counts[rule] ?? 0) + 1;
        return 'skip';
      }
      return secret(entry);
    },
    summary: () => ({ ...counts }),
  };
}

export interface BuildFilterOptions {
  readonly keepSourceMaps?: boolean;
  readonly secrets?: SecretFilterOptions;
}

/**
 * Filter for the application's build output: source maps are dropped unless
 * kept (`.DS_Store` always), everything on the deny-list fails the bundle.
 */
export function createBuildFilter(
  options: BuildFilterOptions = {},
): PruneFilter {
  const secret = createSecretFilter(options.secrets);
  const counts: Record<string, number> = {};
  return {
    filter(entry) {
      if (entry.kind === 'file') {
        const lower = asciiLower(entry.name);
        const rule: PruneRule | undefined =
          lower === '.ds_store'
            ? 'os-junk'
            : lower.endsWith('.map') && options.keepSourceMaps !== true
              ? 'source-map'
              : undefined;
        if (rule !== undefined) {
          counts[rule] = (counts[rule] ?? 0) + 1;
          return 'skip';
        }
      }
      return secret(entry);
    },
    summary: () => ({ ...counts }),
  };
}
