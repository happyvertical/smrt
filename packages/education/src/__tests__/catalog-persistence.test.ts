import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CatalogAcquisitionCollection,
  CatalogResourceCollection,
  CatalogSelectionCollection,
} from '../catalog-collections.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

describe('catalog persistence', () => {
  it('persists global metadata separately from tenant-owned revision-pinned selections', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CatalogResource', 'CatalogSelection', 'CatalogAcquisition'],
    });
    try {
      const resources = await CatalogResourceCollection.create({ db });
      const selections = await CatalogSelectionCollection.create({ db });
      const acquisitions = await CatalogAcquisitionCollection.create({ db });
      const resource = await resources.create({
        providerId: 'provider',
        stableId: 'stable-resource',
        revision: 'revision-1',
        title: 'Metadata only',
        canonicalUrl: 'https://catalog.test/resource',
      });
      const tenantId = '11111111-1111-4111-8111-111111111111';
      await withTenant({ tenantId, userId: 'guardian' }, async () => {
        const selection = await selections.create({
          tenantId,
          resourceId: String(resource.id),
          selectedByUserId: 'guardian',
          selectedRevision: 'revision-1',
        });
        const acquisition = await acquisitions.create({
          tenantId,
          resourceId: String(resource.id),
          selectionId: String(selection.id),
          revision: 'revision-1',
          format: 'pdf',
          sha256: 'a'.repeat(64),
        });
        expect(acquisition.tenantId).toBe(tenantId);
      });
      expect(
        (await resources.get(String(resource.id)))?.tenantId,
      ).toBeUndefined();
      expect(
        await db.get('catalog_acquisitions', { tenant_id: tenantId }),
      ).toMatchObject({ revision: 'revision-1', format: 'pdf' });
    } finally {
      await db.close?.();
    }
  });
});
