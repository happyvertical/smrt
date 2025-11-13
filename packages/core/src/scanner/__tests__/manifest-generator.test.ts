import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../manifest-generator';
import type { ScanResult, SmartObjectDefinition } from '../types';

describe('ManifestGenerator', () => {
  describe('class name collision detection', () => {
    it('should throw an error when duplicate class names are found', () => {
      const generator = new ManifestGenerator();

      const objectDef1: SmartObjectDefinition = {
        name: 'product',
        className: 'Product',
        collection: 'products',
        filePath: '/path/to/file1.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Product',
        collectionExportName: 'ProductCollection',
      };

      const objectDef2: SmartObjectDefinition = {
        name: 'product',
        className: 'Product',
        collection: 'products',
        filePath: '/path/to/file2.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Product',
        collectionExportName: 'ProductCollection',
      };

      const scanResults: ScanResult[] = [
        {
          filePath: '/path/to/file1.ts',
          objects: [objectDef1],
          imports: [],
          exports: [],
        },
        {
          filePath: '/path/to/file2.ts',
          objects: [objectDef2],
          imports: [],
          exports: [],
        },
      ];

      expect(() => generator.generateManifest(scanResults)).toThrow(
        /Class name collision detected: 'Product' is defined in multiple files/,
      );
    });

    it('should not throw when all class names are unique', () => {
      const generator = new ManifestGenerator();

      const objectDef1: SmartObjectDefinition = {
        name: 'product',
        className: 'Product',
        collection: 'products',
        filePath: '/path/to/file1.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Product',
        collectionExportName: 'ProductCollection',
      };

      const objectDef2: SmartObjectDefinition = {
        name: 'category',
        className: 'Category',
        collection: 'categories',
        filePath: '/path/to/file2.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Category',
        collectionExportName: 'CategoryCollection',
      };

      const scanResults: ScanResult[] = [
        {
          filePath: '/path/to/file1.ts',
          objects: [objectDef1],
          imports: [],
          exports: [],
        },
        {
          filePath: '/path/to/file2.ts',
          objects: [objectDef2],
          imports: [],
          exports: [],
        },
      ];

      expect(() => generator.generateManifest(scanResults)).not.toThrow();
    });
  });
});
