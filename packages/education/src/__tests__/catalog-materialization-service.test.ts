import { withTenant } from '@happyvertical/smrt-tenancy';
import { describe, expect, it, vi } from 'vitest';
import { CatalogMaterializationService } from '../catalog-materialization-service.js';

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
    service: new CatalogMaterializationService({} as never, store, storage),
    storage,
  };
}
const request = {
  tenantId: 'tenant',
  actorUserId: 'guardian',
  roles: ['guardian'],
  acquisitionId: 'acquisition',
};

describe('CatalogMaterializationService', () => {
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

  it('rejects teacher material for a guardian before copying bytes', async () => {
    const { service: materializer, storage } = service({
      getResource: vi.fn(async () => ({
        ...resource,
        visibility: 'teacher' as const,
      })),
    });
    await withTenant({ tenantId: 'tenant', userId: 'guardian' }, async () =>
      expect(materializer.materialize(request)).rejects.toThrow('Teacher-only'),
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
