/**
 * Unit Tests for introspect-project Tool
 * Tests project scanning, SMRT object discovery, and analysis
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { introspectProject } from './introspect-project.js';

describe('introspectProject', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Create temp directory for test project
    tmpDir = join(tmpdir(), `smrt-introspect-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Project Scanning', () => {
    it('should scan directory for SMRT objects', async () => {
      // Create test file
      await writeFile(
        join(tmpDir, 'product.ts'),
        `
import { SmrtObject, smrt, field, foreignKey, oneToMany, manyToMany } from '@happyvertical/smrt-core';

@smrt()
export class Product extends SmrtObject {
  @field({ required: true })
  name: string = '';

  @field({ min: 0 })
  price: number = 0.0;
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
        includeRelationships: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(1);
      expect(parsed.objects[0].className).toBe('Product');
      expect(parsed.objects[0].filePath).toContain('product.ts');
    });

    it('should find SMRT objects in nested directories', async () => {
      // Create nested structure
      await mkdir(join(tmpDir, 'models'), { recursive: true });
      await mkdir(join(tmpDir, 'models', 'products'), { recursive: true });

      await writeFile(
        join(tmpDir, 'models', 'products', 'product.ts'),
        `
import { SmrtObject, smrt, field, foreignKey, oneToMany, manyToMany } from '@happyvertical/smrt-core';

@smrt()
export class Product extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
        includeRelationships: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(1);
      expect(parsed.objects[0].filePath).toContain(
        'models/products/product.ts',
      );
    });

    it('should skip node_modules directory', async () => {
      await mkdir(join(tmpDir, 'node_modules'), { recursive: true });

      await writeFile(
        join(tmpDir, 'node_modules', 'fake-package.ts'),
        `
@smrt()
export class FakePackage extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(0);
    });

    it('should skip dist and .git directories', async () => {
      await mkdir(join(tmpDir, 'dist'), { recursive: true });
      await mkdir(join(tmpDir, '.git'), { recursive: true });

      await writeFile(
        join(tmpDir, 'dist', 'compiled.ts'),
        `@smrt() export class Compiled extends SmrtObject {}`,
      );

      await writeFile(
        join(tmpDir, '.git', 'config.ts'),
        `@smrt() export class GitConfig extends SmrtObject {}`,
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(0);
    });

    it('should skip test files', async () => {
      await writeFile(
        join(tmpDir, 'product.test.ts'),
        `
@smrt()
export class ProductTest extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      await writeFile(
        join(tmpDir, 'product.spec.ts'),
        `
@smrt()
export class ProductSpec extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(0);
    });

    it('should skip declaration files', async () => {
      await writeFile(
        join(tmpDir, 'types.d.ts'),
        `
@smrt()
export class Types extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(0);
    });
  });

  describe('Field Extraction', () => {
    it('should extract field definitions when enabled', async () => {
      await writeFile(
        join(tmpDir, 'model.ts'),
        `
import { SmrtObject, smrt, field, foreignKey, oneToMany, manyToMany } from '@happyvertical/smrt-core';

@smrt()
export class Model extends SmrtObject {
  name: string = '';
  count: number = 0;
  active: boolean = false;
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].fields).toContain('name: text');
      expect(parsed.objects[0].fields).toContain('count: integer');
      expect(parsed.objects[0].fields).toContain('active: boolean');
    });

    it('should not extract fields when disabled', async () => {
      await writeFile(
        join(tmpDir, 'model.ts'),
        `
@smrt()
export class Model extends SmrtObject {
  name: string = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: false,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0]).not.toHaveProperty('fields');
    });
  });

  describe('Method Extraction', () => {
    it('should extract method definitions', async () => {
      await writeFile(
        join(tmpDir, 'model.ts'),
        `
@smrt()
export class Model extends SmrtObject {
  name = '';

  async analyze(options: any) {
    return { results: [] };
  }

  summarize() {
    return 'summary';
  }
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].methods).toContain('async analyze()');
      expect(parsed.objects[0].methods).toContain('summarize()');
    });

    it('should skip constructor method', async () => {
      await writeFile(
        join(tmpDir, 'model.ts'),
        `
@smrt()
export class Model extends SmrtObject {
  constructor(options: any) {
    super(options);
  }

  async analyze() {
    return {};
  }
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].methods).not.toContain('constructor()');
      expect(parsed.objects[0].methods).toContain('async analyze()');
    });
  });

  describe('Relationship Extraction', () => {
    it('should extract foreignKey relationships when enabled', async () => {
      await writeFile(
        join(tmpDir, 'order.ts'),
        `
import { SmrtObject, smrt, field, foreignKey, oneToMany, manyToMany } from '@happyvertical/smrt-core';
import { Customer } from './customer';

@smrt()
export class Order extends SmrtObject {
  @foreignKey(Customer)
  customerId: string = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeRelationships: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].relationships).toContain(
        'customerId -> Customer (foreignKey)',
      );
    });

    it('should extract oneToMany relationships', async () => {
      await writeFile(
        join(tmpDir, 'author.ts'),
        `
@smrt()
export class Author extends SmrtObject {
  @oneToMany(Article)
  articles: Article[] = [];
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeRelationships: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].relationships).toContain(
        'articles -> Article (oneToMany)',
      );
    });

    it('should extract manyToMany relationships', async () => {
      await writeFile(
        join(tmpDir, 'student.ts'),
        `
@smrt()
export class Student extends SmrtObject {
  @manyToMany(Course)
  courses: Course[] = [];
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeRelationships: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].relationships).toContain(
        'courses -> Course (manyToMany)',
      );
    });

    it('should not extract relationships when disabled', async () => {
      await writeFile(
        join(tmpDir, 'order.ts'),
        `
@smrt()
export class Order extends SmrtObject {
  @foreignKey(Customer)
  customerId: string = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeRelationships: false,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0]).not.toHaveProperty('relationships');
    });
  });

  describe('Base Class Detection', () => {
    it('should detect SmrtObject base class', async () => {
      await writeFile(
        join(tmpDir, 'model.ts'),
        `
@smrt()
export class Model extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].className).toBe('Model');
    });

    it('should detect SmrtCollection base class', async () => {
      await writeFile(
        join(tmpDir, 'collection.ts'),
        `
@smrt()
export class MyCollection extends SmrtCollection {
  static readonly _itemClass = MyItem;
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].className).toBe('MyCollection');
    });

    it('should ignore classes not extending SMRT base classes', async () => {
      await writeFile(
        join(tmpDir, 'regular.ts'),
        `
export class RegularClass {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(0);
    });
  });

  describe('Decorator Configuration', () => {
    it('should detect decorator configuration', async () => {
      await writeFile(
        join(tmpDir, 'configured.ts'),
        `
@smrt({
  api: { include: ['list', 'get'] },
  mcp: { include: ['list'] }
})
export class Configured extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].decoratorConfig).toBeDefined();
    });

    it('should handle empty decorator', async () => {
      await writeFile(
        join(tmpDir, 'empty-decorator.ts'),
        `
@smrt()
export class EmptyDecorator extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(1);
    });
  });

  describe('Multiple Files', () => {
    it('should find multiple SMRT objects across files', async () => {
      await writeFile(
        join(tmpDir, 'product.ts'),
        `
@smrt()
export class Product extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      await writeFile(
        join(tmpDir, 'category.ts'),
        `
@smrt()
export class Category extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(2);

      const classNames = parsed.objects.map((obj: any) => obj.className);
      expect(classNames).toContain('Product');
      expect(classNames).toContain('Category');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing directory gracefully', async () => {
      const nonexistent = join(tmpDir, 'nonexistent');

      const result = await introspectProject({
        directory: nonexistent,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(0);
      expect(parsed.objects).toEqual([]);
    });

    it('should handle malformed TypeScript files', async () => {
      await writeFile(
        join(tmpDir, 'malformed.ts'),
        `
this is not valid typescript
@smrt() export class Broken
        `.trim(),
      );

      await writeFile(
        join(tmpDir, 'valid.ts'),
        `
@smrt()
export class Valid extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      // Should find the valid one, skip the malformed one
      expect(parsed.objectCount).toBe(1);
      expect(parsed.objects[0].className).toBe('Valid');
    });
  });

  describe('Output Format', () => {
    it('should return valid JSON', async () => {
      await writeFile(
        join(tmpDir, 'model.ts'),
        `
@smrt()
export class Model extends SmrtObject {
  name = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
      });

      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('should include project path in output', async () => {
      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.projectPath).toBe(tmpDir);
    });

    it('should include object count in output', async () => {
      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('objectCount');
      expect(typeof parsed.objectCount).toBe('number');
    });
  });
});
