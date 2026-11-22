/**
 * The one rule for which SvelteKit route files the generator owns (#5437).
 *
 * A route file is generator output only with positive proof: it is a regular
 * `+server.ts` (inspected without following a link at the leaf) whose first
 * bytes, after at most one byte-order mark, are
 * {@link AUTO_GENERATED_ROUTE_HEADER}. Everything else at a route path is
 * application code: any `+server.js`, a hand-written, empty, unreadable or
 * symlinked `+server.ts`, or a directory of that name.
 *
 * Route generation never writes a route file directly. Every route writer
 * emits into a {@link RouteFilePlan}; the generator then runs a read-only
 * {@link RouteFilePlan.preflight} over every planned path before it runs
 * hooks, sweeps generated files or writes anything, and finally
 * {@link RouteFilePlan.commit}s the plan. The sweep and the commit re-check
 * the predicate immediately before each unlink or replacement, so neither
 * deletes, truncates, replaces or writes through a file the predicate
 * rejects at that moment.
 *
 * Scope: `+server.ts`/`+server.js` files present when a generator invocation
 * starts and not changed by another writer while it runs. Concurrent
 * generation, editor races and hard links are outside this rule (#5460);
 * the plugin's other generated outputs keep their own writers (#5469).
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import { canonicalSvelteKitPath } from './sveltekit-path.js';

const BYTE_ORDER_MARK = '﻿';
const GENERATED_ROUTE_FILE = '+server.ts';
const ROUTE_ENDPOINT_FILES = ['+server.ts', '+server.js'] as const;
/** TypeScript line terminators: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
const LINE_TERMINATOR = new RegExp(
  `[${['\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)].join('')}]`,
);

interface RouteFileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface RouteDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * The file-system calls route ownership and the generator's in-place writers
 * use; tests inject failures here. Writers open, then write, so a caller can
 * record a change once the open succeeds.
 */
export interface RouteFileSystem {
  lstatSync(path: string): RouteFileStats;
  statSync(path: string): RouteFileStats;
  readdirSync(path: string): RouteDirectoryEntry[];
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string, flag: 'w' | 'wx'): void;
  openSync(path: string, flag: 'w' | 'wx'): number;
  writeSync(descriptor: number, content: string): void;
  closeSync(descriptor: number): void;
  mkdirSync(path: string): void;
  unlinkSync(path: string): void;
}

/** `node:fs`, resolved at call time. */
export const nodeRouteFileSystem: RouteFileSystem = {
  lstatSync: (path) => lstatSync(path),
  statSync: (path) => statSync(path),
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
  readFileSync: (path) => readFileSync(path, 'utf-8'),
  writeFileSync: (path, content, flag) =>
    writeFileSync(path, content, { encoding: 'utf-8', flag }),
  openSync: (path, flag) => openSync(path, flag),
  // Writing to an open descriptor writes the whole content.
  writeSync: (descriptor, content) =>
    writeFileSync(descriptor, content, 'utf-8'),
  closeSync: (descriptor) => closeSync(descriptor),
  mkdirSync: (path) => {
    mkdirSync(path, { recursive: true });
  },
  unlinkSync: (path) => unlinkSync(path),
};

let routeFileSystemOverride: RouteFileSystem | undefined;

/** The route-fs seam in force: `node:fs` unless a test replaced it. */
export function activeRouteFileSystem(): RouteFileSystem {
  return routeFileSystemOverride ?? nodeRouteFileSystem;
}

/** Test seam (not a package export): replace the route-fs for every writer. */
export function setRouteFileSystemForTesting(
  fs: RouteFileSystem | undefined,
): void {
  routeFileSystemOverride = fs;
}

/** Whether route source text starts with the generated-route header. */
export function isGeneratedRouteSource(text: string): boolean {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  return body.startsWith(AUTO_GENERATED_ROUTE_HEADER);
}

/**
 * Whether `path` is a generated route file: a regular `+server.ts` at the
 * unresolved path whose source satisfies {@link isGeneratedRouteSource}.
 * Any inspection or read failure answers false (application code).
 */
export function isGeneratedRouteFile(
  path: string,
  fs: RouteFileSystem = activeRouteFileSystem(),
): boolean {
  if (basename(path) !== GENERATED_ROUTE_FILE) return false;
  try {
    if (!fs.lstatSync(path).isFile()) return false;
    return isGeneratedRouteSource(fs.readFileSync(path));
  } catch {
    return false;
  }
}

