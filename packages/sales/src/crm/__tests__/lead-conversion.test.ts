/** Caller-transaction receipt and tenant boundary coverage. */
import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { LeadConversionService } from '../services/LeadConversionService.js';

describe('LeadConversionService', () => {
  let db: DatabaseInterface;
  let tenantId: string;
  let leadId: string;
  const actorProfileId = randomUUID();
  beforeEach(async () => {
    enableTenancy();
    tenantId = randomUUID();
    db = await getTestDatabase();
    const leads = await LeadCollection.create({ db });
    await SalesActivityCollection.create({ db });
    leadId = (
      await withTenant({ tenantId }, () =>
        leads.create({ name: 'Pending prospect' }),
      )
    ).id as string;
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });
  const scope = () => ({ tenantId, leadId, targetKind: 'draft-project' });
  const record = () => ({
    ...scope(),
    targetId: randomUUID(),
    actorProfileId,
    metadata: { childTenantId: randomUUID(), source: 'approval' },
  });
  async function transaction<T>(
    fn: (service: LeadConversionService) => Promise<T>,
  ) {
    return await withTenant({ tenantId }, () =>
      db.transaction(async (tx) =>
        fn(
          await LeadConversionService.create({ db: tx, transaction: 'caller' }),
        ),
      ),
    );
  }

  it('records pending conversion without changing CRM status; exact replay retains original actor', async () => {
    const input = record();
    const receipt = await transaction(async (service) => {
      expect(await service.getForLead(scope())).toBeNull();
      const first = await service.recordForLead(input);
      expect(
        await service.recordForLead({
          ...input,
          actorProfileId: randomUUID(),
          metadata: {
            source: 'approval',
            childTenantId: input.metadata.childTenantId,
          },
        }),
      ).toEqual(first);
      return first;
    });
    const leads = await LeadCollection.create({ db });
    await withTenant({ tenantId }, async () => {
      expect((await leads.get({ id: leadId }))?.status).toBe('new');
      const activities = await SalesActivityCollection.create({ db });
      expect(
        await activities.list({ where: { subjectId: leadId } }),
      ).toHaveLength(1);
    });
    expect(await transaction((service) => service.getForLead(scope()))).toEqual(
      receipt,
    );
  });

  it('resolves only matching tenant-local target receipts with canonical lead ids', async () => {
    const input = record();
    const first = await transaction((service) => service.recordForLead(input));
    await transaction(async (service) => {
      expect(
        await service.findForTarget({
          tenantId,
          targetKind: input.targetKind,
          targetId: input.targetId,
        }),
      ).toEqual([first]);
      expect(
        await service.findForTarget({
          tenantId,
          targetKind: 'other',
          targetId: input.targetId,
        }),
      ).toEqual([]);
      expect(
        await service.findForTarget({
          tenantId,
          targetKind: input.targetKind,
          targetId: randomUUID(),
        }),
      ).toEqual([]);
      await expect(
        service.findForTarget({
          tenantId: randomUUID(),
          targetKind: input.targetKind,
          targetId: input.targetId,
        }),
      ).rejects.toThrow('unavailable');
    });
  });

  it('permits pure reads without asserting a caller transaction and refuses writes', async () => {
    const input = record();
    const receipt = await transaction((service) =>
      service.recordForLead(input),
    );
    const readService = await LeadConversionService.create({ db });
    await withTenant({ tenantId }, async () => {
      expect(await readService.getForLead(scope())).toEqual(receipt);
      expect(
        await readService.findForTarget({
          tenantId,
          targetKind: input.targetKind,
          targetId: input.targetId,
        }),
      ).toEqual([receipt]);
      await expect(readService.recordForLead(input)).rejects.toThrow(
        'caller-owned transaction',
      );
    });
  });

  it('refuses changed target and changed metadata without replacing evidence', async () => {
    const input = record();
    const receipt = await transaction((service) =>
      service.recordForLead(input),
    );
    await expect(
      transaction((service) =>
        service.recordForLead({ ...input, targetId: randomUUID() }),
      ),
    ).rejects.toThrow('different intent');
    await expect(
      transaction((service) =>
        service.recordForLead({ ...input, metadata: {} }),
      ),
    ).rejects.toThrow('different intent');
    expect(await transaction((service) => service.getForLead(scope()))).toEqual(
      receipt,
    );
  });

  it('fails closed for absent context, tenant mismatch, missing and foreign leads', async () => {
    const service = await LeadConversionService.create({
      db,
      transaction: 'caller',
    });
    await expect(service.getForLead(scope())).rejects.toThrow();
    await expect(
      transaction((bound) =>
        bound.getForLead({ ...scope(), tenantId: randomUUID() }),
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      transaction((bound) =>
        bound.getForLead({ ...scope(), leadId: randomUUID() }),
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      withTenant({ tenantId: randomUUID() }, () =>
        service.getForLead({ ...scope(), tenantId: randomUUID() }),
      ),
    ).rejects.toThrow('unavailable');
    const foreignTenantId = randomUUID();
    await expect(
      withTenant({ tenantId: foreignTenantId }, () =>
        service.getForLead({ ...scope(), tenantId: foreignTenantId }),
      ),
    ).rejects.toThrow('unavailable');
  });

  it('rolls back receipt with caller changes and never starts nested transactions', async () => {
    const input = record();
    const hostMarkerId = randomUUID();
    await expect(
      withTenant({ tenantId }, () =>
        db.transaction(async (tx) => {
          const service = await LeadConversionService.create({
            db: tx,
            transaction: 'caller',
          });
          const activities = await SalesActivityCollection.create({
            db: tx,
            _reuseInitializedDb: true,
            _deferRuntimeInitialization: true,
          });
          await activities.create({
            id: hostMarkerId,
            tenantId,
            subjectKind: 'lead',
            subjectId: leadId,
            activityKind: 'note',
            summary: 'Host mutation',
          });
          await service.recordForLead(input);
          throw new Error('host failed');
        }),
      ),
    ).rejects.toThrow('host failed');
    await withTenant({ tenantId }, async () => {
      const activities = await SalesActivityCollection.create({ db });
      expect(
        await activities.get({ id: hostMarkerId }, { cache: false }),
      ).toBeNull();
    });
    expect(
      await transaction((service) => service.getForLead(scope())),
    ).toBeNull();
    await withTenant({ tenantId }, () =>
      db.transaction(async (tx) => {
        const spy = vi
          .spyOn(tx, 'transaction')
          .mockRejectedValue(new Error('nested transaction'));
        const service = await LeadConversionService.create({
          db: tx,
          transaction: 'caller',
        });
        await service.recordForLead(input);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }),
    );
  });

  it('rejects malformed ids and non-JSON metadata before persistence', async () => {
    await expect(
      transaction((service) =>
        service.recordForLead({ ...record(), targetId: ' ' }),
      ),
    ).rejects.toThrow('targetId');
    await expect(
      transaction((service) =>
        service.recordForLead({ ...record(), actorProfileId: '' }),
      ),
    ).rejects.toThrow('actorProfileId');
    await expect(
      transaction((service) =>
        service.recordForLead({
          ...record(),
          metadata: [] as unknown as Record<string, unknown>,
        }),
      ),
    ).rejects.toThrow('JSON object');
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    await expect(
      transaction((service) =>
        service.recordForLead({ ...record(), metadata }),
      ),
    ).rejects.toThrow('JSON data');
    await expect(
      transaction((service) =>
        service.recordForLead({ ...record(), metadata: { value: undefined } }),
      ),
    ).rejects.toThrow('JSON data');
    expect(
      await transaction((service) => service.getForLead(scope())),
    ).toBeNull();
  });
});
