/**
 * Regression tests for the T3 images remediation finding (#1407, top item):
 * tenant-isolation on ImageCollection's orientation/resolution helpers.
 *
 * Image inherits Asset's `@TenantScoped({ mode: 'optional' })`, and the
 * interceptor's default `rawQueryPolicy` is `'throw'`. The original
 * implementations of `getLandscape` / `getPortrait` / `getSquare` /
 * `getHighResolution` / `getByAspectRatio` / `findWithGlobals` issued raw
 * `this.query("SELECT * FROM assets ...")`, which — under any tenant context —
 * either threw `TenantIsolationError` (the orientation/resolution `+server.ts`
 * endpoints were broken) or, under a `'warn'`/`'allow'` policy, returned rows
 * across all tenants AND across sibling Asset subclasses (no `_meta_type`
 * scope).
 *
 * Each test below runs the method inside `withTenant()` with tenancy enabled
 * (default throw policy) and asserts (a) it does not throw and (b) it returns
 * only the current tenant's Image rows — never another tenant's images and
 * never a non-Image Asset. Real in-memory SQLite, no DB mocking, per
 * `.claude/rules/testing.md`.
 */

import { AssetCollection } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Image } from '../image';
import { ImageCollection } from '../images';

describe('ImageCollection tenant isolation (#1407)', () => {
  let db: DatabaseInterface;
  let images: ImageCollection;
  let assets: AssetCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    images = await ImageCollection.create({ db });
    assets = await AssetCollection.create({ db });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  /**
   * Seed a fixed fixture spanning two tenants plus a non-Image Asset.
   * Created under each tenant's context so the interceptor auto-populates
   * tenant_id; the non-Image Asset is created under tenant-1 too.
   */
  async function seed() {
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      // Landscape, portrait, square, 4K, and a non-Image asset.
      await (
        await images.create({ name: 't1-land.jpg', width: 1920, height: 1080 })
      ).save();
      await (
        await images.create({ name: 't1-port.jpg', width: 1080, height: 1920 })
      ).save();
      await (
        await images.create({ name: 't1-square.jpg', width: 512, height: 512 })
      ).save();
      await (
        await images.create({ name: 't1-4k.jpg', width: 3840, height: 2160 })
      ).save();
      await (
        await assets.create({
          name: 't1-doc.pdf',
          mimeType: 'application/pdf',
        })
      ).save();
    });

    await withTenant({ tenantId: 'tenant-2' }, async () => {
      // Tenant-2 has one of every shape so a leak would be obvious.
      await (
        await images.create({ name: 't2-land.jpg', width: 2560, height: 1440 })
      ).save();
      await (
        await images.create({ name: 't2-port.jpg', width: 720, height: 1280 })
      ).save();
      await (
        await images.create({ name: 't2-square.jpg', width: 256, height: 256 })
      ).save();
      await (
        await images.create({ name: 't2-4k.jpg', width: 4096, height: 2160 })
      ).save();
    });
  }

  it('getLandscape() returns only the current tenant landscape images (no throw)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      images.getLandscape(),
    );
    // Both t1-land (1920×1080) and t1-4k (3840×2160) are landscape; tenant-2's
    // landscape images must NOT appear, and the non-Image PDF must NOT appear.
    expect(result.map((i) => i.name).sort()).toEqual([
      't1-4k.jpg',
      't1-land.jpg',
    ]);
    // Every result is an Image (STI scope), not a sibling Asset.
    expect(result.every((i) => i instanceof Image)).toBe(true);
  });

  it('getPortrait() returns only the current tenant portrait images (no throw)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-2' }, () =>
      images.getPortrait(),
    );
    expect(result.map((i) => i.name)).toEqual(['t2-port.jpg']);
    expect(result.every((i) => i instanceof Image)).toBe(true);
  });

  it('getSquare() returns only the current tenant square images (no throw)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      images.getSquare(),
    );
    expect(result.map((i) => i.name)).toEqual(['t1-square.jpg']);
  });

  it('getHighResolution() returns only the current tenant 4K images (no throw)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      images.getHighResolution(),
    );
    expect(result.map((i) => i.name)).toEqual(['t1-4k.jpg']);
  });

  it('getByAspectRatio() returns only the current tenant images in range (no throw)', async () => {
    await seed();
    // [1.7, 1.9] matches both tenant-1 16:9-ish images (t1-land 1.78, t1-4k
    // 1.78) but not t1-square (1.0). Tenant-2 also has in-range landscapes
    // (t2-land 1.78, t2-4k 1.90) — a tenant leak would surface them, so an
    // exact tenant-1-only result proves isolation.
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      images.getByAspectRatio(1.7, 1.9),
    );
    expect(result.map((i) => i.name).sort()).toEqual([
      't1-4k.jpg',
      't1-land.jpg',
    ]);
  });

  it('findWithGlobals() returns the tenant images plus globals, scoped to Images (no throw)', async () => {
    await seed();
    // Add a global (tenant-less) image and a global non-Image asset via system
    // context so no tenant id is auto-populated.
    const { withSystemContext } = await import('@happyvertical/smrt-tenancy');
    await withSystemContext(async () => {
      await (
        await images.create({ name: 'global.jpg', width: 800, height: 600 })
      ).save();
      await (
        await assets.create({
          name: 'global-doc.pdf',
          mimeType: 'application/pdf',
        })
      ).save();
    });

    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      images.findWithGlobals('tenant-1'),
    );
    const names = result.map((i) => i.name).sort();
    // tenant-1's four images + the one global image; NOT tenant-2's images and
    // NOT either non-Image PDF.
    expect(names).toEqual([
      'global.jpg',
      't1-4k.jpg',
      't1-land.jpg',
      't1-port.jpg',
      't1-square.jpg',
    ]);
    expect(result.every((i) => i instanceof Image)).toBe(true);
  });
});
