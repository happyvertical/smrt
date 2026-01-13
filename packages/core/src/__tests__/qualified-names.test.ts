/**
 * Unit tests for qualified-names utilities
 *
 * Tests the functions that create, parse, and validate qualified class names
 * in the format "@package/name:ClassName"
 *
 * Related: Issue #713 - Qualified names for namespace isolation
 */

import { describe, expect, it } from 'vitest';
import {
  createQualifiedName,
  getClassName,
  getPackageFromQualifiedName,
  isFromPackage,
  isQualifiedName,
  parseQualifiedName,
  qualifiedNamesEqual,
} from '../utils/qualified-names';

describe('qualified-names utilities', () => {
  describe('createQualifiedName', () => {
    it('should create a qualified name from package and class', () => {
      const result = createQualifiedName('@happyvertical/smrt-core', 'Product');
      expect(result).toBe('@happyvertical/smrt-core:Product');
    });

    it('should handle scoped packages', () => {
      expect(createQualifiedName('@org/package', 'MyClass')).toBe(
        '@org/package:MyClass',
      );
    });

    it('should handle multi-part package names', () => {
      expect(
        createQualifiedName('@happyvertical/smrt-profiles', 'Person'),
      ).toBe('@happyvertical/smrt-profiles:Person');
    });

    it('should throw if packageName is empty', () => {
      expect(() => createQualifiedName('', 'Product')).toThrow(
        'packageName is required',
      );
    });

    it('should throw if className is empty', () => {
      expect(() => createQualifiedName('@happyvertical/smrt-core', '')).toThrow(
        'className is required',
      );
    });

    it('should throw if both are empty', () => {
      expect(() => createQualifiedName('', '')).toThrow(
        'packageName is required',
      );
    });
  });

  describe('parseQualifiedName', () => {
    it('should parse a valid qualified name', () => {
      const result = parseQualifiedName('@happyvertical/smrt-core:Product');
      expect(result).toEqual({
        packageName: '@happyvertical/smrt-core',
        className: 'Product',
      });
    });

    it('should handle various scoped package names', () => {
      expect(parseQualifiedName('@org/pkg:Class')).toEqual({
        packageName: '@org/pkg',
        className: 'Class',
      });

      expect(parseQualifiedName('@happyvertical/smrt-profiles:Person')).toEqual(
        {
          packageName: '@happyvertical/smrt-profiles',
          className: 'Person',
        },
      );
    });

    it('should use lastIndexOf for colon (defensive parsing)', () => {
      // Edge case: class name with colon (shouldn't happen but defensive)
      const result = parseQualifiedName('@pkg/name:Nested:Class');
      expect(result.packageName).toBe('@pkg/name:Nested');
      expect(result.className).toBe('Class');
    });

    it('should throw for non-qualified names', () => {
      expect(() => parseQualifiedName('Product')).toThrow(
        'Invalid qualified name',
      );
    });

    it('should throw for names without scope', () => {
      expect(() => parseQualifiedName('package:Product')).toThrow(
        'Invalid qualified name',
      );
    });

    it('should throw for names without slash', () => {
      expect(() => parseQualifiedName('@package:Product')).toThrow(
        'Invalid qualified name',
      );
    });
  });

  describe('isQualifiedName', () => {
    it('should return true for valid qualified names', () => {
      expect(isQualifiedName('@happyvertical/smrt-core:Product')).toBe(true);
      expect(isQualifiedName('@org/package:MyClass')).toBe(true);
      expect(isQualifiedName('@scope/name:X')).toBe(true);
    });

    it('should return false for simple class names', () => {
      expect(isQualifiedName('Product')).toBe(false);
      expect(isQualifiedName('MyClass')).toBe(false);
    });

    it('should return false for names without colon', () => {
      expect(isQualifiedName('@happyvertical/smrt-core')).toBe(false);
    });

    it('should return false for names without @ scope', () => {
      expect(isQualifiedName('happyvertical/smrt-core:Product')).toBe(false);
      expect(isQualifiedName('package:Class')).toBe(false);
    });

    it('should return false for names without slash', () => {
      expect(isQualifiedName('@package:Class')).toBe(false);
    });

    it('should return false for empty class name after colon', () => {
      expect(isQualifiedName('@happyvertical/smrt-core:')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isQualifiedName('')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isQualifiedName(null as any)).toBe(false);
      expect(isQualifiedName(undefined as any)).toBe(false);
    });

    it('should return false for non-string values', () => {
      expect(isQualifiedName(123 as any)).toBe(false);
      expect(isQualifiedName({} as any)).toBe(false);
    });
  });

  describe('getClassName', () => {
    it('should extract class name from qualified name', () => {
      expect(getClassName('@happyvertical/smrt-core:Product')).toBe('Product');
      expect(getClassName('@org/pkg:MyClass')).toBe('MyClass');
    });

    it('should return simple name unchanged', () => {
      expect(getClassName('Product')).toBe('Product');
      expect(getClassName('MyClass')).toBe('MyClass');
    });

    it('should handle edge cases', () => {
      expect(getClassName('X')).toBe('X');
      expect(getClassName('@a/b:C')).toBe('C');
    });
  });

  describe('getPackageFromQualifiedName', () => {
    it('should extract package from qualified name', () => {
      expect(
        getPackageFromQualifiedName('@happyvertical/smrt-core:Product'),
      ).toBe('@happyvertical/smrt-core');
    });

    it('should return undefined for simple names', () => {
      expect(getPackageFromQualifiedName('Product')).toBeUndefined();
      expect(getPackageFromQualifiedName('MyClass')).toBeUndefined();
    });

    it('should return undefined for invalid qualified names', () => {
      expect(getPackageFromQualifiedName('package:Class')).toBeUndefined();
      expect(getPackageFromQualifiedName('@package:Class')).toBeUndefined();
    });
  });

  describe('qualifiedNamesEqual', () => {
    it('should return true for equal names', () => {
      expect(
        qualifiedNamesEqual(
          '@happyvertical/smrt-core:Product',
          '@happyvertical/smrt-core:Product',
        ),
      ).toBe(true);
    });

    it('should return false for different names', () => {
      expect(
        qualifiedNamesEqual(
          '@happyvertical/smrt-core:Product',
          '@happyvertical/smrt-core:Order',
        ),
      ).toBe(false);
    });

    it('should return false for different packages', () => {
      expect(
        qualifiedNamesEqual(
          '@happyvertical/smrt-core:Product',
          '@happyvertical/smrt-profiles:Product',
        ),
      ).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(
        qualifiedNamesEqual(
          '@happyvertical/smrt-core:Product',
          '@happyvertical/smrt-core:product',
        ),
      ).toBe(false);
    });
  });

  describe('isFromPackage', () => {
    it('should return true when qualified name is from package', () => {
      expect(
        isFromPackage(
          '@happyvertical/smrt-core:Product',
          '@happyvertical/smrt-core',
        ),
      ).toBe(true);
    });

    it('should return false when qualified name is from different package', () => {
      expect(
        isFromPackage(
          '@happyvertical/smrt-core:Product',
          '@happyvertical/smrt-profiles',
        ),
      ).toBe(false);
    });

    it('should return false for simple class names', () => {
      expect(isFromPackage('Product', '@happyvertical/smrt-core')).toBe(false);
    });

    it('should return false for invalid qualified names', () => {
      expect(isFromPackage('package:Class', '@package')).toBe(false);
    });

    it('should be case-sensitive for package name', () => {
      expect(
        isFromPackage(
          '@happyvertical/smrt-core:Product',
          '@HAPPYVERTICAL/smrt-core',
        ),
      ).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('should round-trip through create and parse', () => {
      const packageName = '@happyvertical/smrt-core';
      const className = 'Product';

      const qualified = createQualifiedName(packageName, className);
      const parsed = parseQualifiedName(qualified);

      expect(parsed.packageName).toBe(packageName);
      expect(parsed.className).toBe(className);
    });

    it('should validate created qualified names', () => {
      const qualified = createQualifiedName('@org/pkg', 'MyClass');
      expect(isQualifiedName(qualified)).toBe(true);
    });
  });
});
