#!/usr/bin/env node
/**
 * Fail when a built package manifest holds an absolute `filePath` (#4948).
 *
 * A published manifest must not depend on the machine that built it. The
 * library build already refuses to write one (`stampedLibraryManifest`); this
 * check also catches a manifest that arrives some other way, such as a build
 * cache replay of output made in another checkout.
 *
 * Usage: node scripts/check-manifest-paths.mjs [repoRoot]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isAbsoluteManifestPath(path) {
  return (
    path.startsWith('/') ||
    path.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^file:/i.test(path)
  );
}

/** `{ manifest, class, filePath }` for each absolute path under `repoRoot`. */
export function findAbsoluteManifestPaths(repoRoot) {
  const packagesDir = join(repoRoot, 'packages');
  const found = [];
  for (const name of readdirSync(packagesDir).sort()) {
    const manifestPath = join(packagesDir, name, 'dist', 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [key, object] of Object.entries(manifest.objects ?? {})) {
      const filePath = object?.filePath;
      if (typeof filePath === 'string' && isAbsoluteManifestPath(filePath)) {
        found.push({ manifest: `packages/${name}/dist/manifest.json`, class: key, filePath });
      }
    }
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const found = findAbsoluteManifestPaths(root);
  if (found.length > 0) {
    const manifests = new Set(found.map((f) => f.manifest));
    console.error(
      `check-manifest-paths: ${found.length} absolute filePath value(s) in ${manifests.size} built manifest(s). ` +
        'A published manifest must use package-relative paths (#4948). Rebuild the listed packages.',
    );
    for (const f of found.slice(0, 20)) console.error(`  ${f.manifest}: ${f.class} -> ${f.filePath}`);
    if (found.length > 20) console.error(`  ... and ${found.length - 20} more`);
    process.exit(1);
  }
  console.log('check-manifest-paths: every built manifest uses package-relative filePath.');
}
