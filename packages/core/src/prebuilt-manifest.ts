import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Immutable manifest artifact consumed by SMRT's Vite plugins.
 *
 * `provenance` is caller-defined source identity (normally the exact git tree
 * or commit). Consumers must provide the identity they expect; the loader does
 * not trust the artifact to identify itself.
 */
export interface SmrtPrebuiltManifestArtifact<TManifest> {
  schemaVersion: 1;
  provenance: string;
  manifest: TManifest;
}

/** Fail-closed input used by `smrtPlugin()` and `smrtConsumer()`. */
export interface SmrtPrebuiltManifestOptions {
  /** Artifact path, absolute or relative to the plugin's project root. */
  path: string;
  /** SHA-256 of the exact artifact bytes, formatted as `sha256:<hex>`. */
  sha256: string;
  /** Expected source identity, matched exactly against artifact provenance. */
  provenance: string;
}

/** Serialize a deterministic artifact whose returned bytes can be hashed. */
export function serializeSmrtPrebuiltManifest<TManifest>(
  manifest: TManifest,
  provenance: string,
): string {
  if (!provenance.trim()) {
    throw new Error('[smrt] Prebuilt manifest provenance must not be empty');
  }
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      provenance,
      manifest,
    } satisfies SmrtPrebuiltManifestArtifact<TManifest>,
    null,
    2,
  )}\n`;
}

/** Return the digest format accepted by `SmrtPrebuiltManifestOptions`. */
export function sha256SmrtPrebuiltManifest(
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
 * Load and verify a prebuilt manifest without mutating the artifact or project.
 */
export function loadVerifiedSmrtPrebuiltManifest<TManifest>(
  options: SmrtPrebuiltManifestOptions,
  projectRoot: string,
): TManifest {
  if (!/^sha256:[a-f0-9]{64}$/.test(options.sha256)) {
    throw new Error(
      '[smrt] Prebuilt manifest sha256 must use sha256:<64 lowercase hex characters>',
    );
  }
  if (!options.provenance.trim()) {
    throw new Error('[smrt] Expected prebuilt manifest provenance is required');
  }

  const artifactPath = isAbsolute(options.path)
    ? options.path
    : resolve(projectRoot, options.path);

  let contents: Buffer;
  try {
    contents = readFileSync(artifactPath);
  } catch (error) {
    throw new Error(
      `[smrt] Unable to read prebuilt manifest artifact at ${artifactPath}`,
      { cause: error },
    );
  }

  const actualDigest = sha256SmrtPrebuiltManifest(contents);
  if (actualDigest !== options.sha256) {
    throw new Error(
      `[smrt] Prebuilt manifest digest mismatch at ${artifactPath}: expected ${options.sha256}, received ${actualDigest}`,
    );
  }

  let artifact: unknown;
  try {
    artifact = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(
      `[smrt] Prebuilt manifest artifact at ${artifactPath} is not valid JSON`,
      { cause: error },
    );
  }

  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(
      `[smrt] Invalid prebuilt manifest artifact at ${artifactPath}`,
    );
  }
  const envelope = artifact as Partial<SmrtPrebuiltManifestArtifact<unknown>>;
  if (envelope.schemaVersion !== 1) {
    throw new Error(
      `[smrt] Unsupported prebuilt manifest schema at ${artifactPath}`,
    );
  }
  if (envelope.provenance !== options.provenance) {
    throw new Error(
      `[smrt] Prebuilt manifest provenance mismatch at ${artifactPath}`,
    );
  }
  if (!isManifest(envelope.manifest)) {
    throw new Error(
      `[smrt] Prebuilt manifest artifact at ${artifactPath} does not contain a valid manifest`,
    );
  }

  return envelope.manifest as TManifest;
}