/**
 * Unlink `path` only if it is a generated route file at this moment. The
 * predicate is re-run here, immediately before the unlink.
 */
export function removeGeneratedRouteFile(
  path: string,
  fs: RouteFileSystem = activeRouteFileSystem(),
): boolean {
  if (!isGeneratedRouteFile(path, fs)) return false;
  fs.unlinkSync(path);
  return true;
}

/** One file or path component that keeps a route from being generated. */
export interface RouteOwnershipFinding {
  file: string;
  reason: string;
}

export interface RouteDirectoryInspection {
  /** Path components or endpoint files that cannot be inspected. */
  blocking: RouteOwnershipFinding[];
  /** Application-owned endpoint files in the directory. */
  application: RouteOwnershipFinding[];
  /**
   * An application `+server.ts` a yield route must not treat as a
   * hand-written override: empty, a strict prefix of the header, or carrying
   * the header below its first line.
   */
  yieldBlocker?: RouteOwnershipFinding;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Inspect a planned route directory without changing anything.
 *
 * Each existing path component from `root` down to `routeDir` is `lstat`ed.
 * A component that genuinely does not exist ends the walk: the directory is
 * absent and the commit creates it. A symlinked component whose target is
 * missing, a component that is not a directory, and a component that cannot
 * be inspected are blocking findings, so an existing but unusable directory
 * never reads as a missing one. In an existing directory both endpoint files
 * are `lstat`ed; only `ENOENT` counts as absent.
 */
export function inspectRouteDirectory(
  root: string,
  routeDir: string,
  fs: RouteFileSystem = activeRouteFileSystem(),
): RouteDirectoryInspection {
  const inspection: RouteDirectoryInspection = {
    blocking: [],
    application: [],
  };
  // Start at the routes root, or, for a destination that climbs out of it
  // (a knowledge `basePath` with `..`), at the deepest directory both share,
  // so every ancestor of the destination below that point is inspected.
  const start = commonAncestor(root, routeDir);
  const components = [
    start,
    ...relative(start, routeDir).split(sep).filter(Boolean),
  ];
  let current = '';
  for (const component of components) {
    current = current ? join(current, component) : component;
    let stats: RouteFileStats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return inspection;
      inspection.blocking.push({
        file: current,
        reason: `cannot be inspected (${errorCode(error) ?? 'error'})`,
      });
      return inspection;
    }
    if (stats.isSymbolicLink()) {
      try {
        if (fs.statSync(current).isDirectory()) continue;
        inspection.blocking.push({
          file: current,
          reason: 'is a symbolic link to something that is not a directory',
        });
      } catch (error) {
        const code = errorCode(error);
        inspection.blocking.push({
          file: current,
          reason:
            code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR'
              ? 'is a symbolic link whose target is missing'
              : `is a symbolic link that cannot be inspected (${code ?? 'error'})`,
        });
      }
      return inspection;
    }
    if (!stats.isDirectory()) {
      inspection.blocking.push({
        file: current,
        reason: 'is not a directory',
      });
      return inspection;
    }
  }

  for (const name of ROUTE_ENDPOINT_FILES) {
    const file = join(routeDir, name);
    let stats: RouteFileStats;
    try {
      stats = fs.lstatSync(file);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      inspection.blocking.push({
        file,
        reason: `cannot be inspected (${errorCode(error) ?? 'error'})`,
      });
      continue;
    }
    if (name === '+server.js') {
      inspection.application.push({
        file,
        reason: 'a +server.js endpoint is application code',
      });
      continue;
    }
    if (stats.isSymbolicLink()) {
      inspection.application.push({ file, reason: 'is a symbolic link' });
      continue;
    }
    if (stats.isDirectory()) {
      inspection.application.push({ file, reason: 'is a directory' });
      continue;
    }
    if (!stats.isFile()) {
      inspection.application.push({ file, reason: 'is not a regular file' });
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(file);
    } catch (error) {
      inspection.application.push({
        file,
        reason: `cannot be read (${errorCode(error) ?? 'error'})`,
      });
      continue;
    }
    if (isGeneratedRouteSource(text)) continue;
    const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
    const incomplete =
      body.length < AUTO_GENERATED_ROUTE_HEADER.length &&
      AUTO_GENERATED_ROUTE_HEADER.startsWith(body);
    inspection.application.push({
      file,
      reason:
        body.length === 0
          ? 'is empty'
          : incomplete
            ? 'holds only part of the generated-route header'
            : 'does not start with the generated-route header',
    });
    // A yield route never treats these as a hand-written override: an empty
    // or partial-header file is an interrupted generated write, and a header
    // below the first line is a generated file with lines added above it.
    // Any TypeScript line terminator ends the first line: LF, CR (alone or in
    // CRLF), LINE SEPARATOR and PARAGRAPH SEPARATOR.
    const firstLineBreak = body.search(LINE_TERMINATOR);
    if (incomplete) {
      inspection.yieldBlocker = {
        file,
        reason:
          body.length === 0
            ? 'is empty (an interrupted generated write?)'
            : 'holds only part of the generated-route header (an interrupted generated write?)',
      };
    } else if (
      firstLineBreak !== -1 &&
      body.slice(firstLineBreak + 1).includes(AUTO_GENERATED_ROUTE_HEADER)
    ) {
      inspection.yieldBlocker = {
        file,
        reason: 'has content above the generated-route header',
      };
    }
  }
  return inspection;
}

