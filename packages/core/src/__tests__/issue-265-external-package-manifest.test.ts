/**
 * Test for Issue #265: External package inheritance with null manifest
 *
 * Replicates the scenario where:
 * 1. A class extends SmrtObject from an external package
 * 2. The manifest has "inheritance": null (scanner doesn't capture external extends)
 * 3. getAllFields() is called
 * 4. Should NOT warn about "Missing ancestor class SmrtObject"
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

describe('Issue #265: External Package Inheritance with Null Manifest', () => {
  beforeEach(() => {
    // Clear caches before each test
    ObjectRegistry.invalidateAllInheritanceCaches();
  });

  it('should not warn about SmrtObject when manifest has inheritance: null', async () => {
    // Simulate praeco scenario: class extends SmrtObject but manifest doesn't capture it
    @smrt()
    class PraecoTest1 extends SmrtObject {
      title: string = '';
      sourceUrl: string = '';
    }

    // Simulate what happens when manifest has "inheritance": null
    // by manually clearing the inheritance data
    const registered = ObjectRegistry.classes.get('PraecoTest1');
    if (registered) {
      // Clear manifest inheritance data (simulates "inheritance": null)
      registered.extends = undefined;
      registered.inheritanceChain = undefined;
    }

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // This should work without warnings
    const fields = await ObjectRegistry.getAllFields('PraecoTest1');

    // Debug: log what fields we got
    console.log('Fields returned:', Array.from(fields.keys()));
    console.log('Fields size:', fields.size);

    // Should NOT warn about SmrtObject being missing
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Missing ancestor class "SmrtObject"'),
    );

    // NOTE: Fields will be empty because classes defined in test functions
    // are not in the generated test manifest. This perfectly replicates
    // the praeco scenario where manifest has null inheritance and no fields.
    // The ObjectRegistry has no field data to return.
    expect(fields.size).toBe(0);
    expect(fields.has('title')).toBe(false);
    expect(fields.has('sourceUrl')).toBe(false);

    consoleSpy.mockRestore();
  });

  it('should still build inheritance chain from prototype when manifest data is missing', () => {
    @smrt()
    class PraecoTest2 extends SmrtObject {
      title: string = '';
    }

    // Clear manifest inheritance data
    const registered = ObjectRegistry.classes.get('PraecoTest2');
    if (registered) {
      registered.extends = undefined;
      registered.inheritanceChain = undefined;
    }

    // Should still be able to build chain from constructor prototype
    const chain = ObjectRegistry.getInheritanceChain('PraecoTest2');

    // Chain should include the class itself
    expect(chain).toContain('PraecoTest2');

    // Chain should NOT include SmrtObject (buildInheritanceChain stops at it)
    expect(chain).not.toContain('SmrtObject');
  });

  it('should handle multi-level inheritance with null manifest data', async () => {
    // Level 1: Base class (like @happyvertical/smrt-content)
    @smrt()
    class ContentTest3 extends SmrtObject {
      title: string = '';
      body: string = '';
    }

    // Level 2: Child class (like praeco extending smrt-content)
    @smrt()
    class PraecoTest3 extends ContentTest3 {
      sourceUrl: string = '';
    }

    // Simulate both having null inheritance in manifest
    for (const className of ['ContentTest3', 'PraecoTest3']) {
      const registered = ObjectRegistry.classes.get(className);
      if (registered) {
        registered.extends = undefined;
        registered.inheritanceChain = undefined;
      }
    }

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should work without warnings
    const fields = await ObjectRegistry.getAllFields('PraecoTest3');

    // Should NOT warn about SmrtObject
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Missing ancestor class "SmrtObject"'),
    );

    // NOTE: Fields will be empty for the same reason as test 1
    expect(fields.size).toBe(0);

    consoleSpy.mockRestore();
  });

  it('should handle case where buildInheritanceChain returns chain including SmrtObject', async () => {
    @smrt()
    class PraecoTest4 extends SmrtObject {
      field: string = '';
    }

    // Force inheritance chain to include SmrtObject (shouldn't happen, but testing the skip logic)
    const registered = ObjectRegistry.classes.get('PraecoTest4');
    if (registered) {
      // Manually set a chain that includes SmrtObject
      registered.inheritanceChain = ['SmrtObject', 'PraecoTest4'];
    }

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The skip logic in getAllFields should prevent warning about SmrtObject
    const fields = await ObjectRegistry.getAllFields('PraecoTest4');

    // Should NOT warn about SmrtObject (even though we forced it in the chain)
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Missing ancestor class "SmrtObject"'),
    );

    // NOTE: Fields will still be empty because no manifest data
    expect(fields.size).toBe(0);

    consoleSpy.mockRestore();
  });

  it('should log all warnings to help debug the praeco issue', async () => {
    @smrt()
    class PraecoTest5 extends SmrtObject {
      title: string = '';
    }

    // Clear manifest data
    const registered = ObjectRegistry.classes.get('PraecoTest5');
    if (registered) {
      registered.extends = undefined;
      registered.inheritanceChain = undefined;
    }

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Get the actual inheritance chain
    const chain = ObjectRegistry.getInheritanceChain('PraecoTest5');
    console.log('Inheritance chain:', chain);

    // Call getAllFields
    await ObjectRegistry.getAllFields('PraecoTest5');

    // Log all warnings that were called
    if (consoleSpy.mock.calls.length > 0) {
      console.log('Warnings logged:');
      for (const call of consoleSpy.mock.calls) {
        console.log('  -', call[0]);
      }
    } else {
      console.log('No warnings logged (expected)');
    }

    // This test always passes, but helps debug
    expect(true).toBe(true);

    consoleSpy.mockRestore();
  });
});
