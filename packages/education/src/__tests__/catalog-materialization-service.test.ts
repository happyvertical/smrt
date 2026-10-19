import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogMaterializationService,
  isPrintableAcquisitionFormat,
} from '../catalog-materialization-service.js';
import { CourseCollection } from '../collections.js';

const acquisition = {
  id: 'acquisition',
  tenantId: 'tenant',
  resourceId: 'resource',
  selectionId: 'selection',
  revision: 'r1',
  format: 'pdf',
  sha256: 'a'.repeat(64),
};
const resource = {
  id: 'resource',
  providerId: 'provider',
  stableId: 'stable',
  revision: 'r1',
  canonicalUrl: 'https://catalog.test/resource',
  title: 'Material',
  subjects: ['Science'],
  visibility: 'catalog' as const,
  licenseEvidence: {
    state: 'verified' as const,
    identifier: 'CC-BY',
    permittedOperations: ['print' as const],
  },
};
function service(overrides: Record<string, unknown> = {}) {
  const store = {
    getAcquisition: vi.fn(async () => acquisition),
    getResource: vi.fn(async () => resource),
    ...overrides,
  };
  const storage = { ensurePrivateAsset: vi.fn() };
  return {
    service: new CatalogMaterializationService(
      {} as never,
      store,
      storage,
      undefined,
      vi.fn(async () => ({ allowed: true, roles: ['guardian'] })),
    ),
    storage,
  };
}
const request = {
  tenantId: 'tenant',
  actorUserId: 'guardian',
  acquisitionId: 'acquisition',
};

describe('CatalogMaterializationService', () => {
  it('recognizes extension and MIME PDF acquisition formats without rewriting them', () => {
    expect(isPrintableAcquisitionFormat('pdf')).toBe(true);
    expect(isPrintableAcquisitionFormat('application/pdf')).toBe(true);
    expect(isPrintableAcquisitionFormat('text/html')).toBe(false);
  });

  it('refuses a cross-tenant acquisition before any private asset materialization', async () => {
    const { service: materializer, storage } = service({
      getAcquisition: vi.fn(async () => undefined),
    });
    await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
      expect(materializer.materialize(request)).rejects.toThrow(
        'Pinned tenant acquisition',
      ),
    );
    expect(storage.ensurePrivateAsset).not.toHaveBeenCalled();
  });

  it('rejects teacher material even when the guardian also has a teacher role', async () => {
    const { service: materializer, storage } = service({
      getResource: vi.fn(async () => ({
        ...resource,
        visibility: 'teacher' as const,
      })),
    });
    await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
      expect(
        materializer.materialize({
          ...request,
        }),
      ).rejects.toThrow('Teacher-only'),
    );
    expect(storage.ensurePrivateAsset).not.toHaveBeenCalled();
  });

  it('leaves no course or asset side effect when a teacher resource is forged into learner materialization', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Course'],
    });
    try {
      const storage = { ensurePrivateAsset: vi.fn() };
      const materializer = new CatalogMaterializationService(
        db,
        {
          getAcquisition: vi.fn(async () => acquisition),
          getResource: vi.fn(async () => ({
            ...resource,
            visibility: 'teacher' as const,
          })),
        },
        storage,
        undefined,
        vi.fn(async () => ({ allowed: true, roles: ['guardian', 'teacher'] })),
      );
      await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
        expect(
          materializer.materialize({
            ...request,
            roles: ['guardian', 'teacher'],
          }),
        ).rejects.toThrow('Teacher-only'),
      );
      expect(storage.ensurePrivateAsset).not.toHaveBeenCalled();
      expect(await (await CourseCollection.create({ db })).list()).toEqual([]);
    } finally {
      await db.close?.();
    }
  });

  it('requires host-derived guardian authorization before private side effects', async () => {
    const storage = { ensurePrivateAsset: vi.fn() };
    const materializer = new CatalogMaterializationService(
      {} as never,
      {
        getAcquisition: vi.fn(async () => acquisition),
        getResource: vi.fn(async () => resource),
      },
      storage,
      undefined,
      vi.fn(async () => ({ allowed: true, roles: ['learner'] })),
    );
    await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
      expect(materializer.materialize(request)).rejects.toThrow('guardian'),
    );
    expect(storage.ensurePrivateAsset).not.toHaveBeenCalled();
  });

  it.each([
    'restricted',
    'conflicting',
  ] as const)('rechecks current %s license evidence before private side effects', async (state) => {
    const { service: materializer, storage } = service({
      getResource: vi.fn(async () => ({
        ...resource,
        licenseEvidence: {
          state,
          identifier: 'CC-BY',
          permittedOperations: ['print'],
        },
      })),
    });
    await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
      expect(materializer.materialize(request)).rejects.toThrow('license'),
    );
    expect(storage.ensurePrivateAsset).not.toHaveBeenCalled();
  });

  it('rejects a currently withdrawn resource before private side effects', async () => {
    const { service: materializer, storage } = service({
      getResource: vi.fn(async () => ({
        ...resource,
        withdrawnAt: new Date(),
      })),
    });
    await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
      expect(materializer.materialize(request)).rejects.toThrow('Withdrawn'),
    );
    expect(storage.ensurePrivateAsset).not.toHaveBeenCalled();
  });

  it('requires the pinned source revision before copying bytes', async () => {
    const { service: materializer, storage } = service({
      getResource: vi.fn(async () => ({ ...resource, revision: 'r2' })),
    });
    await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
      expect(materializer.materialize(request)).rejects.toThrow(
        'Pinned catalog resource revision',
      ),
    );
    expect(storage.ensurePrivateAsset).not.toHaveBeenCalled();
  });
});