/** How the volume holding a destination compares names. */
export type RouteCaseBehaviour = 'sensitive' | 'insensitive' | 'unknown';

type IdentifiedStats = RouteFileStats & { ino?: unknown; dev?: unknown };

function swapCase(name: string): string {
  return [...name]
    .map((character) =>
      character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase(),
    )
    .join('');
}

/**
 * The case behaviour of the volume a destination directory lives on,
 * measured read-only inside the nearest existing directory of the
 * destination (never by renaming that directory in its parent, which may be
 * another volume): an entry with letters is looked up with its case swapped.
 * The same file means insensitive; `ENOENT` (or a different file) means
 * sensitive. With no entry to probe the answer is `unknown`.
 */
export function destinationCaseBehaviour(
  routeDir: string,
  fs: RouteFileSystem = activeRouteFileSystem(),
  cache?: Map<string, RouteCaseBehaviour>,
): RouteCaseBehaviour {
  let existing = routeDir;
  for (;;) {
    try {
      if (fs.statSync(existing).isDirectory()) break;
      return 'unknown';
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return 'unknown';
      existing = parent;
    }
  }
  const cached = cache?.get(existing);
  if (cached) return cached;
  let behaviour: RouteCaseBehaviour = 'unknown';
  let entries: RouteDirectoryEntry[] = [];
  try {
    entries = fs.readdirSync(existing);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const swapped = swapCase(entry.name);
    if (swapped === entry.name) continue;
    let original: IdentifiedStats;
    try {
      original = fs.statSync(join(existing, entry.name)) as IdentifiedStats;
    } catch {
      continue;
    }
    if (typeof original.ino !== 'number') continue;
    try {
      const alias = fs.statSync(join(existing, swapped)) as IdentifiedStats;
      behaviour =
        alias.ino === original.ino && alias.dev === original.dev
          ? 'insensitive'
          : 'sensitive';
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') continue;
      behaviour = 'sensitive';
    }
    break;
  }
  cache?.set(existing, behaviour);
  return behaviour;
}

/**
 * The physical identity of the route file in `routeDir`: the canonical
 * directory plus the literal leaf, and its case-folded form. Both the plan
 * and the hosted collision claim pass compare paths with this.
 */
export function physicalRouteFileKey(
  routeDir: string,
  fs: RouteFileSystem = activeRouteFileSystem(),
  cache?: Map<string, RouteCaseBehaviour>,
  caseInsensitive?: boolean,
): { exact: string; folded: string; behaviour: RouteCaseBehaviour } {
  const exact = join(canonicalSvelteKitPath(routeDir), GENERATED_ROUTE_FILE);
  const behaviour =
    caseInsensitive === undefined
      ? destinationCaseBehaviour(routeDir, fs, cache)
      : caseInsensitive
        ? 'insensitive'
        : 'sensitive';
  return { exact, folded: exact.toLowerCase(), behaviour };
}

/**
 * Directories below `routesRoot` that the generated-route sweep would walk
 * but cannot list. Mirrors the sweep's traversal (linked directories
 * followed once, protected foreign roots skipped) without changing anything,
 * so a directory the sweep would fail on refuses in the preflight.
 */
