/**
 * Test for Issue #75: Circular Serialization Errors
 *
 * This test verifies that:
 * 1. System properties from base classes are excluded from schema
 * 2. Only user-defined properties and whitelisted schema properties are included
 * 3. Serialization does not cause circular reference errors
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';
import { ASTScanner } from '../scanner/ast-scanner';

describe('Issue #75: Circular Serialization Errors', () => {
  describe('AST Scanner excludes base class properties', () => {
    it('should exclude system properties from SmrtClass and SmrtObject', () => {
      // Note: This test scans actual source files including base classes
      // The AST scanner will extract base class properties and exclude them from subclass schemas

      // Scan the actual object.ts file which contains SmrtObject base class
      const objectFilePath = join(process.cwd(), 'src', 'object.ts');
      const scanner = new ASTScanner([objectFilePath]);
      const results = scanner.scanFiles();

      // SmrtObject itself should not be included (it's a base class)
      const smrtObjectDef = results[0]?.objects.find(
        (obj) => obj.className === 'SmrtObject',
      );
      expect(smrtObjectDef).toBeUndefined();

      // When we scan actual SMRT objects in tests below,
      // they register at runtime and we can verify system properties are excluded
    });
  });

  describe('Serialization without circular references', () => {
    it('should serialize object to JSON without circular reference errors', async () => {
      class TestProduct extends SmrtObject {
        name: string = '';
        productName: string = 'Test Product';
        price: number = 99.99;
        inStock: boolean = true;
      }

      // Create instance with minimal options
      const product = new TestProduct({
        name: 'Widget',
        db: ':memory:',
      });

      await product.initialize();

      // This should not throw circular reference errors
      let jsonString: string;
      expect(() => {
        jsonString = JSON.stringify(product);
      }).not.toThrow();

      // Verify the JSON contains user properties
      const parsed = JSON.parse(jsonString!);
      expect(parsed).toHaveProperty('productName', 'Test Product');
      expect(parsed).toHaveProperty('price', 99.99);
      expect(parsed).toHaveProperty('inStock', true);
      expect(parsed).toHaveProperty('name', 'Widget');

      // Verify system properties are not serialized
      expect(parsed).not.toHaveProperty('_ai');
      expect(parsed).not.toHaveProperty('_db');
      expect(parsed).not.toHaveProperty('_fs');
      expect(parsed).not.toHaveProperty('ai');
      expect(parsed).not.toHaveProperty('db');
      expect(parsed).not.toHaveProperty('fs');
    });

    it('should save object without circular reference errors', async () => {
      class TestArticle extends SmrtObject {
        name: string = '';
        title: string = 'Test Article';
        body: string = 'Article content';
        published: boolean = false;
      }

      const article = new TestArticle({
        name: 'My Article',
        db: ':memory:',
      });

      await article.initialize();

      // This should not throw circular reference errors during save
      await expect(article.save()).resolves.not.toThrow();

      // Verify we can create a new instance and load it
      // Important: Use the same database instance (article.db) for retrieval
      const retrieved = new TestArticle({
        id: article.id,
        db: article.db, // Reuse the same database instance
      });
      await retrieved.initialize();
      await retrieved.loadFromId();

      expect(retrieved.title).toBe('Test Article');
      expect(retrieved.body).toBe('Article content');
    });
  });

  describe('toJSON() method behavior', () => {
    it('should only include schema fields in toJSON() output', async () => {
      class TestBook extends SmrtObject {
        name: string = '';
        bookTitle: string = 'The Book';
        author: string = 'Author Name';
        pages: number = 300;
      }

      const book = new TestBook({
        name: 'Book 1',
        db: ':memory:',
      });

      await book.initialize();

      const json = book.toJSON();

      // User-defined fields should be present
      expect(json).toHaveProperty('bookTitle', 'The Book');
      expect(json).toHaveProperty('author', 'Author Name');
      expect(json).toHaveProperty('pages', 300);

      // Schema properties should be present
      expect(json).toHaveProperty('id');
      expect(json).toHaveProperty('slug');
      expect(json).toHaveProperty('context');
      expect(json).toHaveProperty('name', 'Book 1');
      expect(json).toHaveProperty('created_at');
      expect(json).toHaveProperty('updated_at');

      // System properties should NOT be present
      expect(json).not.toHaveProperty('_ai');
      expect(json).not.toHaveProperty('_db');
      expect(json).not.toHaveProperty('_fs');
      expect(json).not.toHaveProperty('_className');
      expect(json).not.toHaveProperty('options');
      expect(json).not.toHaveProperty('db');
      expect(json).not.toHaveProperty('ai');
      expect(json).not.toHaveProperty('fs');
    });
  });
});
