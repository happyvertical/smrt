import { describe, expect, it } from 'vitest';
import {
  BillingRelationship,
  BillingRelationshipError,
  BillingRelationshipService,
} from '../billing-relationship.js';
import { withSystemContext, withTenant } from '../context.js';
import * as tenancyRoot from '../index.js';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const C = 'cccccccc-3333-4333-8333-cccccccccccc';
const D = 'dddddddd-4444-4444-8444-dddddddddddd';

async function setup(ids = [A, B, C, D]) {
  const known = new Set(ids);
  const service = await BillingRelationshipService.create({
    db: { type: 'sqlite', url: ':memory:' },
    tenantExists: async (id) => known.has(id),
  });
  return service;
}

describe('smrt#3058 billing relationships', () => {
  it('exports the manifest model from the root and withholds the raw collection', () => {
    // Generated consumer registration imports every public non-collection
    // manifest object from the package root; omitting the model broke every
    // dependent's register.js (smrt#3074). The collection stays unexported so
    // callers cannot bypass the service's checks through create().
    expect(tenancyRoot.BillingRelationship).toBe(BillingRelationship);
    expect('BillingRelationshipCollection' in tenancyRoot).toBe(false);
  });

  it('defaults to self billing and switches owners without changing child identity', async () => {
    const service = await setup();
    await withSystemContext(async () => {
      expect(await service.resolveBillingOwner(B)).toBe(B);
      expect(await service.getRelationship(B)).toBeNull();

      await service.setRelationship({
        childTenantId: B,
        resellerTenantId: A,
        billingOwnerMode: 'reseller',
      });
      expect(await service.resolveBillingOwner(B)).toBe(A);
      expect(await service.listChildrenBilledTo(A)).toEqual([B]);

      await service.setRelationship({
        childTenantId: B,
        resellerTenantId: A,
        billingOwnerMode: 'self',
      });
      expect(await service.resolveBillingOwner(B)).toBe(B);
      expect(await service.listChildrenBilledTo(A)).toEqual([]);

      await service.setRelationship({
        childTenantId: B,
        resellerTenantId: C,
        billingOwnerMode: 'reseller',
      });
      expect(await service.resolveBillingOwner(B)).toBe(C);
      expect(await service.listChildrenBilledTo(C)).toEqual([B]);
      expect(await service.listChildrenBilledTo(A)).toEqual([]);

      await service.clearRelationship(B);
      expect(await service.resolveBillingOwner(B)).toBe(B);
      expect(await service.getRelationship(B)).toBeNull();
    });
  });

  it('stores only one owner per child across repeated and concurrent changes', async () => {
    const service = await setup();
    await withSystemContext(async () => {
      await Promise.all([
        service.setRelationship({
          childTenantId: D,
          resellerTenantId: A,
          billingOwnerMode: 'reseller',
        }),
        service.setRelationship({
          childTenantId: D,
          resellerTenantId: B,
          billingOwnerMode: 'reseller',
        }),
      ]);
      const billedToA = await service.listChildrenBilledTo(A);
      const billedToB = await service.listChildrenBilledTo(B);
      expect([...billedToA, ...billedToB]).toEqual([D]);
      expect([A, B]).toContain(await service.resolveBillingOwner(D));
    });
  });

  it('rejects missing tenants, malformed modes, self links, and cycles before changing state', async () => {
    const service = await setup();
    await withSystemContext(async () => {
      await service.setRelationship({
        childTenantId: B,
        resellerTenantId: A,
        billingOwnerMode: 'reseller',
      });
      await service.setRelationship({
        childTenantId: C,
        resellerTenantId: B,
        billingOwnerMode: 'reseller',
      });
      await expect(
        service.setRelationship({
          childTenantId: A,
          resellerTenantId: C,
          billingOwnerMode: 'reseller',
        }),
      ).rejects.toMatchObject({ code: 'CIRCULAR_RELATIONSHIP' });
      await expect(
        service.setRelationship({
          childTenantId: A,
          resellerTenantId: A,
          billingOwnerMode: 'self',
        }),
      ).rejects.toMatchObject({ code: 'CIRCULAR_RELATIONSHIP' });
      await expect(
        service.setRelationship({
          childTenantId: A,
          resellerTenantId: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
          billingOwnerMode: 'reseller',
        }),
      ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
      await expect(
        service.setRelationship({
          childTenantId: A,
          resellerTenantId: D,
          billingOwnerMode: 'other' as never,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_OWNER_MODE' });
      await expect(
        service.resolveBillingOwner(' missing '),
      ).rejects.toBeInstanceOf(BillingRelationshipError);
      expect(await service.resolveBillingOwner(A)).toBe(A);
      expect(await service.resolveBillingOwner(B)).toBe(A);
      expect(await service.resolveBillingOwner(C)).toBe(B);
    });
  });

  it('limits reads to child, reseller, or system and mutations to a privileged actor', async () => {
    const service = await setup();
    await withSystemContext(() =>
      service.setRelationship({
        childTenantId: B,
        resellerTenantId: A,
        billingOwnerMode: 'reseller',
      }),
    );
    await withTenant({ tenantId: B }, async () => {
      expect(await service.resolveBillingOwner(B)).toBe(A);
      await expect(service.listChildrenBilledTo(A)).rejects.toMatchObject({
        code: 'TENANT_ISOLATION_VIOLATION',
      });
      await expect(service.clearRelationship(B)).rejects.toMatchObject({
        code: 'TENANT_ISOLATION_VIOLATION',
      });
    });
    await withTenant({ tenantId: A }, async () => {
      expect(await service.resolveBillingOwner(B)).toBe(A);
      expect(await service.listChildrenBilledTo(A)).toEqual([B]);
    });
    await withTenant({ tenantId: C }, async () => {
      await expect(service.resolveBillingOwner(B)).rejects.toMatchObject({
        code: 'TENANT_ISOLATION_VIOLATION',
      });
      await expect(service.getRelationship(B)).rejects.toMatchObject({
        code: 'TENANT_ISOLATION_VIOLATION',
      });
    });
    await expect(service.resolveBillingOwner(B)).rejects.toMatchObject({
      code: 'TENANT_ISOLATION_VIOLATION',
    });
  });

  it('allows a host authorizer to manage a relationship without a system context', async () => {
    const service = await BillingRelationshipService.create({
      db: { type: 'sqlite', url: ':memory:' },
      tenantExists: async (id) => [A, B].includes(id),
      authorize: async ({ action, resellerTenantId }) =>
        action === 'manage' && resellerTenantId === A,
    });
    await withTenant({ tenantId: A }, async () => {
      await service.setRelationship({
        childTenantId: B,
        resellerTenantId: A,
        billingOwnerMode: 'self',
      });
      expect(await service.getRelationship(B)).toMatchObject({
        billingOwnerTenantId: B,
      });
    });
  });

  it('requires authority over the old reseller before reparenting', async () => {
    const service = await BillingRelationshipService.create({
      db: { type: 'sqlite', url: ':memory:' },
      tenantExists: async (id) => [A, B, C].includes(id),
      authorize: async ({ action, resellerTenantId }) =>
        action === 'manage' && resellerTenantId === C,
    });
    await withSystemContext(() =>
      service.setRelationship({
        childTenantId: B,
        resellerTenantId: A,
        billingOwnerMode: 'reseller',
      }),
    );
    await withTenant({ tenantId: C }, async () => {
      await expect(
        service.setRelationship({
          childTenantId: B,
          resellerTenantId: C,
          billingOwnerMode: 'reseller',
        }),
      ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
    });
    expect(await withSystemContext(() => service.resolveBillingOwner(B))).toBe(
      A,
    );
  });

  it('preserves ownership and cycle checks on DuckDB', async () => {
    const service = await BillingRelationshipService.create({
      db: { type: 'duckdb', url: ':memory:' },
      tenantExists: async (id) => [A, B, C].includes(id),
    });
    await withSystemContext(async () => {
      await service.setRelationship({
        childTenantId: B,
        resellerTenantId: A,
        billingOwnerMode: 'reseller',
      });
      await service.setRelationship({
        childTenantId: C,
        resellerTenantId: B,
        billingOwnerMode: 'self',
      });
      expect(await service.resolveBillingOwner(B)).toBe(A);
      expect(await service.resolveBillingOwner(C)).toBe(C);
      await expect(
        service.setRelationship({
          childTenantId: A,
          resellerTenantId: C,
          billingOwnerMode: 'reseller',
        }),
      ).rejects.toMatchObject({ code: 'CIRCULAR_RELATIONSHIP' });
      await service.clearRelationship(B);
      expect(await service.resolveBillingOwner(B)).toBe(B);
    });
  });
});
