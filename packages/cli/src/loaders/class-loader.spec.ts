import type { SmartObjectDefinition } from '@happyvertical/smrt-core/scanner';
import { beforeEach, describe, expect, it } from 'vitest';
import { DynamicClassLoader } from './class-loader.js';

describe('DynamicClassLoader', () => {
  let loader: DynamicClassLoader;

  beforeEach(() => {
    loader = new DynamicClassLoader({ verbose: false });
  });

  describe('loadClass', () => {
    it('should load class from @happyvertical/smrt-core', async () => {
      const objectDef: SmartObjectDefinition = {
        name: 'SmrtObject',
        className: 'SmrtObject',
        collection: 'smrtobjects',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      const { ObjectClass } = await loader.loadClass(objectDef);

      expect(ObjectClass).toBeDefined();
      expect(ObjectClass.name).toBe('SmrtObject');
    });

    it('should cache loaded modules', async () => {
      const objectDef: SmartObjectDefinition = {
        name: 'SmrtObject',
        className: 'SmrtObject',
        collection: 'smrtobjects',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      await loader.loadClass(objectDef);
      await loader.loadClass(objectDef); // Should use cache

      const stats = loader.getStats();
      expect(stats.modulesLoaded).toBe(1);
      expect(stats.classesCached).toBe(1);
    });

    it('should handle import failures gracefully', async () => {
      const invalidDef: SmartObjectDefinition = {
        name: 'Fake',
        className: 'Fake',
        collection: 'fakes',
        filePath: '',
        packageName: 'non-existent-package-12345',
        importPath: 'non-existent-package-12345',
        exportName: 'Fake',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      await expect(loader.loadClass(invalidDef)).rejects.toThrow(
        /Failed to load class Fake/,
      );
    });

    it('should load collection class if available', async () => {
      const objectDef: SmartObjectDefinition = {
        name: 'SmrtObject',
        className: 'SmrtObject',
        collection: 'smrtobjects',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
        collectionExportName: 'SmrtCollection',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      const { ObjectClass, CollectionClass } =
        await loader.loadClass(objectDef);

      expect(ObjectClass).toBeDefined();
      expect(CollectionClass).toBeDefined();
      expect(CollectionClass?.name).toBe('SmrtCollection');
    });

    it('should use default export if named export not found', async () => {
      // Test with a package that has default export
      const objectDef: SmartObjectDefinition = {
        name: 'Config',
        className: 'Config',
        collection: 'configs',
        filePath: '',
        packageName: '@happyvertical/smrt-config',
        importPath: '@happyvertical/smrt-config',
        exportName: 'NonExistent', // Named export doesn't exist
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      const { ObjectClass } = await loader.loadClass(objectDef);

      expect(ObjectClass).toBeDefined();
    });

    it('should throw error if neither named nor default export exists', async () => {
      const objectDef: SmartObjectDefinition = {
        name: 'Fake',
        className: 'Fake',
        collection: 'fakes',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        importPath: '@happyvertical/smrt-core',
        exportName: 'NonExistentClass',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      await expect(loader.loadClass(objectDef)).rejects.toThrow(
        /Failed to find export/,
      );
    });

    it('should use packageName as fallback if no importPath', async () => {
      const objectDef: SmartObjectDefinition = {
        name: 'SmrtObject',
        className: 'SmrtObject',
        collection: 'smrtobjects',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        // No importPath specified
        exportName: 'SmrtObject',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      const { ObjectClass } = await loader.loadClass(objectDef);

      expect(ObjectClass).toBeDefined();
    });

    it('should throw error if neither importPath nor packageName exists', async () => {
      const objectDef: SmartObjectDefinition = {
        name: 'Fake',
        className: 'Fake',
        collection: 'fakes',
        filePath: '',
        // No packageName or importPath
        exportName: 'Fake',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      await expect(loader.loadClass(objectDef)).rejects.toThrow(
        /Cannot determine import path/,
      );
    });
  });

  describe('loadAllFromManifest', () => {
    it('should load all classes from manifest', async () => {
      const manifest = {
        version: '1.0.0',
        timestamp: Date.now(),
        objects: {
          SmrtObject: {
            name: 'SmrtObject',
            className: 'SmrtObject',
            collection: 'smrtobjects',
            filePath: '',
            packageName: '@happyvertical/smrt-core',
            importPath: '@happyvertical/smrt-core',
            exportName: 'SmrtObject',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      };

      const loaded = await loader.loadAllFromManifest(manifest);

      expect(loaded.size).toBe(1);
      expect(loaded.has('SmrtObject')).toBe(true);
    });

    it('should skip objects that fail to load', async () => {
      const manifest = {
        version: '1.0.0',
        timestamp: Date.now(),
        objects: {
          Valid: {
            name: 'SmrtObject',
            className: 'SmrtObject',
            collection: 'smrtobjects',
            filePath: '',
            packageName: '@happyvertical/smrt-core',
            importPath: '@happyvertical/smrt-core',
            exportName: 'SmrtObject',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          Invalid: {
            name: 'Fake',
            className: 'Fake',
            collection: 'fakes',
            filePath: '',
            packageName: 'non-existent',
            importPath: 'non-existent',
            exportName: 'Fake',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      };

      const loaded = await loader.loadAllFromManifest(manifest);

      expect(loaded.size).toBe(1);
      expect(loaded.has('Valid')).toBe(true);
      expect(loaded.has('Invalid')).toBe(false);
    });

    it('should handle empty manifest', async () => {
      const manifest = {
        version: '1.0.0',
        timestamp: Date.now(),
        objects: {},
      };

      const loaded = await loader.loadAllFromManifest(manifest);

      expect(loaded.size).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('should clear all caches', async () => {
      const objectDef: SmartObjectDefinition = {
        name: 'SmrtObject',
        className: 'SmrtObject',
        collection: 'smrtobjects',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      await loader.loadClass(objectDef);

      expect(loader.getStats().classesCached).toBe(1);

      loader.clearCache();

      const stats = loader.getStats();
      expect(stats.modulesLoaded).toBe(0);
      expect(stats.classesCached).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      const objectDef1: SmartObjectDefinition = {
        name: 'SmrtObject',
        className: 'SmrtObject',
        collection: 'smrtobjects',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      const objectDef2: SmartObjectDefinition = {
        name: 'SmrtCollection',
        className: 'SmrtCollection',
        collection: 'smrtcollections',
        filePath: '',
        packageName: '@happyvertical/smrt-core',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtCollection',
        fields: {},
        methods: {},
        decoratorConfig: {},
      };

      await loader.loadClass(objectDef1);
      await loader.loadClass(objectDef2);

      const stats = loader.getStats();
      expect(stats.modulesLoaded).toBe(1); // Same module
      expect(stats.classesCached).toBe(2); // Different classes
    });
  });

  describe('verbose mode', () => {
    it('should log messages in verbose mode', async () => {
      const verboseLoader = new DynamicClassLoader({ verbose: true });

      // Capture console.log
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(' '));
      };

      try {
        const objectDef: SmartObjectDefinition = {
          name: 'SmrtObject',
          className: 'SmrtObject',
          collection: 'smrtobjects',
          filePath: '',
          packageName: '@happyvertical/smrt-core',
          importPath: '@happyvertical/smrt-core',
          exportName: 'SmrtObject',
          fields: {},
          methods: {},
          decoratorConfig: {},
        };

        await verboseLoader.loadClass(objectDef);

        expect(logs.some((log) => log.includes('[ClassLoader]'))).toBe(true);
      } finally {
        console.log = originalLog;
      }
    });
  });
});
