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

    it('should use scanner inference for multi-class downstream-style files', async () => {
      await writeFile(
        join(tmpDir, 'models.ts'),
        `
import { crossPackageRef, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@TenantScoped({ mode: 'optional' })
@smrt({ tableName: 'tectum_projects', conflictColumns: ['tenant_id', 'slug'] })
export class TectumProject extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;
  name = '';
  count = 0;
  price = 0.0;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  ownerProfileId: string | null = null;

  isReady() {
    if (this.name) return true;
    return false;
  }
}

@smrt()
export class TectumTask extends SmrtObject {
  @foreignKey('TectumProject')
  projectId: string = '';
  title: string = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
        includeRelationships: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.manifestSource).toBe('scanner');
      expect(parsed.objectCount).toBe(2);

      const project = parsed.objects.find(
        (obj: any) => obj.className === 'TectumProject',
      );
      expect(project.fields).toContain('count: integer');
      expect(project.fields).toContain('price: decimal');
      expect(project.relationships).toContain(
        'ownerProfileId -> @happyvertical/smrt-profiles:Profile (crossPackageRef)',
      );
      expect(project.conflictColumns).toEqual(['tenant_id', 'slug']);
      expect(project.tableName).toBe('tectum_projects');
      expect(project.tenantScope).toMatchObject({
        source: 'TenantScoped',
        mode: 'optional',
        field: 'tenantId',
      });
      expect(project.methods).toContain('isReady()');
      expect(project.methods).not.toContain('if()');
    });

    it('should finalize scanner fallback manifests before reporting schema details', async () => {
      await writeFile(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: '@test/tenant-app', version: '1.0.0' }),
      );
      await writeFile(
        join(tmpDir, 'tenant-project.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ tenantScoped: true, tableName: 'tenant_projects' })
export class TenantProject extends SmrtObject {
  name: string = '';
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
      });

      const parsed = JSON.parse(result);
      const project = parsed.objects.find(
        (obj: any) => obj.className === 'TenantProject',
      );

      expect(parsed.manifestSource).toBe('scanner');
      expect(project.fields).toContain('tenantId: text');
      expect(project.fieldDetails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'tenantId',
            type: 'text',
            meta: expect.objectContaining({
              generated: true,
              source: 'tenantScoped_decorator',
            }),
          }),
        ]),
      );
      expect(project.schema.columns.tenant_id).toEqual(
        expect.objectContaining({ type: 'TEXT' }),
      );
      expect(project.tableName).toBe('tenant_projects');
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

    it('should handle TypeScript property modifiers without treating modifiers as fields', async () => {
      await writeFile(
        join(tmpDir, 'model.ts'),
        `
@smrt()
export class Model extends SmrtObject {
  static uiSlots = [];
  private secret: string = '';
  protected internalCount: number = 0;
  public name: string = '';
  readonly active: boolean = false;
}
        `.trim(),
      );

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].fields).toContain('name: text');
      expect(parsed.objects[0].fields).toContain('active: boolean');
      expect(parsed.objects[0].fields).not.toContain('static: json');
      expect(parsed.objects[0].fields).not.toContain('secret: text');
      expect(parsed.objects[0].fields).not.toContain('internalCount: integer');
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

    it('should prefer generated manifest artifacts with schema indexes', async () => {
      await mkdir(join(tmpDir, '.smrt'), { recursive: true });
      await writeFile(
        join(tmpDir, '.smrt', 'manifest.json'),
        JSON.stringify(
          {
            version: '1.0.0',
            packageName: '@test/downstream',
            packageVersion: '1.2.3',
            objects: {
              '@test/downstream:IndexedThing': {
                name: 'indexedthing',
                className: 'IndexedThing',
                qualifiedName: '@test/downstream:IndexedThing',
                collection: 'indexed_things',
                filePath: 'src/indexed-thing.ts',
                decoratorConfig: { tableName: 'indexed_things' },
                fields: {
                  name: { type: 'text', required: true },
                },
                methods: {},
                schema: {
                  tableName: 'indexed_things',
                  columns: { name: { type: 'TEXT', notNull: true } },
                  indexes: [
                    {
                      name: 'idx_indexed_things_name',
                      columns: ['name'],
                      unique: true,
                    },
                  ],
                  version: 'schema-hash',
                },
              },
            },
          },
          null,
          2,
        ),
      );

      const result = await introspectProject({ directory: tmpDir });
      const parsed = JSON.parse(result);

      expect(parsed.manifestSource).toBe('manifest');
      expect(parsed.packageName).toBe('@test/downstream');
      expect(parsed.objects[0].indexes).toEqual([
        {
          name: 'idx_indexed_things_name',
          columns: ['name'],
          unique: true,
        },
      ]);
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
