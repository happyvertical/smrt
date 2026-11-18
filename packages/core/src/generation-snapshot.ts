import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { discoverSmrtPackageLocations } from './manifest/discover-smrt-packages.js';
import { modelReplacements } from './manifest/model-replacements.js';
import type { SmartObjectManifest } from './scanner/types.js';

const SOURCE_ROOT_PREFIX = '@smrt/source-root/';

export type SmrtGenerationSnapshotView = 'all' | 'project' | 'dependencies';

/**
 * Immutable manifest artifact consumed by SMRT's Vite plugins.
 *
 * `provenance` is caller-defined source identity (normally the exact git tree
 * or commit). Consumers must provide the identity they expect; the loader does
 * not trust the artifact to identify itself.
 */
export interface SmrtGenerationSnapshotArtifact<TManifest> {
  schemaVersion: 1;
  provenance: string;
  pathMode: 'source-root-relative';
  sourceDigests: Record<string, string>;
  /**
   * Every input of the project scan (source set, package.json, recipe help
   * and UI selector files, dependency manifests). Present when the snapshot
   * was serialized with `projectRoot`; an artifact without it is verified
   * against `sourceDigests` only.
   */
  inputs?: SnapshotInputs;
  manifest: TManifest;
}

/** Fail-closed input used by `smrtPlugin()` and `smrtConsumer()`. */
export interface SmrtGenerationSnapshotOptions {
  /** Artifact path, absolute or relative to the plugin's project root. */
  path: string;
  /** SHA-256 of the exact artifact bytes, formatted as `sha256:<hex>`. */
  sha256: string;
  /** Expected source identity, matched exactly against artifact provenance. */
  provenance: string;
  /** Current checkout root corresponding to paths normalized by the producer. */
  sourceRoot: string;
}

export interface SerializeSmrtGenerationSnapshotOptions {
  /** Checkout/workspace root used to make local source paths portable. */
  sourceRoot: string;
  /**
   * Project root whose `.smrt/generation-inputs.json` (written by a normal
   * `smrtPlugin()` generation) lists every scan input. With it, the snapshot
   * digests all of them and reuse fails on any added, removed or changed
   * input; without it, only the model source files are digested.
   */
  projectRoot?: string;
}

