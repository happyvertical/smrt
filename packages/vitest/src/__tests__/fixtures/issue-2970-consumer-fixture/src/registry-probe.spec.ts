/**
 * Reproducer/regression probe for issue #2970.
 *
 * Mirrors the downstream failure: a test that dynamically imports its own
 * generated `.smrt/register.js` inside a process where `smrt-vitest` has
 * already loaded package manifests, then asks the registry for schemas.
 *
 * Deliberately does NOT import `./models/tree-node.ts`; the model must reach
 * `ObjectRegistry` only through manifest registration.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';

describe('issue #2970 aggregated-manifest attribution probe', () => {
  it('imports the generated register.js and still resolves schemas', async () => {
    await import('../.smrt/register.js');

    const qualified = ObjectRegistry.getQualifiedClassNames();
    const hierarchical = qualified.filter((name) =>
      name.endsWith(':SmrtHierarchical'),
    );

    // The framework base is declared by smrt-core and by nothing else, so it
    // must appear exactly once and under its own package — never under this
    // fixture's package, which declares no class of that name.
    expect(hierarchical).toEqual(['@happyvertical/smrt-core:SmrtHierarchical']);

    // The consumer's own class in the same aggregate keeps ITS package, once.
    expect(qualified.filter((name) => name.endsWith(':TreeNode'))).toEqual([
      '@smrt-fixtures/issue-2970-consumer:TreeNode',
    ]);

    // Simple-name resolution must stay unambiguous for it, and the reported
    // failing surface must complete.
    expect(() => ObjectRegistry.resolveType('SmrtHierarchical')).not.toThrow();
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
  });
});
