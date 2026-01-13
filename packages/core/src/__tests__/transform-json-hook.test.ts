/**
 * transformJSON() Hook Tests
 *
 * Tests the transformJSON() hook pattern for safe JSON serialization customization.
 * This hook allows subclasses to transform serialized data without overriding toJSON().
 *
 * Related to issue #377 - prevents unsafe toJSON() overrides that break STI.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject, smrt } from '../index';

// Shared test classes defined at module level
@smrt()
class TransformJSONTestArticle extends SmrtObject {
  public name: string = '';
  public title: string = '';
  public body: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.title) this.title = options.title;
    if (options.body) this.body = options.body;
  }

  protected transformJSON(data: any): any {
    return {
      ...data,
      wordCount: this.body.split(/\s+/).filter(Boolean).length,
      preview: this.body.substring(0, 100),
    };
  }
}

describe('transformJSON() Hook', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `test-transform-json-${randomUUID().slice(0, 8)}.db`,
    );
    db = await getDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Basic Transformation', () => {
    it('should call transformJSON() during toJSON()', async () => {
      const article = new TransformJSONTestArticle({
        name: 'test-article',
        title: 'Test Article',
        body: 'This is a test article with some content for testing.',
        db,
      });
      await article.initialize();

      const data = article.toJSON();

      expect(data.wordCount).toBe(10);
      expect(data.preview).toBe(
        'This is a test article with some content for testing.',
      );
    });

    it('should allow adding custom fields', async () => {
      const article = new TransformJSONTestArticle({
        name: 'test-article',
        title: 'Test Article',
        body: 'Short content.',
        db,
      });
      await article.initialize();

      const data = article.toJSON();

      expect(data).toHaveProperty('wordCount');
      expect(data).toHaveProperty('preview');
      expect(data.title).toBe('Test Article');
    });

    it('should allow modifying existing fields', async () => {
      const article = new TransformJSONTestArticle({
        name: 'test',
        title: 'lowercase title',
        body: 'test',
        db,
      });

      // Override transformJSON for this instance
      article.transformJSON = (data: any) => ({
        ...data,
        title: data.title?.toUpperCase() || '',
      });

      await article.initialize();

      const data = article.toJSON();

      expect(data.title).toBe('LOWERCASE TITLE');
    });

    it('should allow filtering fields', async () => {
      const article = new TransformJSONTestArticle({
        name: 'test',
        title: 'Public Title',
        body: 'body content',
        db,
      });

      // Add a custom property that we'll filter out
      (article as any).secretData = 'SECRET_VALUE';

      // Override transformJSON to filter the custom field
      article.transformJSON = (data: any) => {
        const { secretData, ...publicData } = data;
        return publicData;
      };

      await article.initialize();

      const data = article.toJSON();

      expect(data.title).toBe('Public Title');
      expect(data).not.toHaveProperty('secretData');
    });
  });

  describe('Default Implementation', () => {
    it('should return data unchanged when not overridden', async () => {
      // Create a class that doesn't override transformJSON
      @smrt()
      class PlainClass extends SmrtObject {
        public name: string = '';
        public value: string = '';

        constructor(options: any = {}) {
          super(options);
          if (options.name) this.name = options.name;
          if (options.value) this.value = options.value;
        }

        // No transformJSON override - uses default implementation
      }

      const obj = new PlainClass({
        name: 'test',
        value: 'test-value',
        db,
      });
      await obj.initialize();

      const data = obj.toJSON();

      // Default implementation returns data unchanged
      expect(data).toBeDefined();
      expect(data).not.toHaveProperty('wordCount');
      expect(data).not.toHaveProperty('enhanced');
    });
  });

  describe('STI Compatibility', () => {
    @smrt({ tableStrategy: 'sti' })
    class BaseContent extends SmrtObject {
      public name: string = '';
      public title: string = '';
      public body: string = '';

      constructor(options: any = {}) {
        super(options);
        if (options.name) this.name = options.name;
        if (options.title) this.title = options.title;
        if (options.body) this.body = options.body;
      }
    }

    @smrt() // Don't redeclare tableStrategy - inherit from parent
    class EnhancedContent extends BaseContent {
      protected transformJSON(data: any): any {
        return {
          ...data,
          enhanced: true,
          length: this.body.length,
        };
      }
    }

    it('should preserve _meta_type when using transformJSON()', async () => {
      const content = new EnhancedContent({
        name: 'test-content',
        title: 'Test Content',
        body: 'Content body',
        db,
      });
      await content.initialize();

      const data = content.toJSON();

      // STI discriminator must be preserved (Issue #713: now uses qualified names)
      expect(data._meta_type).toBe('@happyvertical/smrt-core:EnhancedContent');
      // Custom fields added by hook
      expect(data.enhanced).toBe(true);
      expect(data.length).toBe(12);
    });
  });

  describe('Multi-Level Inheritance', () => {
    @smrt({ tableStrategy: 'sti' })
    class Level1 extends SmrtObject {
      public name: string = '';
      public level: number = 1;

      constructor(options: any = {}) {
        super(options);
        if (options.name) this.name = options.name;
        if (options.level !== undefined) this.level = options.level;
      }

      protected transformJSON(data: any): any {
        return {
          ...data,
          level1Transform: true,
        };
      }
    }

    @smrt() // Inherit STI from parent
    class Level2 extends Level1 {
      protected transformJSON(data: any): any {
        const parentData = super.transformJSON(data);
        return {
          ...parentData,
          level2Transform: true,
        };
      }
    }

    @smrt() // Inherit STI from parent
    class Level3 extends Level2 {
      protected transformJSON(data: any): any {
        const parentData = super.transformJSON(data);
        return {
          ...parentData,
          level3Transform: true,
        };
      }
    }

    it('should support chained transformations across inheritance', async () => {
      const obj = new Level3({
        name: 'test-level3',
        level: 3,
        db,
      });
      await obj.initialize();

      const data = obj.toJSON();

      // All transformations should be applied
      expect(data.level1Transform).toBe(true);
      expect(data.level2Transform).toBe(true);
      expect(data.level3Transform).toBe(true);
      // STI still works (Issue #713: now uses qualified names)
      expect(data._meta_type).toBe('@happyvertical/smrt-core:Level3');
    });

    it('should allow intermediate classes to modify parent transformations', async () => {
      @smrt({ tableStrategy: 'sti' })
      class TransformBase extends SmrtObject {
        public name: string = '';
        public value: number = 0;

        constructor(options: any = {}) {
          super(options);
          if (options.name) this.name = options.name;
          if (options.value !== undefined) this.value = options.value;
        }

        protected transformJSON(data: any): any {
          return {
            ...data,
            computed: this.value * 2,
          };
        }
      }

      @smrt() // Inherit STI from parent
      class TransformChild extends TransformBase {
        protected transformJSON(data: any): any {
          const parentData = super.transformJSON(data);
          return {
            ...parentData,
            computed: parentData.computed * 3, // Modify parent's computed value
          };
        }
      }

      const obj = new TransformChild({
        name: 'test',
        value: 5,
        db,
      });
      await obj.initialize();

      const data = obj.toJSON();

      // Base: 5 * 2 = 10
      // Child: 10 * 3 = 30
      expect(data.computed).toBe(30);
    });
  });

  describe('Instance Property Access', () => {
    // Using unique class name to avoid collisions with other test files (see issue #543)
    @smrt()
    class TransformJSONTestProduct extends SmrtObject {
      public name: string = '';
      public price: number = 0.0;
      public quantity: number = 0;

      constructor(options: any = {}) {
        super(options);
        if (options.name) this.name = options.name;
        if (options.price !== undefined) this.price = options.price;
        if (options.quantity !== undefined) this.quantity = options.quantity;
      }

      protected transformJSON(data: any): any {
        return {
          ...data,
          totalValue: this.price * this.quantity,
          inStock: this.quantity > 0,
        };
      }
    }

    it('should have access to instance properties', async () => {
      const product = new TransformJSONTestProduct({
        name: 'Widget',
        price: 19.99,
        quantity: 10,
        db,
      });
      await product.initialize();

      const data = product.toJSON();

      expect(data.totalValue).toBeCloseTo(199.9);
      expect(data.inStock).toBe(true);
    });

    it('should compute based on current instance state', async () => {
      const product = new TransformJSONTestProduct({
        name: 'Widget',
        price: 10.0,
        quantity: 5,
        db,
      });
      await product.initialize();

      const data1 = product.toJSON();
      expect(data1.totalValue).toBe(50);

      // Change instance state
      product.quantity = 10;

      const data2 = product.toJSON();
      expect(data2.totalValue).toBe(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle returning completely new object', async () => {
      @smrt()
      class CustomFormat extends SmrtObject {
        public name: string = '';
        public data: Record<string, any> = {};

        constructor(options: any = {}) {
          super(options);
          if (options.name) this.name = options.name;
          if (options.data) this.data = options.data;
        }

        protected transformJSON(_data: any): any {
          // Ignore framework data, return custom format
          return {
            custom_id: this.id,
            custom_name: this.name,
            payload: this.data,
          };
        }
      }

      const obj = new CustomFormat({
        name: 'test',
        data: { foo: 'bar' },
        db,
      });
      await obj.initialize();

      const data = obj.toJSON();

      expect(data).toHaveProperty('custom_id');
      expect(data).toHaveProperty('custom_name');
      expect(data).toHaveProperty('payload');
      expect(data.payload).toEqual({ foo: 'bar' });
    });

    it('should handle async-like operations (but must return sync)', async () => {
      @smrt()
      class SyncOnly extends SmrtObject {
        public name: string = '';
        public items: string[] = [];

        constructor(options: any = {}) {
          super(options);
          if (options.name) this.name = options.name;
          if (options.items) this.items = options.items;
        }

        protected transformJSON(data: any): any {
          // Can use sync operations like map/filter/reduce
          return {
            ...data,
            itemCount: this.items.length,
            firstItem: this.items[0] || null,
          };
        }
      }

      const obj = new SyncOnly({
        name: 'test',
        items: ['a', 'b', 'c'],
        db,
      });
      await obj.initialize();

      const data = obj.toJSON();

      expect(data.itemCount).toBe(3);
      expect(data.firstItem).toBe('a');
    });
  });
});
