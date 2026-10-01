/**
 * Picture links on real PostgreSQL: `place_assets` (a place's pictures and its
 * one main picture) and `asset_tags` (smrt-assets tags), both tenant-scoped,
 * with the links going when the picture or the place is deleted. Gated on
 * `DATABASE_URL` (see `scripts/run-with-ci-postgres.mjs`).
 */
import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  AssetTagCollection,
} from '@happyvertical/smrt-assets';
import { GlobalInterceptors } from '@happyvertical/smrt-core';
import {
  createTenantInterceptor,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  PLACE_MAIN_ASSET_RELATIONSHIP,
  PlaceAssetCollection,
  PlaceCollection,
} from './index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('picture links on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let assets: AssetCollection;
  let places: PlaceCollection;

  // Tenant isolation is what an app installs; enforce it here too.
  beforeAll(() => GlobalInterceptors.register(createTenantInterceptor()));
  afterAll(() => GlobalInterceptors.clear());

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        '@happyvertical/smrt-places:Place',
        '@happyvertical/smrt-places:PlaceAsset',
        '@happyvertical/smrt-assets:Asset',
        '@happyvertical/smrt-assets:AssetTag',
        '@happyvertical/smrt-assets:AssetAssociation',
        '@happyvertical/smrt-tags:Tag',
      ],
    });
    assets = await AssetCollection.create({ db: isolated.db });
    places = await PlaceCollection.create({ db: isolated.db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  function picture(tenantId: string, name: string) {
    return withTenant({ tenantId }, () =>
      assets.create({
        name,
        mimeType: 'image/jpeg',
        sourceUri: `file:///tmp/${name}`,
        tenantId,
      }),
    );
  }

  it('links pictures to a place, keeps one main picture, refuses other towns, cascades', async () => {
    const townA = randomUUID();
    const townB = randomUUID();
    const front = await picture(townA, 'front.jpg');
    const side = await picture(townA, 'side.jpg');
    const elsewhere = await picture(townB, 'elsewhere.jpg');

    await withTenant({ tenantId: townA }, async () => {
      const hall = await places.create({ name: 'Town Hall', tenantId: townA });
      await hall.addAsset(front, 'depicts');
      await hall.addAsset(side, 'depicts');
      await hall.setMainAsset(front);
      await hall.setMainAsset(side);
      await expect(hall.addAsset(elsewhere, 'depicts')).rejects.toThrow(
        /another tenant/,
      );

      expect((await hall.getMainAsset())?.id).toBe(side.id);
      expect((await hall.getAssets('depicts')).map((a) => a.id).sort()).toEqual(
        [front.id, side.id].sort(),
      );

      const rows = await isolated?.db.query(
        `SELECT relationship, CAST(tenant_id AS VARCHAR) AS tenant_id, slug, CAST(id AS VARCHAR) AS id
           FROM place_assets ORDER BY relationship`,
      );
      expect(rows?.rows.map((row) => row.relationship)).toEqual([
        'depicts',
        'depicts',
        PLACE_MAIN_ASSET_RELATIONSHIP,
      ]);
      for (const row of rows?.rows ?? []) {
        expect(row.tenant_id).toBe(townA);
        // Junction rows have no name: their slug is their id.
        expect(row.slug).toBe(row.id);
      }

      await side.delete();
      const links = await PlaceAssetCollection.create({ db: isolated?.db });
      expect((await links.list({})).map((l) => l.assetId)).toEqual([front.id]);
      await hall.delete();
      expect(await links.list({})).toEqual([]);
    });
  });

  it('tags pictures in their own town and drops tag links with the picture', async () => {
    const townA = randomUUID();
    const townB = randomUUID();
    const hall = await picture(townA, 'hall.jpg');
    const park = await picture(townA, 'park.jpg');
    const other = await picture(townB, 'other.jpg');

    const tag = await withTenant({ tenantId: townA }, async () => {
      const created = await assets.addTag(hall.id as string, 'Town hall');
      await assets.addTag(hall.id as string, 'town-hall');
      await assets.addTag(park.id as string, 'Town hall');
      return created;
    });
    const otherTag = await withTenant({ tenantId: townB }, () =>
      assets.addTag(other.id as string, 'Town hall'),
    );
    expect(otherTag.id).not.toBe(tag.id);
    expect(tag.tenantId).toBe(townA);

    await withTenant({ tenantId: townA }, async () => {
      expect(
        (await assets.getByTag('town-hall')).map((a) => a.id).sort(),
      ).toEqual([hall.id, park.id].sort());
      // Another town's picture is not visible here, so it cannot be tagged.
      await expect(assets.addTag(other.id as string, 'x')).rejects.toThrow(
        /not found/,
      );
    });

    const count = await isolated?.db.query(
      'SELECT COUNT(*) AS n FROM asset_tags',
    );
    expect(Number(count?.rows[0]?.n)).toBe(3);

    await withTenant({ tenantId: townA }, async () => {
      await hall.delete();
      const links = await AssetTagCollection.create({ db: isolated?.db });
      expect((await links.list({})).map((row) => row.assetId)).toEqual([
        park.id,
      ]);
    });
  });
});
