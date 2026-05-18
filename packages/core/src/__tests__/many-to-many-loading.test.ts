/**
 * `@manyToMany` lazy + batch eager loading tests (R6).
 *
 * Covers the loader that closes the previous TODO at
 * `collection.ts:1004` / `object.ts:loadRelatedMany`. The implementation
 * issues two queries (one against the junction table, one against the
 * target table) and groups results by source instance.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manyToMany, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry';
import { getTestDatabase } from '../testing/database';

// Target class — "Tag"
@smrt()
class M2MTag extends SmrtObject {
  label: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.label) this.label = options.label;
  }
}

// Source class — "Product" with @manyToMany(Tag)
@smrt()
class M2MProduct extends SmrtObject {
  name: string = '';

  @manyToMany(M2MTag, { through: 'm2m_product_tags' })
  tags: M2MTag[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

// Source class that intentionally omits the `through` option — used to verify
// that loadRelatedMany surfaces a clear error rather than silently producing []
@smrt()
class M2MBrokenSource extends SmrtObject {
  @manyToMany(M2MTag)
  tags: M2MTag[] = [];
}

async function ensureJunctionTable(db: DatabaseInterface): Promise<void> {
  // The junction table is a plain link table; @manyToMany consumers
  // typically own its schema themselves (no SmrtObject backing).
  await db.query(
    `CREATE TABLE IF NOT EXISTS m2m_product_tags (
      m2_m_product_id TEXT NOT NULL,
      m2_m_tag_id TEXT NOT NULL,
      PRIMARY KEY (m2_m_product_id, m2_m_tag_id)
    )`,
  );
}

describe('@manyToMany lazy + batch loading (R6)', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-m2m-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
    await ensureJunctionTable(db);
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Lazy load via loadRelatedMany / getRelated', () => {
    it('returns [] when no junction rows exist', async () => {
      const product = new M2MProduct({ name: 'Empty', db });
      await product.initialize();
      await product.save();

      const tags = await product.loadRelatedMany('tags');
      expect(tags).toEqual([]);
    });

    it('returns the linked targets when junction rows exist', async () => {
      const product = new M2MProduct({ name: 'Tagged', db });
      await product.initialize();
      await product.save();

      const t1 = new M2MTag({ label: 'Featured', db });
      await t1.initialize();
      await t1.save();
      const t2 = new M2MTag({ label: 'New', db });
      await t2.initialize();
      await t2.save();

      await db.query(
        'INSERT INTO m2m_product_tags (m2_m_product_id, m2_m_tag_id) VALUES (?, ?), (?, ?)',
        [product.id, t1.id, product.id, t2.id],
      );

      const tags = (await product.loadRelatedMany('tags')) as M2MTag[];
      expect(tags).toHaveLength(2);
      const labels = tags.map((t) => t.label).sort();
      expect(labels).toEqual(['Featured', 'New']);
    });

    it('getRelated dispatches manyToMany to the same loader', async () => {
      const product = new M2MProduct({ name: 'ViaGetRelated', db });
      await product.initialize();
      await product.save();

      const t1 = new M2MTag({ label: 'Sale', db });
      await t1.initialize();
      await t1.save();

      await db.query(
        'INSERT INTO m2m_product_tags (m2_m_product_id, m2_m_tag_id) VALUES (?, ?)',
        [product.id, t1.id],
      );

      const tags = (await product.getRelated('tags')) as M2MTag[];
      expect(tags).toHaveLength(1);
      expect(tags[0].label).toBe('Sale');
    });
  });

  describe('Eager load via Collection.list({ include })', () => {
    it('batch-loads manyToMany targets across multiple source rows', async () => {
      const t1 = new M2MTag({ label: 'X', db });
      await t1.initialize();
      await t1.save();
      const t2 = new M2MTag({ label: 'Y', db });
      await t2.initialize();
      await t2.save();
      const t3 = new M2MTag({ label: 'Z', db });
      await t3.initialize();
      await t3.save();

      const p1 = new M2MProduct({ name: 'P1', db });
      await p1.initialize();
      await p1.save();
      const p2 = new M2MProduct({ name: 'P2', db });
      await p2.initialize();
      await p2.save();
      const p3 = new M2MProduct({ name: 'P3-Empty', db });
      await p3.initialize();
      await p3.save();

      // p1 has [t1, t2], p2 has [t2, t3], p3 has nothing
      await db.query(
        'INSERT INTO m2m_product_tags (m2_m_product_id, m2_m_tag_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?)',
        [p1.id, t1.id, p1.id, t2.id, p2.id, t2.id, p2.id, t3.id],
      );

      const collection = await ObjectRegistry.getCollection<
        typeof M2MProduct.prototype
      >('M2MProduct', { db });
      const products = await collection.list({
        include: ['tags'],
        orderBy: 'name ASC',
      });

      expect(products).toHaveLength(3);

      const [loadedP1, loadedP2, loadedP3] = products as any[];
      const p1Tags = loadedP1._loadedRelationships.get('tags');
      const p2Tags = loadedP2._loadedRelationships.get('tags');
      const p3Tags = loadedP3._loadedRelationships.get('tags');

      expect(p1Tags.map((t: M2MTag) => t.label).sort()).toEqual(['X', 'Y']);
      expect(p2Tags.map((t: M2MTag) => t.label).sort()).toEqual(['Y', 'Z']);
      expect(p3Tags).toEqual([]);
    });
  });

  describe('Error conditions', () => {
    it('throws when through option is missing', async () => {
      const source = new M2MBrokenSource({ db });
      await source.initialize();
      await source.save();

      await expect(source.loadRelatedMany('tags')).rejects.toThrow(
        /missing the 'through' join table name/,
      );
    });
  });
});
