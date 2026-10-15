import { describe, expect, it } from 'vitest';
import {
  CatalogAuthorizationError,
  CatalogService,
} from '../catalog-service.js';

const courses = {
  list: async () => [
    { title: 'Open course', licenseKind: 'open-license' },
    { title: 'Family copy', licenseKind: 'personal-use-copy' },
  ],
};

describe('CatalogService', () => {
  it('uses an allowlisted scope and hides family copies from ordinary catalog reads', async () => {
    let scopeRequest: unknown;
    const service = new CatalogService(
      courses as never,
      {
        withTenantCatalogReadScope: async (request, callback) => {
          scopeRequest = request;
          return callback();
        },
      },
      () => true,
    );
    await expect(
      service.findVisible({ tenantId: 'family-a', actorUserId: 'guardian-a' }),
    ).resolves.toEqual([{ title: 'Open course', licenseKind: 'open-license' }]);
    expect(scopeRequest).toMatchObject({
      collections: ['@happyvertical/smrt-education:Course'],
    });
  });

  it('requires a separate host authorization before revealing a family copy', async () => {
    const service = new CatalogService(
      courses as never,
      { withTenantCatalogReadScope: async (_request, callback) => callback() },
      ({ action }) => action === 'education.catalog.read',
    );
    await expect(
      service.findVisible({
        tenantId: 'family-a',
        actorUserId: 'learner-a',
        includePrivate: true,
      }),
    ).rejects.toBeInstanceOf(CatalogAuthorizationError);
  });

  it('fails closed before minting a tenancy read capability', async () => {
    let scoped = false;
    const service = new CatalogService(
      courses as never,
      {
        withTenantCatalogReadScope: async (_request, callback) => {
          scoped = true;
          return callback();
        },
      },
      () => false,
    );
    await expect(
      service.findVisible({ tenantId: 'family-a', actorUserId: 'learner-a' }),
    ).rejects.toBeInstanceOf(CatalogAuthorizationError);
    expect(scoped).toBe(false);
  });
});
