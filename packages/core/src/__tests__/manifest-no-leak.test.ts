/**
 * Manifest Leak Detection Test (Issue #1013)
 *
 * Validates that every dist/manifest.json across the monorepo
 * contains ONLY objects defined within that specific package.
 * No dependency objects should leak into package manifests.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Find the monorepo root by walking up from cwd looking for turbo.json
 */
function findMonorepoRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, 'turbo.json'))) {
      return dir;
    }
    dir = join(dir, '..');
  }
  throw new Error('Could not find monorepo root (turbo.json)');
}

/**
 * Discover all dist/manifest.json files in the monorepo
 */
function discoverManifestPaths(root: string): string[] {
  try {
    const output = execSync(
      'find packages -name "manifest.json" -path "*/dist/*" -not -path "*/node_modules/*"',
      { cwd: root, encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((p) => join(root, p));
  } catch {
    return [];
  }
}

describe('Manifest Leak Detection (Issue #1013)', () => {
  const root = findMonorepoRoot();
  const manifestPaths = discoverManifestPaths(root);

  it('should find at least one dist/manifest.json', () => {
    expect(manifestPaths.length).toBeGreaterThan(0);
  });

  // Generate a test case for each discovered manifest
  for (const manifestPath of manifestPaths) {
    const relativePath = manifestPath.replace(`${root}/`, '');

    it(`${relativePath} should contain no leaked objects`, () => {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      const packageName = manifest.packageName;

      // Skip manifests without packageName (shouldn't happen but be safe)
      if (!packageName) {
        console.warn(`  [warn] ${relativePath} has no packageName, skipping`);
        return;
      }

      const objects = manifest.objects || {};
      const leaked: string[] = [];

      for (const [key, obj] of Object.entries(objects)) {
        const objPackage = (obj as any).packageName;
        if (objPackage && objPackage !== packageName) {
          leaked.push(`${key} (from ${objPackage})`);
        }
      }

      if (leaked.length > 0) {
        const total = Object.keys(objects).length;
        const leakedPct = ((leaked.length / total) * 100).toFixed(0);
        expect.fail(
          `${packageName}: ${leaked.length}/${total} objects (${leakedPct}%) are from other packages:\n` +
            leaked
              .slice(0, 10)
              .map((l) => `  - ${l}`)
              .join('\n') +
            (leaked.length > 10
              ? `\n  ... and ${leaked.length - 10} more`
              : ''),
        );
      }
    });
  }

  it('should have smrtDependencies as references (not embedded objects)', () => {
    for (const manifestPath of manifestPaths) {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      const deps = manifest.smrtDependencies || [];
      const objects = manifest.objects || {};

      // If the manifest has smrtDependencies, none of those packages'
      // objects should be embedded in the manifest
      for (const dep of deps) {
        for (const obj of Object.values(objects)) {
          if ((obj as any).packageName === dep) {
            expect.fail(
              `${manifest.packageName}: Object from dependency ${dep} is embedded in manifest. ` +
                `Dependencies should be referenced via smrtDependencies, not embedded.`,
            );
          }
        }
      }
    }
  });
});
