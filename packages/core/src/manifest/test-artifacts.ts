/**
 * The active test manifest: the test runner's immutable, per-run manifest
 * snapshot, kept apart from every production manifest path (#4128).
 *
 * @remarks
 * Test generation scans test-inclusive sources (inline `*.test.ts` fixture
 * classes need manifest metadata), so its output must never land on a path a
 * build, typecheck, CLI, or parity check also reads or writes:
 * `.smrt/manifest.json`, `dist/manifest.json` and `src/manifest/manifest.json`
 * belong to production generation. A test runner instead writes its snapshot
 * to a path it owns and publishes that path here, keyed by project root,
 * through {@link SMRT_TEST_MANIFEST_PATHS_ENV_KEY}. Test worker processes
 * inherit the variable from the runner, so every manifest read inside the run
 * (`LocalManifestReader.loadLocal()`, the runtime manifest loader, manifest
 * test databases) resolves the run's own snapshot first — a concurrent build
 * rewriting `.smrt/manifest.json` cannot change it. A process started without
 * the variable (a CLI, a build) never sees a test snapshot.
 *
 * Filesystem access is resolved lazily through `process.getBuiltinModule`, so
 * this module stays browser-safe (#2838): without a Node host only exact root
 * keys match.
 */

/**
 * `fs.realpathSync` on a Node host, resolved lazily like `node-host.ts` does.
 * Inlined rather than imported so this module stays a leaf: `store.ts` and the
 * loaders import it, and `node-host.ts` imports `store.ts`.
 */
function realpath(path: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  const getBuiltinModule = (
    process as typeof process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') return undefined;
  const fs = getBuiltinModule('node:fs') as
    | typeof import('node:fs')
    | undefined;
  return fs?.realpathSync(path);
}

/**
 * Environment variable mapping a project root to its active test manifest
 * path, as a JSON object (`{ "<root>": "<absolute manifest path>" }`).
 *
 * Process-global and inherited by child processes, so it is keyed by root:
 * a multi-project test run registers several roots without one replacing
 * another's entry.
 */
export const SMRT_TEST_MANIFEST_PATHS_ENV_KEY = '__SMRT_TEST_MANIFEST_PATHS__';

function readEnvMap(): Record<string, unknown> {
  if (typeof process === 'undefined' || !process.env) return {};
  const raw = process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    // An array would accept string keys but drop them on serialization.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed or foreign value carries no active snapshot.
  }
  return {};
}

/** Root keys for `projectRoot`: as given, without trailing separators, and realpath'd. */
function rootKeys(projectRoot: string): string[] {
  const keys = new Set<string>([projectRoot]);
  const trimmed = projectRoot.replace(/[/\\]+$/, '');
  if (trimmed) keys.add(trimmed);
  try {
    const real = realpath(projectRoot);
    if (real) keys.add(real);
  } catch {
    // A root that does not exist yet only matches by its literal key.
  }
  return [...keys];
}

/**
 * The active test manifest path registered for `projectRoot`, or `null` when
 * this process is not inside a test run that registered one.
 */
export function resolveActiveTestManifestPath(
  projectRoot: string,
): string | null {
  const byRoot = readEnvMap();
  for (const key of rootKeys(projectRoot)) {
    const value = byRoot[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Register `manifestPath` as the active test manifest for `projectRoot` in
 * this process and every child process started after the call. Other roots'
 * entries are preserved.
 */
export function registerActiveTestManifestPath(
  projectRoot: string,
  manifestPath: string,
): void {
  if (typeof process === 'undefined' || !process.env) return;
  const byRoot = readEnvMap();
  for (const key of rootKeys(projectRoot)) {
    byRoot[key] = manifestPath;
  }
  process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY] = JSON.stringify(byRoot);
}

/** Whether `manifest` is a test-generation artifact (`artifactPurpose: 'test'`). */
export function isTestArtifactManifest(manifest: unknown): boolean {
  return (
    !!manifest &&
    typeof manifest === 'object' &&
    (manifest as { artifactPurpose?: unknown }).artifactPurpose === 'test'
  );
}

/** Whether `manifestPath` is an active test manifest registered in this process. */
export function isActiveTestManifestPath(manifestPath: string): boolean {
  return Object.values(readEnvMap()).some((value) => value === manifestPath);
}

/**
 * Whether a manifest read from `manifestPath` must be refused (#2760): a
 * test-generation artifact is only ever valid as the active test manifest of
 * the run that registered it. Anywhere else — a stale `.smrt/manifest.json`
 * left by an older test runner, a copied or restored test manifest, or any
 * read by a process outside the run (CLI generation, `db:status --parity`,
 * generated servers, agent tooling) — its inline test-file fixtures would
 * surface as phantom domain objects.
 */
export function isRefusedTestArtifact(
  manifest: unknown,
  manifestPath: string,
): boolean {
  return (
    isTestArtifactManifest(manifest) && !isActiveTestManifestPath(manifestPath)
  );
}
