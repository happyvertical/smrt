/**
 * Comprehensive tests for ManifestBuilder
 * Tests file discovery, scanner configuration, external packages, and output generation
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestBuilder } from '../generator.js';

describe('ManifestBuilder', () => {
  // Use unique directories per test to avoid isolation issues
  let testFixturesDir: string;
  let testOutputDir: string;

  beforeEach(() => {
    // Create unique test fixtures directory for each test
    const uniqueId = randomUUID().slice(0, 8);
    testFixturesDir = resolve(
      __dirname,
      'fixtures',
      `generator-test-${uniqueId}`,
    );
    testOutputDir = resolve(testFixturesDir, 'output');

    // Create test fixtures directory
    mkdirSync(testFixturesDir, { recursive: true });
    mkdirSync(resolve(testFixturesDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    // Clean up test fixtures
    if (existsSync(testFixturesDir)) {
      rmSync(testFixturesDir, { recursive: true, force: true });
    }
  });

  describe('File Discovery', () => {
    it('should discover TypeScript files with default patterns', async () => {
      // Create test files
      writeFileSync(
        resolve(testFixturesDir, 'src', 'test.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class TestClass extends SmrtObject {
  name: string = '';
}
      `,
      );

      writeFileSync(
        resolve(testFixturesDir, 'src', 'test.d.ts'),
        'export type Test = string;',
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          exclude: ['src/**/*.d.ts'],
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        // Should find test.ts but not test.d.ts
        expect(manifest.objects).toBeDefined();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should respect custom include/exclude patterns', async () => {
      // Create test files in different directories
      mkdirSync(resolve(testFixturesDir, 'src', 'models'), {
        recursive: true,
      });
      writeFileSync(
        resolve(testFixturesDir, 'src', 'models', 'user.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class User extends SmrtObject {
  email: string = '';
}
      `,
      );

      mkdirSync(resolve(testFixturesDir, 'src', '__tests__'), {
        recursive: true,
      });
      writeFileSync(
        resolve(testFixturesDir, 'src', '__tests__', 'user.test.ts'),
        'import { describe } from "vitest";',
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          exclude: ['**/*.test.ts', '**/__tests__/**'],
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        // Should only find user.ts, not test file
        expect(Object.keys(manifest.objects).length).toBeGreaterThan(0);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should handle no files found gracefully', async () => {
      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['nonexistent/**/*.ts'],
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        expect(manifest.objects).toEqual({});
        expect(manifest.version).toBe('1.0.0');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('Scanner Configuration', () => {
    it('should use default baseClasses', async () => {
      writeFileSync(
        resolve(testFixturesDir, 'src', 'product.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class Product extends SmrtObject {
  name: string = '';
  price: number = 0.0;
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        // Should scan for default base classes
        expect(manifest.objects.product).toBeDefined();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should use custom baseClasses', async () => {
      writeFileSync(
        resolve(testFixturesDir, 'src', 'custom.ts'),
        `
import { SmrtClass, smrt } from '@happyvertical/smrt-core';

@smrt()
class CustomClass extends SmrtClass {
  data: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          baseClasses: ['CustomClass'],
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        expect(manifest.objects).toBeDefined();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should configure followImports', async () => {
      // Create a test file
      writeFileSync(
        resolve(testFixturesDir, 'src', 'test.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class TestClass extends SmrtObject {
  name: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        // Test with followImports: true
        await builder.generate({
          include: ['src/**/*.ts'],
          followImports: true,
          outputDir: testOutputDir,
          outputName: 'manifest-with-imports.json',
          generateTypeStub: false,
        });

        // Test with followImports: false
        await builder.generate({
          include: ['src/**/*.ts'],
          followImports: false,
          outputDir: testOutputDir,
          outputName: 'manifest-no-imports.json',
          generateTypeStub: false,
        });

        // Both should succeed with different configurations
        expect(
          existsSync(resolve(testOutputDir, 'manifest-with-imports.json')),
        ).toBe(true);
        expect(
          existsSync(resolve(testOutputDir, 'manifest-no-imports.json')),
        ).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('Manifest Creation', () => {
    it('should inject package info when requested', async () => {
      // Create package.json
      writeFileSync(
        resolve(testFixturesDir, 'package.json'),
        JSON.stringify({
          name: '@test/package',
          version: '1.0.0',
        }),
      );

      writeFileSync(
        resolve(testFixturesDir, 'src', 'item.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class Item extends SmrtObject {
  name: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          injectPackageInfo: true,
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        expect(manifest.packageName).toBe('@test/package');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should set moduleType', async () => {
      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          moduleType: 'smrt',
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        expect(manifest.moduleType).toBe('smrt');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should discover SMRT dependencies when requested', async () => {
      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          discoverExternalPackages: true,
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        expect(manifest.smrtDependencies).toBeInstanceOf(Array);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('Output Generation', () => {
    it('should write JSON manifest to specified location', async () => {
      writeFileSync(
        resolve(testFixturesDir, 'src', 'doc.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class Document extends SmrtObject {
  title: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        await builder.generate({
          include: ['src/**/*.ts'],
          outputDir: testOutputDir,
          outputName: 'test-manifest.json',
          generateTypeStub: false,
        });

        const manifestPath = resolve(testOutputDir, 'test-manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should generate TypeScript stub when requested', async () => {
      writeFileSync(
        resolve(testFixturesDir, 'src', 'article.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class Article extends SmrtObject {
  content: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        await builder.generate({
          include: ['src/**/*.ts'],
          outputDir: testOutputDir,
          outputName: 'manifest.json',
          generateTypeStub: true,
          stubName: 'manifest.ts',
        });

        expect(existsSync(resolve(testOutputDir, 'manifest.json'))).toBe(true);
        expect(existsSync(resolve(testOutputDir, 'manifest.ts'))).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should generate different stub names for test vs build manifests', async () => {
      // Create a test file
      writeFileSync(
        resolve(testFixturesDir, 'src', 'test.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class TestClass extends SmrtObject {
  name: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        // Build manifest
        await builder.generate({
          include: ['src/**/*.ts'],
          outputDir: testOutputDir,
          outputName: 'static-manifest.json',
          generateTypeStub: true,
          stubName: 'static-manifest.ts',
        });

        // Test manifest
        await builder.generate({
          include: ['src/**/*.ts'],
          outputDir: testOutputDir,
          outputName: 'test-manifest.json',
          generateTypeStub: true,
          stubName: 'test-manifest-stub.ts',
        });

        expect(existsSync(resolve(testOutputDir, 'static-manifest.ts'))).toBe(
          true,
        );
        expect(
          existsSync(resolve(testOutputDir, 'test-manifest-stub.ts')),
        ).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('Empty Manifest Handling', () => {
    it('should create valid empty manifest when no files found', async () => {
      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['nonexistent/**/*.ts'],
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        expect(manifest.version).toBe('1.0.0');
        expect(manifest.objects).toEqual({});
        expect(manifest.moduleType).toBe('smrt');
        expect(manifest.timestamp).toBeGreaterThan(0);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should include metadata in empty manifest', async () => {
      writeFileSync(
        resolve(testFixturesDir, 'package.json'),
        JSON.stringify({ name: '@test/empty' }),
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['nonexistent/**/*.ts'],
          injectPackageInfo: true,
          discoverExternalPackages: true,
          outputDir: testOutputDir,
          generateTypeStub: false,
        });

        expect(manifest.packageName).toBe('@test/empty');
        expect(manifest.smrtDependencies).toBeInstanceOf(Array);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle build manifest scenario', async () => {
      writeFileSync(
        resolve(testFixturesDir, 'package.json'),
        JSON.stringify({ name: '@test/build' }),
      );

      writeFileSync(
        resolve(testFixturesDir, 'src', 'model.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class Model extends SmrtObject {
  data: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          exclude: ['**/*.test.ts', '**/*.spec.ts'],
          baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
          followImports: false,
          loadViteConfig: false,
          discoverExternalPackages: true,
          includeExternalBaseClasses: false,
          outputDir: testOutputDir,
          outputName: 'static-manifest.json',
          generateTypeStub: true,
          stubName: 'static-manifest.ts',
          injectPackageInfo: true,
          moduleType: 'smrt',
        });

        expect(manifest.moduleType).toBe('smrt');
        expect(manifest.packageName).toBe('@test/build');
        expect(existsSync(resolve(testOutputDir, 'static-manifest.json'))).toBe(
          true,
        );
        expect(existsSync(resolve(testOutputDir, 'static-manifest.ts'))).toBe(
          true,
        );
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should handle test manifest scenario', async () => {
      writeFileSync(
        resolve(testFixturesDir, 'package.json'),
        JSON.stringify({ name: '@test/testing' }),
      );

      writeFileSync(
        resolve(testFixturesDir, 'src', 'test-class.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt()
class TestClass extends SmrtObject {
  name: string = '';
}
      `,
      );

      const builder = new ManifestBuilder();
      const originalCwd = process.cwd();

      try {
        process.chdir(testFixturesDir);

        const manifest = await builder.generate({
          include: ['src/**/*.ts'],
          exclude: ['**/*.d.ts', 'node_modules/**'],
          baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
          followImports: true,
          loadViteConfig: false, // Would be true in real scenario with vite.config.ts
          discoverExternalPackages: true,
          includeExternalBaseClasses: true,
          outputDir: testOutputDir,
          outputName: 'test-manifest.json',
          generateTypeStub: true,
          stubName: 'test-manifest-stub.ts',
          injectPackageInfo: true,
          moduleType: 'smrt',
        });

        expect(manifest.moduleType).toBe('smrt');
        expect(manifest.packageName).toBe('@test/testing');
        expect(existsSync(resolve(testOutputDir, 'test-manifest.json'))).toBe(
          true,
        );
        expect(
          existsSync(resolve(testOutputDir, 'test-manifest-stub.ts')),
        ).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