function isInsideRoot(root: string, filePath: string): boolean {
  const relativePath = relative(root, filePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

/** Sidecar `smrtPlugin()` writes beside `.smrt/manifest.json`. */
export const SMRT_GENERATION_INPUTS_FILE = 'generation-inputs.json';

/**
 * Every file one project scan read to build its manifest, as `smrtPlugin()`
 * records it in `.smrt/generation-inputs.json` (absolute paths).
 */
export interface SmrtGenerationInputs {
  version: 1;
  /** Directory the scan ran in. */
  projectRoot: string;
  /** Source globs and symlink policy exactly as passed to the scanner. */
  include: string[];
  exclude: string[];
  followSymbolicLinks: boolean;
  /** The files the source globs selected. */
  sources: string[];
  /** Other inputs: package.json, recipe help files, UI selector files. */
  files: string[];
  /** Discovered SMRT dependency manifests, by package name. */
  dependencies: Record<string, string>;
}

/** Portable form recorded in a snapshot (paths relative to `sourceRoot`). */
interface SnapshotInputs {
  projectRoot: string;
  include: string[];
  exclude: string[];
  followSymbolicLinks: boolean;
  sources: string[];
  /** Portable path -> digest, for every source and other input file. */
  digests: Record<string, string>;
  /** Package name -> digest of its selected manifest. */
  dependencies: Record<string, string>;
}

/** The recorded source globs, hydrated for a fresh discovery. */
export interface SmrtGenerationSnapshotSourceSet {
  projectRoot: string;
  include: string[];
  exclude: string[];
  followSymbolicLinks: boolean;
  /** Absolute paths of the sources the snapshot's scan selected, sorted. */
  sources: string[];
}

function toPortable(sourceRoot: string, file: string, what: string): string {
  const absolute = resolve(file);
  if (!isInsideRoot(sourceRoot, absolute)) {
    throw new Error(
      `[smrt] Generation snapshot ${what} is outside sourceRoot: ${file}`,
    );
  }
  return relative(sourceRoot, absolute).replace(/\\/g, '/');
}

function fromPortable(sourceRoot: string, portable: string, what: string) {
  const hydrated = resolve(sourceRoot, portable);
  if (isAbsolute(portable) || !isInsideRoot(sourceRoot, hydrated)) {
    throw new Error(
      `[smrt] Generation snapshot contains an invalid ${what} path: ${portable}`,
    );
  }
  return hydrated;
}

function sortedRecord(entries: Iterable<[string, string]>) {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Read the inputs sidecar `smrtPlugin()` wrote for `projectRoot`. */
export function readSmrtGenerationInputs(
  projectRoot: string,
): SmrtGenerationInputs {
  const file = resolve(projectRoot, '.smrt', SMRT_GENERATION_INPUTS_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(
      `[smrt] Cannot read generation inputs at ${file}; run a normal smrtPlugin() generation first`,
      { cause: error },
    );
  }
  if (!isGenerationInputs(parsed)) {
    throw new Error(`[smrt] Invalid generation inputs at ${file}`);
  }
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isGenerationInputs(value: unknown): value is SmrtGenerationInputs {
  const candidate = value as Partial<SmrtGenerationInputs> | null;
  return (
    !!candidate &&
    candidate.version === 1 &&
    typeof candidate.projectRoot === 'string' &&
    isStringArray(candidate.include) &&
    isStringArray(candidate.exclude) &&
    typeof candidate.followSymbolicLinks === 'boolean' &&
    isStringArray(candidate.sources) &&
    isStringArray(candidate.files) &&
    isStringRecord(candidate.dependencies)
  );
}

function isSnapshotInputs(value: unknown): value is SnapshotInputs {
  const candidate = value as Partial<SnapshotInputs> | null;
  return (
    !!candidate &&
    typeof candidate.projectRoot === 'string' &&
    isStringArray(candidate.include) &&
    isStringArray(candidate.exclude) &&
    typeof candidate.followSymbolicLinks === 'boolean' &&
    isStringArray(candidate.sources) &&
    isStringRecord(candidate.digests) &&
    isStringRecord(candidate.dependencies)
  );
}

function snapshotInputs(
  inputs: SmrtGenerationInputs,
  sourceRoot: string,
): SnapshotInputs {
  const digests = new Map<string, string>();
  const sources: string[] = [];
  for (const file of inputs.sources) {
    const portable = toPortable(sourceRoot, file, 'source');
    sources.push(portable);
    digests.set(portable, sha256SmrtGenerationSnapshot(readFileSync(file)));
  }
  for (const file of inputs.files) {
    const portable = toPortable(sourceRoot, file, 'input');
    digests.set(portable, sha256SmrtGenerationSnapshot(readFileSync(file)));
  }
  return {
    projectRoot: toPortable(sourceRoot, inputs.projectRoot, 'project root'),
    include: inputs.include,
    exclude: inputs.exclude,
    followSymbolicLinks: inputs.followSymbolicLinks,
    sources: [...new Set(sources)].sort(),
    digests: sortedRecord(digests),
    dependencies: sortedRecord(
      Object.entries(inputs.dependencies).map(([name, file]) => [
        name,
        sha256SmrtGenerationSnapshot(readFileSync(file)),
      ]),
    ),
  };
}

/**
 * Fail unless every recorded input still has its recorded bytes and the
 * project still resolves the same dependency manifests.
 */
function verifySnapshotInputs(inputs: SnapshotInputs, sourceRoot: string) {
  for (const [portable, digest] of Object.entries(inputs.digests)) {
    const file = fromPortable(sourceRoot, portable, 'input');
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(
        `[smrt] Generation snapshot contains an invalid input digest for: ${portable}`,
      );
    }
    if (!existsSync(file)) {
      throw new Error(
        `[smrt] Generation snapshot input is missing under the current sourceRoot: ${file}`,
      );
    }
    const actual = sha256SmrtGenerationSnapshot(readFileSync(file));
    if (actual !== digest) {
      throw new Error(
        `[smrt] Generation snapshot input changed: ${file} (expected ${digest}, received ${actual})`,
      );
    }
  }

  const projectRoot = fromPortable(
    sourceRoot,
    inputs.projectRoot || '.',
    'project root',
  );
  const current = discoverSmrtPackageLocations({ baseDir: projectRoot });
  const recorded = Object.keys(inputs.dependencies).sort();
  const installed = Object.keys(current).sort();
  if (recorded.join('\n') !== installed.join('\n')) {
    throw new Error(
      `[smrt] Generation snapshot dependency set changed: recorded [${recorded.join(', ')}], installed [${installed.join(', ')}]`,
    );
  }
  for (const [name, digest] of Object.entries(inputs.dependencies)) {
    const actual = sha256SmrtGenerationSnapshot(
      readFileSync(current[name].manifestPath),
    );
    if (actual !== digest) {
      throw new Error(
        `[smrt] Generation snapshot dependency manifest changed for ${name}: ${current[name].manifestPath}`,
      );
    }
  }
}

function normalizeManifestPaths<TManifest>(
  manifest: TManifest,
  sourceRoot: string,
): { manifest: TManifest; sourceDigests: Record<string, string> } {
  const clone = structuredClone(manifest) as TManifest;
  if (!isManifest(clone)) return { manifest: clone, sourceDigests: {} };
  const packageName = (clone as { packageName?: string }).packageName;
  const sourceDigests = new Map<string, string>();

  for (const definition of Object.values(clone.objects)) {
    if (!definition || typeof definition !== 'object') continue;
    const candidate = definition as Record<string, unknown>;
    if (typeof candidate.filePath !== 'string') continue;
    const isProjectDefinition =
      candidate.packageName === undefined ||
      candidate.packageName === packageName;
    if (!isProjectDefinition && !isAbsolute(candidate.filePath)) continue;

    const sourcePath = isAbsolute(candidate.filePath)
      ? candidate.filePath
      : resolve(sourceRoot, candidate.filePath);
    if (!isInsideRoot(sourceRoot, sourcePath)) {
      if (isProjectDefinition) {
        throw new Error(
          `[smrt] Generation snapshot project source path is outside sourceRoot: ${candidate.filePath}`,
        );
      }
      continue;
    }

    const relativePath = relative(sourceRoot, sourcePath).replace(/\\/g, '/');
    sourceDigests.set(
      relativePath,
      sha256SmrtGenerationSnapshot(readFileSync(sourcePath)),
    );
    candidate.filePath = `${SOURCE_ROOT_PREFIX}${relativePath}`;
  }

  return {
    manifest: clone,
    sourceDigests: Object.fromEntries(
      [...sourceDigests.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function hydrateManifestPaths<TManifest>(
  manifest: TManifest,
  sourceRoot: string,
  sourceDigests: Record<string, string>,
): TManifest {
  if (!isAbsolute(sourceRoot)) {
    throw new Error('[smrt] Generation snapshot sourceRoot must be absolute');
  }
  const resolvedSourceRoot = resolve(sourceRoot);
  if (
    !existsSync(resolvedSourceRoot) ||
    !statSync(resolvedSourceRoot).isDirectory()
  ) {
    throw new Error(
      '[smrt] Generation snapshot sourceRoot must be an existing directory',
    );
  }
  const packageName = (manifest as { packageName?: string }).packageName;
  const consumedSourceDigests = new Set<string>();

  for (const [relativePath, digest] of Object.entries(sourceDigests)) {
    const hydratedPath = resolve(resolvedSourceRoot, relativePath);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      !isInsideRoot(resolvedSourceRoot, hydratedPath)
    ) {
      throw new Error(
        `[smrt] Generation snapshot contains an invalid source digest path: ${relativePath}`,
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(
        `[smrt] Generation snapshot contains an invalid source digest for: ${relativePath}`,
      );
    }
  }

  for (const definition of Object.values(
    (manifest as { objects: Record<string, unknown> }).objects,
  )) {
    if (!definition || typeof definition !== 'object') continue;
    const candidate = definition as Record<string, unknown>;
    if (typeof candidate.filePath !== 'string') {
      continue;
    }
    if (!candidate.filePath.startsWith(SOURCE_ROOT_PREFIX)) {
      const isProjectDefinition =
        candidate.packageName === undefined ||
        candidate.packageName === packageName;
      if (isProjectDefinition) {
        throw new Error(
          `[smrt] Generation snapshot contains a non-portable project source path: ${candidate.filePath}`,
        );
      }
      continue;
    }

    const relativePath = candidate.filePath.slice(SOURCE_ROOT_PREFIX.length);
    const hydratedPath = resolve(resolvedSourceRoot, relativePath);
    if (!relativePath || !isInsideRoot(resolvedSourceRoot, hydratedPath)) {
      throw new Error(
        `[smrt] Generation snapshot contains an invalid portable source path: ${candidate.filePath}`,
      );
    }
    if (!existsSync(hydratedPath)) {
      throw new Error(
        `[smrt] Generation snapshot source path is missing under the current sourceRoot: ${hydratedPath}`,
      );
    }
    const expectedSourceDigest = Object.hasOwn(sourceDigests, relativePath)
      ? sourceDigests[relativePath]
      : undefined;
    if (!expectedSourceDigest) {
      throw new Error(
        `[smrt] Generation snapshot has no source digest for: ${relativePath}`,
      );
    }
    const actualSourceDigest = sha256SmrtGenerationSnapshot(
      readFileSync(hydratedPath),
    );
    if (actualSourceDigest !== expectedSourceDigest) {
      throw new Error(
        `[smrt] Generation snapshot source digest mismatch for ${hydratedPath}: expected ${expectedSourceDigest}, received ${actualSourceDigest}`,
      );
    }
    consumedSourceDigests.add(relativePath);
    candidate.filePath = hydratedPath;
  }

  const unreferencedSourceDigests = Object.keys(sourceDigests).filter(
    (relativePath) => !consumedSourceDigests.has(relativePath),
  );
  if (unreferencedSourceDigests.length > 0) {
    throw new Error(
      `[smrt] Generation snapshot contains unreferenced source digest(s): ${unreferencedSourceDigests.join(', ')}`,
    );
  }

  return manifest;
}

function selectManifestView<TManifest>(
  manifest: TManifest,
  view: SmrtGenerationSnapshotView,
): TManifest {
  if (!['all', 'project', 'dependencies'].includes(view)) {
    throw new Error(`[smrt] Unsupported generation snapshot view: ${view}`);
  }
  if (view === 'all') return manifest;

  const typed = manifest as {
    packageName?: string;
    objects: Record<string, Record<string, unknown>>;
  };
  if (!typed.packageName) {
    throw new Error(
      `[smrt] Generation snapshot ${view} view requires a top-level packageName`,
    );
  }

  const effectiveDependencies = new Set(
    modelReplacements(typed as unknown as SmartObjectManifest).values(),
  );
  const objects = Object.fromEntries(
    Object.entries(typed.objects).filter(([key, definition]) => {
      const owner = definition.packageName;
      const isProject = owner === undefined || owner === typed.packageName;
      return view === 'project'
        ? isProject
        : !isProject || effectiveDependencies.has(key);
    }),
  );

  return { ...typed, objects } as TManifest;
}

/** Serialize one deterministic, portable generation snapshot. */
export function serializeSmrtGenerationSnapshot<TManifest>(
  manifest: TManifest,
  provenance: string,
  options: SerializeSmrtGenerationSnapshotOptions,
): string {
  if (!provenance.trim()) {
    throw new Error('[smrt] Generation snapshot provenance must not be empty');
  }
  if (!isAbsolute(options.sourceRoot)) {
    throw new Error(
      '[smrt] Generation snapshot sourceRoot must be an absolute path',
    );
  }
  if (
    !existsSync(options.sourceRoot) ||
    !statSync(options.sourceRoot).isDirectory()
  ) {
    throw new Error(
      '[smrt] Generation snapshot sourceRoot must be an existing directory',
    );
  }
  if (!isManifest(manifest)) {
    throw new Error('[smrt] Generation snapshot requires a valid manifest');
  }
  const sourceRoot = resolve(options.sourceRoot);
  const { manifest: portableManifest, sourceDigests } = normalizeManifestPaths(
    manifest,
    sourceRoot,
  );
  const inputs =
    options.projectRoot === undefined
      ? undefined
      : snapshotInputs(
          readSmrtGenerationInputs(options.projectRoot),
          sourceRoot,
        );
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      provenance,
      pathMode: 'source-root-relative',
      sourceDigests,
      ...(inputs ? { inputs } : {}),
      manifest: portableManifest,
    } satisfies SmrtGenerationSnapshotArtifact<TManifest>,
    null,
    2,
  )}\n`;
}

/** Return the digest format accepted by `SmrtGenerationSnapshotOptions`. */
export function sha256SmrtGenerationSnapshot(
  contents: string | Uint8Array,
): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function isManifest(value: unknown): value is {
  version: string;
  timestamp: number;
  objects: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.timestamp === 'number' &&
    Boolean(
      candidate.objects &&
        typeof candidate.objects === 'object' &&
        !Array.isArray(candidate.objects),
    )
  );
}

/**
 * Read the artifact and verify its bytes, provenance and envelope. Recorded
 * scan inputs are verified too, so every reader fails closed on input drift.
 */
function readVerifiedEnvelope(
  options: SmrtGenerationSnapshotOptions,
  projectRoot: string,
): { envelope: SmrtGenerationSnapshotArtifact<unknown>; artifactPath: string } {
  if (!/^sha256:[a-f0-9]{64}$/.test(options.sha256)) {
    throw new Error(
      '[smrt] Generation snapshot sha256 must use sha256:<64 lowercase hex characters>',
    );
  }
  if (!options.provenance.trim()) {
    throw new Error(
      '[smrt] Expected generation snapshot provenance is required',
    );
  }

  const artifactPath = isAbsolute(options.path)
    ? options.path
    : resolve(projectRoot, options.path);

  let contents: Buffer;
  try {
    contents = readFileSync(artifactPath);
  } catch (error) {
    throw new Error(
      `[smrt] Unable to read generation snapshot at ${artifactPath}`,
      { cause: error },
    );
  }

  const actualDigest = sha256SmrtGenerationSnapshot(contents);
  if (actualDigest !== options.sha256) {
    throw new Error(
      `[smrt] Generation snapshot digest mismatch at ${artifactPath}: expected ${options.sha256}, received ${actualDigest}`,
    );
  }

  let artifact: unknown;
  try {
    artifact = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(
      `[smrt] Generation snapshot at ${artifactPath} is not valid JSON`,
      { cause: error },
    );
  }

  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(`[smrt] Invalid generation snapshot at ${artifactPath}`);
  }
  const envelope = artifact as Partial<SmrtGenerationSnapshotArtifact<unknown>>;
  if (envelope.schemaVersion !== 1) {
    throw new Error(
      `[smrt] Unsupported generation snapshot schema at ${artifactPath}`,
    );
  }
  if (envelope.provenance !== options.provenance) {
    throw new Error(
      `[smrt] Generation snapshot provenance mismatch at ${artifactPath}`,
    );
  }
  if (envelope.pathMode !== 'source-root-relative') {
    throw new Error(
      `[smrt] Unsupported generation snapshot path mode at ${artifactPath}`,
    );
  }
  if (
    !envelope.sourceDigests ||
    typeof envelope.sourceDigests !== 'object' ||
    Array.isArray(envelope.sourceDigests)
  ) {
    throw new Error(
      `[smrt] Generation snapshot at ${artifactPath} does not contain source digests`,
    );
  }
  if (!isManifest(envelope.manifest)) {
    throw new Error(
      `[smrt] Generation snapshot at ${artifactPath} does not contain a valid manifest`,
    );
  }

  if (envelope.inputs !== undefined) {
    if (!isSnapshotInputs(envelope.inputs)) {
      throw new Error(
        `[smrt] Generation snapshot at ${artifactPath} contains invalid inputs`,
      );
    }
    verifySnapshotInputs(
      envelope.inputs,
      resolveSourceRoot(options.sourceRoot),
    );
  }

  return {
    envelope: envelope as SmrtGenerationSnapshotArtifact<unknown>,
    artifactPath,
  };
}

function resolveSourceRoot(sourceRoot: string): string {
  if (!isAbsolute(sourceRoot)) {
    throw new Error('[smrt] Generation snapshot sourceRoot must be absolute');
  }
  return resolve(sourceRoot);
}

/**
 * Load and verify a generation snapshot without mutating the artifact or project.
 */
export function loadVerifiedSmrtGenerationSnapshot<TManifest>(
  options: SmrtGenerationSnapshotOptions,
  projectRoot: string,
  view: SmrtGenerationSnapshotView = 'all',
): TManifest {
  const { envelope } = readVerifiedEnvelope(options, projectRoot);
  const hydrated = hydrateManifestPaths(
    envelope.manifest as TManifest,
    options.sourceRoot,
    envelope.sourceDigests,
  );
  return selectManifestView(hydrated, view);
}

/**
 * The source globs and selected sources a verified snapshot recorded, for a
 * caller that can re-run discovery (the producer plugin) to detect an added
 * or removed source. `undefined` for a snapshot serialized without
 * `projectRoot`.
 */
export function loadVerifiedSmrtGenerationSnapshotSourceSet(
  options: SmrtGenerationSnapshotOptions,
  projectRoot: string,
): SmrtGenerationSnapshotSourceSet | undefined {
  const { envelope } = readVerifiedEnvelope(options, projectRoot);
  const inputs = envelope.inputs;
  if (!inputs) return undefined;
  const sourceRoot = resolveSourceRoot(options.sourceRoot);
  return {
    projectRoot: fromPortable(
      sourceRoot,
      inputs.projectRoot || '.',
      'project root',
    ),
    include: inputs.include,
    exclude: inputs.exclude,
    followSymbolicLinks: inputs.followSymbolicLinks,
    sources: inputs.sources
      .map((portable) => fromPortable(sourceRoot, portable, 'source'))
      .sort(),
  };
}

/**
 * Fail unless `current` (a fresh discovery with the recorded globs) selects
 * exactly the sources the snapshot recorded: a source added since, or
 * removed, means the snapshot's manifest no longer describes the project.
 */
export function assertSmrtGenerationSnapshotSourceSet(
  recorded: SmrtGenerationSnapshotSourceSet,
  current: readonly string[],
): void {
  const expected = new Set(recorded.sources);
  const actual = new Set(current.map((file) => resolve(file)));
  const added = [...actual].filter((file) => !expected.has(file)).sort();
  const removed = [...expected].filter((file) => !actual.has(file)).sort();
  if (added.length === 0 && removed.length === 0) return;
  throw new Error(
    `[smrt] Generation snapshot source set changed under ${recorded.projectRoot}` +
      (added.length > 0 ? `; added: ${added.join(', ')}` : '') +
      (removed.length > 0 ? `; removed: ${removed.join(', ')}` : ''),
  );
}
