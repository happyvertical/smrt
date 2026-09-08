/**
 * Confined runtime bootstrap for the Level 2 observation plane (#1831).
 *
 * "Booting" here means registering *manifests* into the in-process
 * `ObjectRegistry` — the project's own `.smrt/manifest.json` (or built
 * `dist/manifest.json`) plus every installed SMRT package manifest that the
 * project's dependency tree resolves to. No project source is imported, no
 * module is executed, no database is touched. That confinement is the safety
 * boundary: an observing agent sees what the runtime *would* register, never
 * what arbitrary project code does on import.
 *
 * The registry is a process-global singleton, so a process boots once. There
 * is deliberately no re-boot tool; restart the process to observe a rebuilt
 * manifest.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  discoverSmrtPackages,
  resolveManifestPath,
} from '@happyvertical/smrt-core/manifest/discover-smrt-packages';

/** Provenance label for facts read from authored/installed manifests. */
export const DECLARED_PROVENANCE = 'declared (manifest)';

/** Project manifest candidates, most authoritative first. */
const PROJECT_MANIFEST_CANDIDATES = [
  '.smrt/manifest.json',
  'dist/manifest.json',
] as const;

export interface BootDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface BootedManifest {
  /** `project` for the project's own manifest, `dependency` for installed packages. */
  kind: 'project' | 'dependency';
  packageName: string | null;
  /** Path relative to the project root (never absolute). */
  path: string;
  objectCount: number;
}

export interface RuntimeBoot {
  provenance: typeof DECLARED_PROVENANCE;
  bootedAt: string;
  /** Basename only; the absolute project root never leaves the process. */
  projectName: string;
  manifests: BootedManifest[];
  objectCount: number;
  diagnostics: BootDiagnostic[];
}

interface ManifestLike {
  packageName?: unknown;
  moduleType?: unknown;
  objects?: Record<string, unknown>;
}

function relativePath(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);
  // Anything outside the root — the parent itself, a `..` walk, or a path on
  // another drive (Windows keeps those absolute) — is reduced to a basename.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return basename(path);
  }
  return rel.split(sep).join('/');
}

function readManifest(path: string): ManifestLike | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as ManifestLike)
      : null;
  } catch {
    return null;
  }
}

function registerManifest(
  manifest: ManifestLike,
  fallbackPackageName: string | null,
): number {
  const manifestPackageName =
    typeof manifest.packageName === 'string' && manifest.packageName
      ? manifest.packageName
      : (fallbackPackageName ?? undefined);
  let count = 0;
  for (const [name, definition] of Object.entries(manifest.objects ?? {})) {
    if (!definition || typeof definition !== 'object') continue;
    // An aggregate project manifest (consumer plugin output) carries
    // dependency objects that keep their own `packageName`; registering them
    // under the app's name would mint false `@app:Object` identities that
    // collide with the dependency's own manifest. Per-object ownership wins.
    const ownPackage = (definition as { packageName?: unknown }).packageName;
    ObjectRegistry.registerFromManifest(
      name,
      definition as Parameters<typeof ObjectRegistry.registerFromManifest>[1],
      typeof ownPackage === 'string' && ownPackage
        ? ownPackage
        : manifestPackageName,
    );
    count += 1;
  }
  return count;
}

let booted: RuntimeBoot | null = null;
let bootedProjectRoot: string | null = null;
let bootedProjectManifestPath: string | null = null;
let bootedProjectManifestMtimeMs: number | null = null;

/**
 * Whether the project manifest on disk is newer than the one this process
 * booted. The registry is process-global and boots once, so this is the only
 * signal an agent has that a rebuild happened underneath it.
 */
export function getBootStaleness(): {
  stale: boolean;
  bootedAt: string | null;
  manifestModifiedAt: string | null;
} {
  if (!booted || !bootedProjectManifestPath) {
    return {
      stale: false,
      bootedAt: booted?.bootedAt ?? null,
      manifestModifiedAt: null,
    };
  }
  try {
    const mtimeMs = statSync(bootedProjectManifestPath).mtimeMs;
    return {
      stale:
        bootedProjectManifestMtimeMs !== null &&
        mtimeMs > bootedProjectManifestMtimeMs,
      bootedAt: booted.bootedAt,
      manifestModifiedAt: new Date(mtimeMs).toISOString(),
    };
  } catch {
    return {
      stale: false,
      bootedAt: booted.bootedAt,
      manifestModifiedAt: null,
    };
  }
}

