import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { BillingRelationshipService } from '../billing-relationship.js';
import { withSystemContext } from '../context.js';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const C = 'cccccccc-3333-4333-8333-cccccccccccc';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('smrt#3058 PostgreSQL billing relationships', () => {
  it('keeps one owner per child and serializes competing parent changes', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['BillingRelationship'],
    });
    try {
      expect(isolated.config.type).toBe('postgres');
      const service = await BillingRelationshipService.create({
        db: isolated.db,
        tenantExists: async (id) => [A, B, C].includes(id),
      });
      await withSystemContext(async () => {
        await Promise.all([
          service.setRelationship({
            childTenantId: C,
            resellerTenantId: A,
            billingOwnerMode: 'reseller',
          }),
          service.setRelationship({
            childTenantId: C,
            resellerTenantId: B,
            billingOwnerMode: 'reseller',
          }),
        ]);
        const rows = await isolated.db.query(
          'SELECT child_tenant_id FROM _smrt_billing_relationships WHERE child_tenant_id = ?',
          C,
        );
        expect(rows.rows).toHaveLength(1);
        expect([A, B]).toContain(await service.resolveBillingOwner(C));
      });
    } finally {
      await isolated.cleanup();
    }
  });

  it('rejects a cycle without changing the existing owner', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['BillingRelationship'],
    });
    try {
      const service = await BillingRelationshipService.create({
        db: isolated.db,
        tenantExists: async (id) => [A, B].includes(id),
      });
      await withSystemContext(async () => {
        await service.setRelationship({
          childTenantId: B,
          resellerTenantId: A,
          billingOwnerMode: 'reseller',
        });
        await expect(
          service.setRelationship({
            childTenantId: A,
            resellerTenantId: B,
            billingOwnerMode: 'reseller',
          }),
        ).rejects.toMatchObject({ code: 'CIRCULAR_RELATIONSHIP' });
        expect(await service.resolveBillingOwner(B)).toBe(A);
      });
    } finally {
      await isolated.cleanup();
    }
  });

  it('canonicalizes mixed-case UUIDs before self-link and owner checks', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['BillingRelationship'],
    });
    try {
      const service = await BillingRelationshipService.create({
        db: isolated.db,
        tenantExists: async (id) => [A, B].includes(id.toLowerCase()),
      });
      await withSystemContext(async () => {
        await expect(
          service.setRelationship({
            childTenantId: A.toUpperCase(),
            resellerTenantId: A,
            billingOwnerMode: 'reseller',
          }),
        ).rejects.toMatchObject({ code: 'CIRCULAR_RELATIONSHIP' });
        expect(await service.resolveBillingOwner(A)).toBe(A);

        await service.setRelationship({
          childTenantId: B.toUpperCase(),
          resellerTenantId: A,
          billingOwnerMode: 'reseller',
        });
        expect(await service.resolveBillingOwner(B)).toBe(A);
        expect(await service.resolveBillingOwner(B.toUpperCase())).toBe(A);
        expect(await service.listChildrenBilledTo(A.toUpperCase())).toEqual([
          B,
        ]);
        const rows = await isolated.db.query(
          'SELECT child_tenant_id FROM _smrt_billing_relationships',
        );
        expect(rows.rows).toHaveLength(1);
      });
    } finally {
      await isolated.cleanup();
    }
  });

  it('serializes opposing concurrent links so only one can commit', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['BillingRelationship'],
    });
    try {
      const service = await BillingRelationshipService.create({
        db: isolated.db,
        tenantExists: async (id) => [A, B].includes(id),
      });
      await withSystemContext(async () => {
        const outcomes = await Promise.allSettled([
          service.setRelationship({
            childTenantId: A,
            resellerTenantId: B,
            billingOwnerMode: 'reseller',
          }),
          service.setRelationship({
            childTenantId: B,
            resellerTenantId: A,
            billingOwnerMode: 'reseller',
          }),
        ]);
        expect(
          outcomes.filter((outcome) => outcome.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          outcomes.filter((outcome) => outcome.status === 'rejected'),
        ).toHaveLength(1);
        const ownerA = await service.resolveBillingOwner(A);
        const ownerB = await service.resolveBillingOwner(B);
        expect([ownerA, ownerB]).toEqual(ownerA === A ? [A, A] : [B, B]);
      });
    } finally {
      await isolated.cleanup();
    }
  });
});
