/**
 * The consumer-shaped probe (#2975, from #2970): with smrt-vitest's setup
 * already holding the app's aggregated manifest, import the app's generated
 * `.smrt/register.js` and resolve schemas. Neither model is imported
 * directly; both must reach the registry through manifest registration.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';

const only = (className: string) =>
  ObjectRegistry.getQualifiedClassNames().filter((name) =>
    name.endsWith(`:${className}`),
  );

describe('release consumer canary', () => {
  it('keeps every class under its declaring package and resolves schemas', async () => {
    const registerModule: string = '../.smrt/register.js';
    await import(registerModule);

    // Framework base and consumed-package model: one entry each, under the
    // package that declares them — never under this app's package (#2970).
    expect(only('SmrtHierarchical')).toEqual([
      '@happyvertical/smrt-core:SmrtHierarchical',
    ]);
    expect(only('Tag')).toEqual(['@happyvertical/smrt-tags:Tag']);
    // The app's own model keeps the app's package.
    expect(only('TreeNode')).toEqual([
      '@smrt-canary/release-consumer:TreeNode',
    ]);

    const tables = Object.keys(ObjectRegistry.getAllSchemasAsDefinitions());
    expect(tables).toContain('tags');
    expect(tables).toContain('tree_nodes');
  });
});
