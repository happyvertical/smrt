/**
 * STI (Single Table Inheritance) tests for Content classes
 *
 * Tests that Content and its descendants (ContentDocument, Article, etc.)
 * properly support STI with _meta_type discriminator.
 *
 * Related to issue #377
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Content } from './content';
import { Article, ContentDocument } from './content-types';

describe('Content STI Support', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-content-sti-${Date.now()}.db`);
    db = await getDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Content (base class)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('Content');
      expect(strategy).toBe('sti');
    });

    it('should set _meta_type in toJSON()', async () => {
      const content = new Content({
        name: 'test-content',
        title: 'Test Content',
        body: 'Test body',
      });
      await content.initialize();

      const data = content.toJSON();
      expect(data._meta_type).toBe('Content');
    });

    it('should save with STI discriminator', async () => {
      const content = new Content({
        name: 'test-content',
        title: 'Test Content',
        body: 'Test body',
        db,
      });
      await content.initialize();

      // Should not throw
      await expect(content.save()).resolves.not.toThrow();

      // Verify it was saved
      expect(content.id).toBeDefined();
      expect(content.created_at).toBeDefined();
    });

    it('should load Content from database', async () => {
      // Create and save
      const content = new Content({
        name: 'test-content',
        title: 'Test Content',
        body: 'Test body',
        db,
      });
      await content.initialize();
      await content.save();
      const savedId = content.id;

      // Load from database
      const loaded = new Content({ id: savedId, db });
      await loaded.initialize();
      await loaded.loadFromId(savedId);

      expect(loaded.id).toBe(savedId);
      expect(loaded.title).toBe('Test Content');
      expect(loaded.body).toBe('Test body');
    });
  });

  describe('ContentDocument (2-level inheritance)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('ContentDocument');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('ContentDocument');
      // ContentDocument inherits STI from Content, so Content is the actual STI base
      // Even though ContentDocument explicitly declares tableStrategy: 'sti', that's redundant
      expect(base).toBe('Content');
    });

    it('should set _meta_type to ContentDocument', async () => {
      const doc = new ContentDocument({
        name: 'test-document',
        title: 'Test Document',
        body: 'Document body',
      });
      await doc.initialize();

      const data = doc.toJSON();
      expect(data._meta_type).toBe('ContentDocument');
    });

    it('should save ContentDocument with STI discriminator', async () => {
      const doc = new ContentDocument({
        name: 'test-document',
        title: 'Test Document',
        body: 'Document body',
        db,
      });
      await doc.initialize();

      // Should not throw (issue #377 would cause failure here)
      await expect(doc.save()).resolves.not.toThrow();

      expect(doc.id).toBeDefined();
      expect(doc.created_at).toBeDefined();
    });

    it('should load ContentDocument from database', async () => {
      // Create and save
      const doc = new ContentDocument({
        name: 'test-document',
        title: 'Test Document',
        body: 'Document body',
        db,
      });
      await doc.initialize();
      await doc.save();
      const savedId = doc.id;

      // Load from database
      const loaded = new ContentDocument({ id: savedId, db });
      await loaded.initialize();
      await loaded.loadFromId(savedId);

      expect(loaded.id).toBe(savedId);
      expect(loaded.title).toBe('Test Document');
      expect(loaded.body).toBe('Document body');
    });
  });

  describe('Article (2-level inheritance)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('Article');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('Article');
      // Article inherits STI from Content, so Content is the actual STI base
      expect(base).toBe('Content');
    });

    it('should set _meta_type to Article', async () => {
      const article = new Article({
        name: 'test-article',
        title: 'Test Article',
        body: 'Article body',
      });
      await article.initialize();

      const data = article.toJSON();
      expect(data._meta_type).toBe('Article');
    });

    it('should save Article with STI discriminator', async () => {
      const article = new Article({
        name: 'test-article',
        title: 'Test Article',
        body: 'Article body',
        db,
      });
      await article.initialize();

      await expect(article.save()).resolves.not.toThrow();

      expect(article.id).toBeDefined();
      expect(article.created_at).toBeDefined();
    });
  });

  describe('STI discriminator handling', () => {
    it('should set different _meta_type for each class', async () => {
      const content = new Content({
        name: 'base-content',
        title: 'Base Content',
        body: 'Content body',
      });
      await content.initialize();

      const doc = new ContentDocument({
        name: 'document',
        title: 'Document',
        body: 'Document body',
      });
      await doc.initialize();

      const article = new Article({
        name: 'article',
        title: 'Article',
        body: 'Article body',
      });
      await article.initialize();

      // Verify each has correct _meta_type
      expect(content.toJSON()._meta_type).toBe('Content');
      expect(doc.toJSON()._meta_type).toBe('ContentDocument');
      expect(article.toJSON()._meta_type).toBe('Article');
    });

    it('should persist _meta_type when saving', async () => {
      // This is the core fix for #377 - ensure _meta_type is set
      const content = new Content({ name: 'c1', title: 'C1', body: 'B1', db });
      await content.initialize();

      const jsonBefore = content.toJSON();
      expect(jsonBefore._meta_type).toBe('Content');

      await content.save();

      const jsonAfter = content.toJSON();
      expect(jsonAfter._meta_type).toBe('Content');
    });
  });

  describe('Inheritance chain', () => {
    it('should build correct inheritance chain for ContentDocument', () => {
      const chain = ObjectRegistry.getInheritanceChain('ContentDocument');

      // Should include Content → ContentDocument
      expect(chain).toContain('Content');
      expect(chain).toContain('ContentDocument');

      // ContentDocument should come after Content
      const contentIdx = chain.indexOf('Content');
      const docIdx = chain.indexOf('ContentDocument');
      expect(docIdx).toBeGreaterThan(contentIdx);
    });

    it('should get all descendants of Content', () => {
      const descendants = ObjectRegistry.getDescendants('Content');

      // Should include at least ContentDocument and Article
      expect(descendants).toContain('ContentDocument');
      expect(descendants).toContain('Article');
    });
  });
});
