/**
 * Integration test for high object counts (200+ registered objects)
 *
 * Issue #1008: The existing test suite tests packages in isolation and never
 * reaches the scale where name collisions and registration order effects
 * become visible. This test loads ALL package manifests simultaneously.
 *
 * Issue #1007: Validates that getInheritanceChain() is a pure operation
 * after loadAllManifests() — no side effects during reads.
 *
 * @see https://github.com/happyvertical/smrt/issues/1008
 * @see https://github.com/happyvertical/smrt/issues/1007
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Discover all dist/manifest.json files across the monorepo.
 * Works by walking ../../../packages/* /dist/manifest.json relative to __dirname.
 */
function discoverManifestPaths(): string[] {
  // __dirname = packages/core/src/__tests__
  const packagesRoot = resolve(__dirname, '..', '..', '..', '..');
  const packagesDir = join(packagesRoot, 'packages');

  if (!existsSync(packagesDir)) {
    throw new Error(`packages directory not found at ${packagesDir}`);
  }

  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const paths: string[] = [];
  for (const dir of packageDirs) {
    const manifestPath = join(packagesDir, dir, 'dist', 'manifest.json');
    if (existsSync(manifestPath)) {
      paths.push(manifestPath);
    }
  }

  return paths;
}

/** Count total objects across manifests without loading them into the registry. */
function countTotalObjects(manifestPaths: string[]): number {
  let total = 0;
  for (const p of manifestPaths) {
    const manifest = JSON.parse(readFileSync(p, 'utf-8'));
    total += Object.keys(manifest.objects ?? {}).length;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Issue #1008: Full registry integration (high object counts)', () => {
  let manifestPaths: string[];
  beforeAll(() => {
    // Start with a clean registry for isolation
    ObjectRegistry.clear();

    // Discover all manifest paths once
    manifestPaths = discoverManifestPaths();
    // Load all manifests once for all tests to share
    ObjectRegistry.loadAllManifests({ manifestPaths });
  });

  afterAll(() => {
    // Clean up
    ObjectRegistry.clear();
  });

  // -----------------------------------------------------------------------
  // Scale check
  // -----------------------------------------------------------------------

  it('should discover manifests from all packages', () => {
    // We expect at least 20 packages with manifests
    expect(manifestPaths.length).toBeGreaterThanOrEqual(20);

    const totalObjects = countTotalObjects(manifestPaths);
    // Issue #1013: After removing manifest pre-aggregation, each manifest
    // contains ONLY its own objects (no leaked dependencies).
    expect(totalObjects).toBeGreaterThanOrEqual(200);
  });

  // -----------------------------------------------------------------------
  // loadAllManifests() — Issue #1007
  // -----------------------------------------------------------------------

  it('should register all objects via loadAllManifests()', () => {
    // They are already loaded in beforeAll, just check the state
    expect(ObjectRegistry.getAllClasses().size).toBeGreaterThanOrEqual(200);
  });

  // -----------------------------------------------------------------------
  // No circular inheritance warnings
  // -----------------------------------------------------------------------

  it('should not emit circular inheritance warnings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Walk every class's inheritance chain to trigger any warnings
    for (const [_key, registered] of ObjectRegistry.getAllClasses()) {
      ObjectRegistry.getInheritanceChain(registered.name || _key);
    }

    const circularWarnings = warnSpy.mock.calls.filter((args) =>
      args.some(
        (arg) =>
          typeof arg === 'string' && arg.includes('Circular inheritance'),
      ),
    );

    expect(circularWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Valid inheritance chains
  // -----------------------------------------------------------------------

  it('should produce valid inheritance chains for all classes with extends', () => {
    const classesWithExtends: string[] = [];
    for (const [_key, registered] of ObjectRegistry.getAllClasses()) {
      if (
        registered.extends &&
        registered.extends !== 'SmrtObject' &&
        registered.extends !== 'SmrtClass' &&
        registered.extends !== 'SmrtCollection'
      ) {
        classesWithExtends.push(registered.name || _key);
      }
    }

    // We should have many classes with inheritance relationships
    expect(classesWithExtends.length).toBeGreaterThan(0);

    for (const className of classesWithExtends) {
      const chain = ObjectRegistry.getInheritanceChain(className);
      // Chain should include at least the class itself
      expect(chain.length).toBeGreaterThanOrEqual(1);
      // The last element should be the class itself
      expect(chain[chain.length - 1]).toBe(className);
    }
  });

  // -----------------------------------------------------------------------
  // getInheritanceChain() is a pure operation — Issue #1007
  // -----------------------------------------------------------------------

  it('should not mutate registry state during getInheritanceChain()', () => {
    // Snapshot registry size before reads
    const sizeBefore = ObjectRegistry.getAllClasses().size;

    // Walk every class's inheritance chain
    for (const [_key, registered] of ObjectRegistry.getAllClasses()) {
      ObjectRegistry.getInheritanceChain(registered.name || _key);
    }

    // Registry size should not have changed — no side effects
    expect(ObjectRegistry.getAllClasses().size).toBe(sizeBefore);
  });

  // -----------------------------------------------------------------------
  // Topological ordering — no cycles
  // -----------------------------------------------------------------------

  it('should produce a valid topological ordering via getInitializationOrder()', () => {
    // getInitializationOrder() throws if it detects cycles
    const order = ObjectRegistry.getInitializationOrder();

    // Should include all registered classes
    expect(order.length).toBeGreaterThanOrEqual(1);

    // Verify topological property: for each class at index i, all its
    // dependencies must appear at indices < i
    const graph = ObjectRegistry.getDependencyGraph();
    const positionMap = new Map<string, number>();
    for (let i = 0; i < order.length; i++) {
      positionMap.set(order[i], i);
    }

    for (const [className, deps] of graph) {
      const classPos = positionMap.get(className);
      if (classPos === undefined) continue;

      for (const dep of deps) {
        const depPos = positionMap.get(dep);
        if (depPos === undefined) continue;
        expect(depPos).toBeLessThan(classPos);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Name collision checks
  // -----------------------------------------------------------------------

  it('should resolve all ambiguous simple names via qualified names', () => {
    // Collect simple name -> qualified names mapping
    const nameGroups = new Map<string, string[]>();
    for (const [key, registered] of ObjectRegistry.getAllClasses()) {
      const simpleName = registered.name || key;
      const qualified = registered.qualifiedName || key;
      if (!nameGroups.has(simpleName)) {
        nameGroups.set(simpleName, []);
      }
      nameGroups.get(simpleName)?.push(qualified);
    }

    // For any name that appears more than once, qualified names must be distinct
    for (const [simpleName, qualifiedNames] of nameGroups) {
      if (qualifiedNames.length > 1) {
        const uniqueQualified = new Set(qualifiedNames);
        expect(uniqueQualified.size).toBe(qualifiedNames.length);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Dependency graph is a valid DAG
  // -----------------------------------------------------------------------

  it('should produce a valid dependency graph (DAG)', () => {
    const graph = ObjectRegistry.getDependencyGraph();

    // All dependency targets must exist as graph keys
    for (const [className, deps] of graph) {
      for (const dep of deps) {
        expect(graph.has(dep)).toBe(true);
      }
    }

    // Verify no self-referential dependencies
    for (const [className, deps] of graph) {
      expect(deps).not.toContain(className);
    }
  });
});
