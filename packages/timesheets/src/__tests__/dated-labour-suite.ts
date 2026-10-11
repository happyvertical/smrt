import { randomUUID } from 'node:crypto';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DatedLabourCommercialResolver,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
  ServiceEvidenceService,
  ServiceTimeEntryCollection,
} from '../index.js';

export function datedLabourSuite(
  name: string,
  database: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    const tenantId = randomUUID();
    const participantProfileId = randomUUID();
    const input = {
      tenantId,
      participantProfileId,
      participantKind: 'human' as const,
      workRefType: '@fixture/builder:Job',
      workRefId: 'job',
      source: 'manual' as const,
      description: 'Dated work',
      durationHours: '1.0005',
    };
    const config = () => ({
      tenantId,
      participantProfileId,
      workDate: '2024-02-29',
      currency: 'CAD',
      billable: false,
      schedule: [
        {
          effectiveFrom: '2024-01-01',
          currency: 'CAD',
          customer: { id: 'customer', version: 'c1', rateMinor: '12345' },
          wage: { id: 'wage', version: 'w2', rateMinor: '6000' },
          burden: { id: 'burden', version: 'b3', rateMinor: '1000' },
        },
      ],
    });
    beforeEach(async () => {
      db = await database();
    });
    afterEach(cleanup);

    it('resumes partial approval, freezes independent provenance and appends correction evidence', async () => {
      await withTenant({ tenantId }, async () => {
        const terms = config();
        const resolver = new DatedLabourCommercialResolver(terms);
        const entries = await ServiceTimeEntryCollection.create({ db });
        const charges = await ServiceChargeSnapshotCollection.create({ db });
        const compensation = await ServiceCompensationSnapshotCollection.create(
          { db },
        );
        let fail = true;
        const service = new ServiceEvidenceService(
          entries,
          charges,
          compensation,
          {
            validateEntry: (entry) => resolver.validateEntry(entry),
            compensateProvider: (entry) => resolver.compensateProvider(entry),
            priceClient: (entry) => {
              if (fail) throw new Error('Interrupted before customer snapshot');
              return resolver.priceClient(entry);
            },
          },
        );
        const entry = await service.record(input);
        await service.submit(entry);
        await expect(
          service.approve(entry, { approvalPath: 'host-authorized' }),
        ).rejects.toThrow(/Interrupted/);
        expect((await entries.get(entry.id ?? ''))?.status).toBe('approved');
        expect(
          await compensation.count({ where: { timeEntryId: entry.id } }),
        ).toBe(1);
        expect(await charges.count({ where: { timeEntryId: entry.id } })).toBe(
          0,
        );
        terms.schedule[0].wage.rateMinor = '9000';
        terms.workDate = '2025-01-01';
        fail = false;
        await service.approve(entry, { approvalPath: 'host-authorized' });
        await service.approve(entry, { approvalPath: 'host-authorized' });
        const [charge] = await charges.list({
          where: { timeEntryId: entry.id },
        });
        const [paid] = await compensation.list({
          where: { timeEntryId: entry.id },
        });
        expect(charge.amount).toBe(0);
        expect(paid.amount).toBe(7004);
        expect(charge.currency).toBe('CAD');
        expect(paid.currency).toBe('CAD');
        expect(JSON.parse(charge.rateSnapshot).workDate).toBe('2024-02-29');
        expect(JSON.parse(charge.rateSnapshot).customer.version).toBe('c1');
        expect(JSON.parse(charge.rateSnapshot)).not.toHaveProperty('wage');
        expect(JSON.parse(charge.rateSnapshot)).not.toHaveProperty('burden');
        expect(JSON.parse(paid.rateSnapshot).wage).toEqual({
          id: 'wage',
          version: 'w2',
          rateMinor: '6000',
          amount: 6003,
        });
        expect(await charges.count({ where: { timeEntryId: entry.id } })).toBe(
          1,
        );
        expect(
          await compensation.count({ where: { timeEntryId: entry.id } }),
        ).toBe(1);
        entry.setEvidence([
          { kind: '@happyvertical/smrt-timesheets:duration-hours', hours: '2' },
        ]);
        await expect(entry.save()).rejects.toThrow(/immutable/);
        entry.setEvidence([
          {
            kind: '@happyvertical/smrt-timesheets:duration-hours',
            hours: '1.0005',
          },
        ]);
        const correction = await service.correct(entry, {
          ...input,
          durationHours: '0.5',
        });
        await service.submit(correction);
        await service.approve(correction, { approvalPath: 'host-authorized' });
        expect(correction.correctionOfId).toBe(entry.id);
        expect((await entries.get(entry.id ?? ''))?.status).toBe('corrected');
        expect(
          (
            await compensation.list({ where: { timeEntryId: correction.id } })
          )[0].amount,
        ).toBe(3500);
        expect((await compensation.get(paid.id ?? ''))?.amount).toBe(7004);
        paid.rateSnapshot = '{}';
        await expect(paid.save()).rejects.toThrow(/immutable/);
        charge.rateSnapshot = '{}';
        await expect(charge.save()).rejects.toThrow(/immutable/);
      });
    });

    it('rejects wrong worker before approval or snapshot writes', async () => {
      await withTenant({ tenantId }, async () => {
        const service = await ServiceEvidenceService.create(
          { db },
          new DatedLabourCommercialResolver(config()),
        );
        const entry = await service.record({
          ...input,
          participantProfileId: randomUUID(),
        });
        await service.submit(entry);
        await expect(
          service.approve(entry, { approvalPath: 'host-authorized' }),
        ).rejects.toThrow(/identity mismatch/);
        const entries = await ServiceTimeEntryCollection.create({ db });
        expect((await entries.get(entry.id ?? ''))?.status).toBe('submitted');
        expect(
          await (await ServiceChargeSnapshotCollection.create({ db })).count({
            where: { timeEntryId: entry.id },
          }),
        ).toBe(0);
        expect(
          await (
            await ServiceCompensationSnapshotCollection.create({ db })
          ).count({ where: { timeEntryId: entry.id } }),
        ).toBe(0);
      });
    });
  });
}
