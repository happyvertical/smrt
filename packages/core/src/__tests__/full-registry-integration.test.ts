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
    // R5-canon (commit f19552c0c): getInheritanceChain() entries are QUALIFIED
    // names (`@package/name:ClassName`) whenever the registration has one, so
    // the chain is unambiguous across packages with same-simple-name classes.
    // Look the class up by qualified name and assert the chain terminates with
    // that same qualified name (the class itself).
    const classesWithExtends: Array<{
      lookupKey: string;
      expectedSelf: string;
    }> = [];
    for (const [key, registered] of ObjectRegistry.getAllClasses()) {
      if (
        registered.extends &&
        registered.extends !== 'SmrtObject' &&
        registered.extends !== 'SmrtClass' &&
        registered.extends !== 'SmrtCollection'
      ) {
        const lookupKey = registered.qualifiedName || registered.name || key;
        classesWithExtends.push({ lookupKey, expectedSelf: lookupKey });
      }
    }

    // We should have many classes with inheritance relationships
    expect(classesWithExtends.length).toBeGreaterThan(0);

    for (const { lookupKey, expectedSelf } of classesWithExtends) {
      const chain = ObjectRegistry.getInheritanceChain(lookupKey);
      // Chain should include at least the class itself
      expect(chain.length).toBeGreaterThanOrEqual(1);
      // The last element is the class itself, emitted as its qualified name.
      expect(chain[chain.length - 1]).toBe(expectedSelf);
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
    // #1334 (commit 78b1340fd): getInitializationOrder() tolerates genuine
    // foreign-key cycles by BREAKING them instead of throwing. SMRT emits no
    // DB-level FOREIGN KEY constraints, so a cyclic pair has no valid strict
    // linear order and needs none. The canonical case is smrt-chat:
    // ChatMessage.threadId -> ChatThread and ChatThread.rootMessageId ->
    // ChatMessage form a 2-cycle. A broken cycle's back-edge unavoidably
    // violates strict topological order, so a blanket `depPos < classPos`
    // assertion over ALL edges is invalid for cyclic graphs.
    //
    // The correct, stronger-than-blanket property: strict topological order
    // holds for every ACYCLIC dependency edge; only edges whose endpoints are
    // mutually reachable (i.e. part of a cycle) are exempt.
    const order = ObjectRegistry.getInitializationOrder();

    // Should include all registered classes, exactly once each.
    expect(order.length).toBeGreaterThanOrEqual(1);
    expect(new Set(order).size).toBe(order.length);

    const graph = ObjectRegistry.getDependencyGraph();
    const positionMap = new Map<string, number>();
    for (let i = 0; i < order.length; i++) {
      positionMap.set(order[i], i);
    }

    // Every class in the dependency graph must appear in the ordering — the
    // cycle-breaker must not drop a node.
    for (const className of graph.keys()) {
      expect(positionMap.has(className)).toBe(true);
    }

    // Is `target` reachable from `start` by following dependency edges?
    // Used to detect cycle participation: an edge dep -> className is a cycle
    // back-edge iff className is also reachable from dep.
    const isReachable = (start: string, target: string): boolean => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const node = stack.pop() as string;
        for (const next of graph.get(node) ?? []) {
          if (next === target) return true;
          if (graph.has(next) && !seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      return false;
    };

    // Track that we actually exercised both branches so the test stays
    // meaningful: at least one strict acyclic edge must be checked, and the
    // exemption only fires for genuine cycle back-edges.
    let acyclicEdgesChecked = 0;
    const exemptCycleEdges: string[] = [];

    for (const [className, deps] of graph) {
      const classPos = positionMap.get(className);
      if (classPos === undefined) continue;

      for (const dep of deps) {
        const depPos = positionMap.get(dep);
        if (depPos === undefined) continue;

        // dep -> className participates in a cycle when className can also
        // reach dep. Such a back-edge is expected to violate strict order.
        if (isReachable(dep, className)) {
          exemptCycleEdges.push(`${dep} -> ${className}`);
          continue;
        }

        // Acyclic dependency: strict topological order MUST hold.
        expect(depPos).toBeLessThan(classPos);
        acyclicEdgesChecked++;
      }
    }

    // The assertion is not vacuous: the vast majority of edges are acyclic.
    expect(acyclicEdgesChecked).toBeGreaterThan(0);

    // Only genuine cycle members may be exempt. In the current monorepo the
    // sole foreign-key cycle is smrt-chat's ChatMessage <-> ChatThread pair,
    // so every exempt edge must be between those two classes.
    for (const edge of exemptCycleEdges) {
      expect(
        edge === 'ChatMessage -> ChatThread' ||
          edge === 'ChatThread -> ChatMessage',
      ).toBe(true);
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
