/**
 * Extended ImageCollection query coverage
 *
 * Covers query/helper methods on ImageCollection not already exercised by
 * image.test.ts (which covers getByMinDimensions, getByMaxDimensions,
 * getLandscape, getPortrait, getMissingAltText, getHighResolution,
 * getByAspectRatio). This file adds:
 *   - getSquare()
 *   - findByTenant()
 *   - findGlobal()
 *   - findWithGlobals()
 *
 * Real in-memory SQLite via getTestDatabase — no mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageCollection } from '../images';

describe('ImageCollection extended queries', () => {
  let db: DatabaseInterface;
  let images: ImageCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    images = await ImageCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('getSquare()', () => {
    it('returns only images where width equals height and width > 0', async () => {
      await (
        await images.create({ name: 'square.jpg', width: 512, height: 512 })
      ).save();
      await (
        await images.create({ name: 'wide.jpg', width: 1920, height: 1080 })
      ).save();
      // zero-dimension placeholder should be excluded (width > 0 guard)
      await (
        await images.create({ name: 'empty.jpg', width: 0, height: 0 })
      ).save();

      const squares = await images.getSquare();
      expect(squares).toHaveLength(1);
      expect(squares[0].name).toBe('square.jpg');
    });
  });

  describe('tenant-aware queries', () => {
    it('findByTenant returns only images for that tenant', async () => {
      await (
        await images.create({ name: 't1-a.jpg', tenantId: 'tenant-1' })
      ).save();
      await (
        await images.create({ name: 't2-a.jpg', tenantId: 'tenant-2' })
      ).save();
      await (await images.create({ name: 'global.jpg' })).save();

      const tenant1 = await images.findByTenant('tenant-1');
      expect(tenant1).toHaveLength(1);
      expect(tenant1[0].name).toBe('t1-a.jpg');
    });

    it('findGlobal returns only images without a tenant', async () => {
      await (
        await images.create({ name: 'scoped.jpg', tenantId: 'tenant-1' })
      ).save();
      await (await images.create({ name: 'g1.jpg' })).save();
      await (await images.create({ name: 'g2.jpg' })).save();

      const globals = await images.findGlobal();
      expect(globals.map((i) => i.name).sort()).toEqual(['g1.jpg', 'g2.jpg']);
    });

    it('findWithGlobals returns tenant images plus global images', async () => {
      await (
        await images.create({ name: 't1.jpg', tenantId: 'tenant-1' })
      ).save();
      await (
        await images.create({ name: 't2.jpg', tenantId: 'tenant-2' })
      ).save();
      await (await images.create({ name: 'shared.jpg' })).save();

      const combined = await images.findWithGlobals('tenant-1');
      expect(combined.map((i) => i.name).sort()).toEqual([
        'shared.jpg',
        't1.jpg',
      ]);
    });
  });
});