export function findUnlistableRouteDirectories(
  routesRoot: string,
  protectedRouteRoots: ReadonlySet<string> = new Set(),
  fs: RouteFileSystem = activeRouteFileSystem(),
): RouteOwnershipFinding[] {
  const findings: RouteOwnershipFinding[] = [];
  const visited = new Set<string>();
  const walk = (directory: string) => {
    const canonical = canonicalSvelteKitPath(directory);
    if (protectedRouteRoots.has(canonical) || visited.has(canonical)) return;
    try {
      fs.statSync(directory);
    } catch {
      return;
    }
    visited.add(canonical);
    let entries: RouteDirectoryEntry[];
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      findings.push({
        file: directory,
        reason: `cannot be listed (${errorCode(error) ?? 'error'})`,
      });
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isSymbolicLink?.()) {
        try {
          if (fs.statSync(path).isDirectory()) walk(path);
        } catch {
          // A dangling link is not a directory the sweep enters.
        }
      }
    }
  };
  walk(routesRoot);
  return findings;
}

/** The deepest directory that contains both absolute paths. */
function commonAncestor(left: string, right: string): string {
  let ancestor = left;
  for (;;) {
    const fromAncestor = relative(ancestor, right);
    if (
      fromAncestor === '' ||
      (!isAbsolute(fromAncestor) &&
        fromAncestor !== '..' &&
        !fromAncestor.startsWith(`..${sep}`))
    ) {
      return ancestor;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return ancestor;
    ancestor = parent;
  }
}

export type RouteOwnershipPhase = 'preflight' | 'commit';

export interface RouteOwnershipConflict extends RouteOwnershipFinding {
  route: string;
}

/**
 * Route generation stopped because an application-owned file sits at a
 * generated route path. `phase: 'preflight'` means nothing of the invocation
 * changed; `phase: 'commit'` names the file found during commit and lists
 * the route files already written in `written`.
 */
export class ApplicationRouteConflictError extends Error {
  readonly code = 'SMRT_ROUTE_OWNERSHIP_CONFLICT';
  readonly phase: RouteOwnershipPhase;
  readonly files: string[];
  readonly routes: string[];
  readonly written: string[];

  constructor(
    phase: RouteOwnershipPhase,
    conflicts: readonly RouteOwnershipConflict[],
    written: readonly string[] = [],
  ) {
    const lines = conflicts.map(
      ({ file, reason, route }) => `  - ${file} ${reason} (route: ${route})`,
    );
    const heading =
      phase === 'preflight'
        ? `[smrt] Route generation stopped before changing any file: ${conflicts.length} application-owned route file${conflicts.length === 1 ? '' : 's'} at generated route paths:`
        : '[smrt] Route generation stopped during commit: an application-owned file appeared at a generated route path:';
    const advice =
      "Move or rename the file, or stop generating that route (api: false, api.exclude, or the route's enabled: false). " +
      'To keep a hand-edited generated file, delete its header line and exclude the route.';
    const writtenLines =
      phase === 'commit'
        ? [
            written.length > 0
              ? `Route files already written:\n${written.map((file) => `  - ${file}`).join('\n')}`
              : 'No route files were written.',
          ]
        : [];
    super([heading, ...lines, advice, ...writtenLines].join('\n'));
    this.name = 'ApplicationRouteConflictError';
    this.phase = phase;
    this.files = [...new Set(conflicts.map(({ file }) => file))];
    this.routes = [...new Set(conflicts.map(({ route }) => route))];
    this.written = [...written];
  }
}

/**
 * How a route writer treats an application file at its path. `refuse`
 * stops generation; `yield` (a documented override: `_resources`,
 * `sync/apply`) leaves the application handler in place and writes nothing.
 */
export type RouteEmitPolicy = 'refuse' | 'yield';

export interface RouteEmit {
  /** Routes root the directory sits under (inspection starts here). */
  root: string;
  routeDir: string;
  content: string;
  /** Human-readable route name for errors. */
  label: string;
  policy?: RouteEmitPolicy;
  /** Called when a yield route leaves an application handler in place. */
  onYield?: (file: string) => void;
}

interface PlannedRouteFile {
  key: string;
  root: string;
  routeDir: string;
  content: string;
  label: string;
  policy: RouteEmitPolicy;
  onYield?: (file: string) => void;
  spellings: Array<{ root: string; routeDir: string; label: string }>;
  yielded: boolean;
}

/** The in-memory route-file plan of one generator invocation. */
export class RouteFilePlan {
  private readonly planned = new Map<string, PlannedRouteFile>();
  private readonly protectedPaths: ReadonlySet<string>;
  private readonly fs: RouteFileSystem;

  private readonly caseInsensitive?: boolean;
  private readonly caseProbe = new Map<string, RouteCaseBehaviour>();
  /** Folded key -> map keys planned under it (case-only spellings). */
  private readonly foldedKeys = new Map<string, Set<string>>();

  constructor(
    options: {
      protectedPaths?: ReadonlySet<string>;
      fs?: RouteFileSystem;
      /** Override the destination volume's detected case behaviour. */
      caseInsensitive?: boolean;
    } = {},
  ) {
    this.protectedPaths = options.protectedPaths ?? new Set();
    this.fs = options.fs ?? activeRouteFileSystem();
    this.caseInsensitive = options.caseInsensitive;
  }

  private keyInfo(routeDir: string) {
    const info = physicalRouteFileKey(
      routeDir,
      this.fs,
      this.caseProbe,
      this.caseInsensitive,
    );
    // On a case-insensitive volume, prospective segments that differ only by
    // case name one file, so the map key is case-folded there.
    return {
      ...info,
      key: info.behaviour === 'insensitive' ? info.folded : info.exact,
    };
  }

  private keyFor(routeDir: string): string {
    return this.keyInfo(routeDir).key;
  }

  /**
   * Whether `routeDir`'s route file is another producer's in this build. A
   * case-only alias counts unless the volume is known to be case-sensitive.
   */
  protects(routeDir: string): boolean {
    const { exact, folded, behaviour } = this.keyInfo(routeDir);
    if (this.protectedPaths.has(exact)) return true;
    if (behaviour === 'sensitive') return false;
    for (const path of this.protectedPaths) {
      if (path.toLowerCase() === folded) return true;
    }
    return false;
  }

  /**
   * Record a route file. Rendering only: nothing touches the disk. Two
   * `refuse` emits on one physical path keep the later content; a `refuse`
   * and a `yield` emit on one path, or an emit to a path another producer
   * owns in this build, throw `Conflicting SvelteKit route`.
   */
  emit(input: RouteEmit): string {
    const file = join(input.routeDir, GENERATED_ROUTE_FILE);
    if (!isGeneratedRouteSource(input.content)) {
      throw new Error(
        `[smrt] Generated route content for ${file} must start with the generated-route header`,
      );
    }
    const policy = input.policy ?? 'refuse';
    const { key, folded, behaviour } = this.keyInfo(input.routeDir);
    if (this.protects(input.routeDir)) {
      throw new Error(
        `Conflicting SvelteKit route ${input.routeDir}: ${input.label} would write ${file}, which another producer owns in this build`,
      );
    }
    const caseSpellings = this.foldedKeys.get(folded) ?? new Set<string>();
    if (
      behaviour === 'unknown' &&
      [...caseSpellings].some((spelling) => spelling !== key)
    ) {
      // Two planned paths differ only by case and the destination volume's
      // case behaviour cannot be established read-only: they may be one file.
      throw new Error(
        `Conflicting SvelteKit route ${input.routeDir}: ${input.label} and another route differ only by letter case, and the destination's case sensitivity cannot be determined`,
      );
    }
    caseSpellings.add(key);
    this.foldedKeys.set(folded, caseSpellings);
    const spelling = {
      root: input.root,
      routeDir: input.routeDir,
      label: input.label,
    };
    const existing = this.planned.get(key);
    if (existing) {
      if (existing.policy !== policy) {
        throw new Error(
          `Conflicting SvelteKit route ${input.routeDir}: ${existing.label} and ${input.label} would write the same handler`,
        );
      }
      existing.root = input.root;
      existing.routeDir = input.routeDir;
      existing.content = input.content;
      existing.label = input.label;
      existing.onYield = input.onYield;
      existing.spellings.push(spelling);
      return file;
    }
    this.planned.set(key, {
      key,
      root: input.root,
      routeDir: input.routeDir,
      content: input.content,
      label: input.label,
      policy,
      onYield: input.onYield,
      spellings: [spelling],
      yielded: false,
    });
    return file;
  }

  /** Whether any emit already claims the physical route file in `routeDir`. */
  claims(routeDir: string): boolean {
    return this.planned.has(this.keyFor(routeDir));
  }

  /** Planned route files, in emit order (for inspection by tests). */
  entries(): ReadonlyArray<
    Readonly<
      Pick<PlannedRouteFile, 'routeDir' | 'content' | 'label' | 'policy'>
    >
  > {
    return [...this.planned.values()];
  }

  /**
   * Read-only check of every lexical spelling of every planned path. Throws
   * one {@link ApplicationRouteConflictError} naming every conflict; marks
   * yield routes that leave an application handler in place. `extra` adds
   * conflicts found by the caller (directories the sweep cannot list) to the
   * same error.
   */
  preflight(extra: readonly RouteOwnershipConflict[] = []): void {
    const conflicts: RouteOwnershipConflict[] = [...extra];
    const yields: Array<{ entry: PlannedRouteFile; file: string }> = [];
    for (const entry of this.planned.values()) {
      const inspections = entry.spellings.map((spelling) => ({
        spelling,
        inspection: inspectRouteDirectory(
          spelling.root,
          spelling.routeDir,
          this.fs,
        ),
      }));
      const blocking = inspections.flatMap(({ spelling, inspection }) =>
        inspection.blocking.map((finding) => ({
          ...finding,
          route: spelling.label,
        })),
      );
      const application = inspections.flatMap(({ spelling, inspection }) =>
        inspection.application.map((finding) => ({
          ...finding,
          route: spelling.label,
        })),
      );
      if (entry.policy === 'refuse') {
        conflicts.push(...blocking, ...application);
        continue;
      }
      const blocker = inspections.find(
        ({ inspection }) => inspection.yieldBlocker,
      );
      if (blocking.length > 0 || blocker) {
        conflicts.push(...blocking);
        if (blocker?.inspection.yieldBlocker) {
          conflicts.push({
            ...blocker.inspection.yieldBlocker,
            route: blocker.spelling.label,
          });
        }
        continue;
      }
      if (application[0]) {
        yields.push({ entry, file: application[0].file });
      }
    }
    if (conflicts.length > 0) {
      const seen = new Set<string>();
      throw new ApplicationRouteConflictError(
        'preflight',
        conflicts.filter(({ file }) => {
          if (seen.has(file)) return false;
          seen.add(file);
          return true;
        }),
      );
    }
    for (const { entry, file } of yields) {
      entry.yielded = true;
      // Name the application file actually found (`.ts` or `.js`).
      entry.onYield?.(file);
    }
  }

  /**
   * Write every planned route file that did not yield. An absent leaf is
   * created exclusively; a present leaf is re-checked immediately before it
   * is replaced, and replaced only if it is generated. Returns the files
   * written.
   *
   * `onMutate` runs once a route file's open succeeds, before any byte is
   * written: a file created and then left truncated by a failed write is a
   * change, and the error names it.
   */
  commit(onMutate: () => void = () => {}): string[] {
    const written: string[] = [];
    for (const entry of this.planned.values()) {
      if (entry.yielded) continue;
      const file = join(entry.routeDir, GENERATED_ROUTE_FILE);
      let absent = false;
      try {
        this.fs.lstatSync(file);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          // An I/O failure, not an ownership finding: name it as such. The
          // file is still never overwritten.
          throw this.commitRefusal(
            entry,
            file,
            written,
            `could not be inspected during commit (${errorCode(error) ?? 'error'})`,
          );
        }
        absent = true;
      }
      if (absent) {
        this.fs.mkdirSync(entry.routeDir);
        let descriptor: number | undefined;
        try {
          descriptor = this.fs.openSync(file, 'wx');
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        if (descriptor !== undefined) {
          this.writeOpened(descriptor, file, entry.content, onMutate);
          written.push(file);
          console.log(`[smrt] Generated: ${file}`);
          continue;
        }
      }
      if (!isGeneratedRouteFile(file, this.fs)) {
        throw this.commitRefusal(entry, file, written);
      }
      this.writeOpened(
        this.fs.openSync(file, 'w'),
        file,
        entry.content,
        onMutate,
      );
      written.push(file);
      console.log(`[smrt] Generated: ${file}`);
    }
    return written;
  }

  private writeOpened(
    descriptor: number,
    file: string,
    content: string,
    onMutate: () => void,
  ): void {
    try {
      onMutate();
      this.fs.writeSync(descriptor, content);
    } catch (error) {
      throw new Error(
        `[smrt] Writing generated route file ${file} failed after it was opened; the file may be truncated`,
        { cause: error },
      );
    } finally {
      this.fs.closeSync(descriptor);
    }
  }

  private commitRefusal(
    entry: PlannedRouteFile,
    file: string,
    written: readonly string[],
    reason = 'is not a generated route file',
  ): ApplicationRouteConflictError {
    return new ApplicationRouteConflictError(
      'commit',
      [{ file, reason, route: entry.label }],
      written,
    );
  }
}
