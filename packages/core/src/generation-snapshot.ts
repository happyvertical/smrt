import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
    if (!isAbsolute(candidate.filePath)) {
      if (isProjectDefinition) {
        throw new Error(
          `[smrt] Generation snapshot cannot normalize relative project source path: ${candidate.filePath}`,
        );
      }
      continue;
    }
    if (!isInsideRoot(sourceRoot, candidate.filePath)) {
      if (isProjectDefinition) {
        throw new Error(
          `[smrt] Generation snapshot project source path is outside sourceRoot: ${candidate.filePath}`,
        );
      }
      continue;
    }

    const relativePath = relative(sourceRoot, candidate.filePath).replace(
      /\\/g,
      '/',
    );
    sourceDigests.set(
      relativePath,
      sha256SmrtGenerationSnapshot(readFileSync(candidate.filePath)),
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
    const expectedSourceDigest = sourceDigests[relativePath];
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

  const objects = Object.fromEntries(
    Object.entries(typed.objects).filter(([, definition]) => {
      const owner = definition.packageName;
      const isProject = owner === undefined || owner === typed.packageName;
      return view === 'project' ? isProject : !isProject;
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
  const { manifest: portableManifest, sourceDigests } = normalizeManifestPaths(
    manifest,
    resolve(options.sourceRoot),
  );
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      provenance,
      pathMode: 'source-root-relative',
      sourceDigests,
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
 * Load and verify a generation snapshot without mutating the artifact or project.
 */
export function loadVerifiedSmrtGenerationSnapshot<TManifest>(
  options: SmrtGenerationSnapshotOptions,
  projectRoot: string,
  view: SmrtGenerationSnapshotView = 'all',
): TManifest {
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

  const hydrated = hydrateManifestPaths(
    envelope.manifest as TManifest,
    options.sourceRoot,
    envelope.sourceDigests,
  );
  return selectManifestView(hydrated, view);
}