/** The boot record for this process, or `null` before {@link bootRuntime}. */
export function getRuntimeBoot(): RuntimeBoot | null {
  return booted;
}

/**
 * The resolved root the process booted from. Consumers must relativize
 * paths against *this* root, never a per-request argument, or a caller could
 * widen the root (e.g. `/`) and read the layout back through "relative" paths.
 */
export function getBootedProjectRoot(): string | null {
  return bootedProjectRoot;
}

/** Test seam: forget the boot record (the registry itself is cleared by the caller). */
export function resetRuntimeBootForTests(): void {
  booted = null;
  bootedProjectRoot = null;
  bootedProjectManifestPath = null;
  bootedProjectManifestMtimeMs = null;
}

export interface BootRuntimeOptions {
  projectRoot?: string;
  /** Clock for `bootedAt` (defaults to `new Date()`). */
  now?: Date;
}

/**
 * Boot the confined runtime once per process. A second call returns the
 * existing record without touching the registry.
 */
export async function bootRuntime(
  options: BootRuntimeOptions = {},
): Promise<RuntimeBoot> {
  if (booted) return booted;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const diagnostics: BootDiagnostic[] = [];
  const manifests: BootedManifest[] = [];

  const projectManifestPath = PROJECT_MANIFEST_CANDIDATES.map((candidate) =>
    join(projectRoot, candidate),
  ).find((path) => existsSync(path));
  const projectPackageName = readProjectPackageName(projectRoot);

  if (!projectManifestPath) {
    diagnostics.push({
      severity: 'warning',
      code: 'project_manifest_missing',
      message:
        'No project manifest found (.smrt/manifest.json or dist/manifest.json); run the project build so the runtime manifest exists.',
    });
  } else {
    const manifest = readManifest(projectManifestPath);
    if (!manifest) {
      diagnostics.push({
        severity: 'error',
        code: 'project_manifest_invalid',
        message: `Project manifest at ${relativePath(projectRoot, projectManifestPath)} is not valid JSON.`,
      });
    } else {
      manifests.push({
        kind: 'project',
        packageName:
          typeof manifest.packageName === 'string'
            ? manifest.packageName
            : projectPackageName,
        path: relativePath(projectRoot, projectManifestPath),
        objectCount: registerManifest(manifest, projectPackageName),
      });
    }
  }

  let dependencyNames: string[] = [];
  try {
    // `noCache` keeps discovery from writing `.smrt/discovery-cache.json`:
    // observing a project must never dirty it.
    dependencyNames = discoverSmrtPackages({
      baseDir: projectRoot,
      noCache: true,
    });
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'dependency_discovery_failed',
      message: `Installed SMRT package discovery failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    });
  }
  for (const dependency of dependencyNames.sort()) {
    const manifestPath = resolveManifestPath(dependency, projectRoot);
    if (!manifestPath) {
      diagnostics.push({
        severity: 'info',
        code: 'dependency_manifest_missing',
        message: `Installed SMRT package ${dependency} exposes no runtime manifest.`,
      });
      continue;
    }
    const manifest = readManifest(manifestPath);
    if (!manifest) {
      diagnostics.push({
        severity: 'warning',
        code: 'dependency_manifest_invalid',
        message: `Manifest for ${dependency} is not valid JSON.`,
      });
      continue;
    }
    manifests.push({
      kind: 'dependency',
      packageName: dependency,
      path: relativePath(projectRoot, manifestPath),
      objectCount: registerManifest(manifest, dependency),
    });
  }

  bootedProjectRoot = projectRoot;
  if (projectManifestPath) {
    bootedProjectManifestPath = projectManifestPath;
    try {
      bootedProjectManifestMtimeMs = statSync(projectManifestPath).mtimeMs;
    } catch {
      bootedProjectManifestMtimeMs = null;
    }
  }
  booted = {
    provenance: DECLARED_PROVENANCE,
    bootedAt: (options.now ?? new Date()).toISOString(),
    projectName: projectPackageName ?? basename(projectRoot),
    manifests,
    objectCount: manifests.reduce((sum, m) => sum + m.objectCount, 0),
    diagnostics,
  };
  return booted;
}

function readProjectPackageName(projectRoot: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}
