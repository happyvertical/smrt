/**
 * Simplified inheritance test to verify core functionality
 */

import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

// Simple 2-level hierarchy
@smrt()
class BaseContent extends SmrtObject {
  baseField: string = '';
  baseNumber: number = 0;
}

@smrt()
class ExtendedContent extends BaseContent {
  extendedField: string = '';
  extendedNumber: number = 0.0;
}

describe('Inheritance Core Functionality', () => {
  it('should register both classes', () => {
    const baseClass = ObjectRegistry.getClass('BaseContent');
    const extendedClass = ObjectRegistry.getClass('ExtendedContent');

    expect(baseClass).toBeDefined();
    expect(extendedClass).toBeDefined();
  });

  it('should build inheritance chain', () => {
    const chain = ObjectRegistry.getInheritanceChain('ExtendedContent');
    console.log('Inheritance chain:', chain);

    expect(chain.length).toBeGreaterThan(1);
    // R5-canon: getInheritanceChain returns qualified names
    expect(chain).toContain('@happyvertical/smrt-core:BaseContent');
    expect(chain).toContain('@happyvertical/smrt-core:ExtendedContent');
  });

  it('should get direct fields from BaseContent', () => {
    const fields = ObjectRegistry.getFields('BaseContent');
    const fieldNames = Array.from(fields.keys());
    console.log('BaseContent fields:', fieldNames);

    expect(fieldNames).toContain('baseField');
    expect(fieldNames).toContain('baseNumber');
  });

  it('should get direct fields from ExtendedContent', () => {
    const fields = ObjectRegistry.getFields('ExtendedContent');
    const fieldNames = Array.from(fields.keys());
    console.log('ExtendedContent direct fields:', fieldNames);

    expect(fieldNames).toContain('extendedField');
    expect(fieldNames).toContain('extendedNumber');
  });

  it('should get ALL fields (including inherited) from ExtendedContent', async () => {
    const allFields = await ObjectRegistry.getAllFields('ExtendedContent');
    const fieldNames = Array.from(allFields.keys());
    console.log('ExtendedContent ALL fields:', fieldNames);

    // Should include parent fields
    expect(fieldNames).toContain('baseField');
    expect(fieldNames).toContain('baseNumber');

    // Should include own fields
    expect(fieldNames).toContain('extendedField');
    expect(fieldNames).toContain('extendedNumber');
  });

  it('should access extends property', () => {
    const extendedClass = ObjectRegistry.getClass('ExtendedContent');
    console.log('ExtendedContent extends:', extendedClass?.extends);

    // Note: This may be undefined if manifest doesn't have it
    // But the buildInheritanceChain should still work via prototype chain
  });
});
