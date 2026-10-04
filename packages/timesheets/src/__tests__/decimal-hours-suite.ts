import { randomUUID } from 'node:crypto';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVICE_DURATION_HOURS_EVIDENCE,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
  ServiceEvidenceService,
  ServiceTimeEntryCollection,
} from '../index.js';

export function decimalHoursSuite(
  name: string,
  database: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let tenantId = randomUUID();
    const input = {
      tenantId,
      workRefType: '@fixture/builder:WorkPackage',
      workRefId: 'decimal-hours-source',
      participantKind: 'human' as const,
      participantProfileId: randomUUID(),
      source: 'manual' as const,
      description: 'Accepted original hours',
      durationHours: '1.0005',
      evidence: [{ kind: 'original-time', hours: '1.0005' }],
    };
    const terms = {
      hours: '1.0005',
      rateMinorUnits: '12345',
      acceptedAmount: 12351,
    };
    const commercial = {
      priceClient: async () => ({
        amount: 12351,
        version: 'accepted-v1',
        terms,
      }),
      compensateProvider: async () => ({
        amount: 6003,
        version: 'accepted-v1',
        terms,
      }),
    };
    beforeEach(async () => {
      tenantId = randomUUID();
      input.tenantId = tenantId;
      db = await database();
    });
    afterEach(cleanup);

    it('persists exact source text, null measurements and frozen commercial terms through retry/correction', async () => {
      await withTenant({ tenantId }, async () => {
        let fail = true;
        const service = await ServiceEvidenceService.create(
          { db },
          {
            ...commercial,
            priceClient: async () => {
              if (fail) throw new Error('upstream unavailable');
              return commercial.priceClient();
            },
          },
        );
        const entry = await service.record(input);
        const entries = await ServiceTimeEntryCollection.create({ db });
        let loaded = (await entries.get(entry.id!))!;
        expect(loaded.durationSeconds).toBeNull();
        expect(loaded.startedAt).toBeNull();
        expect(loaded.endedAt).toBeNull();
        expect(loaded.durationHoursExact()).toBe('1.0005');
        expect(loaded.durationHours()).toBe(1.0005);
        expect(loaded.toJSON().durationSeconds).toBeNull();
        expect(() => loaded.requireDurationSeconds()).toThrow(
          /no measured durationSeconds/,
        );
        await service.submit(loaded);
        await expect(
          service.approve(loaded, { approvalPath: 'operator' }),
        ).rejects.toThrow('upstream unavailable');
        fail = false;
        await service.approve(loaded, { approvalPath: 'operator' });
        await service.approve(loaded, { approvalPath: 'operator' });
        const charges = await ServiceChargeSnapshotCollection.create({ db });
        const compensation = await ServiceCompensationSnapshotCollection.create(
          { db },
        );
        const [charge] = await charges.list({
          where: { timeEntryId: entry.id },
        });
        const [paid] = await compensation.list({
          where: { timeEntryId: entry.id },
        });
        expect(charge.amount).toBe(12351);
        expect(paid.amount).toBe(6003);
        expect(JSON.parse(charge.rateSnapshot)).toEqual(terms);
        expect(JSON.parse(paid.rateSnapshot)).toEqual(terms);
        expect(await charges.count({ where: { timeEntryId: entry.id } })).toBe(
          1,
        );
        expect(
          await compensation.count({ where: { timeEntryId: entry.id } }),
        ).toBe(1);
        loaded.setEvidence([
          { kind: SERVICE_DURATION_HOURS_EVIDENCE, hours: '2.0005' },
        ]);
        await expect(loaded.save()).rejects.toThrow(/immutable/);
        loaded = (await entries.get(entry.id!))!;
        const correction = await service.correct(loaded, {
          ...input,
          durationHours: '0.5005',
        });
        expect(correction.durationHoursExact()).toBe('0.5005');
        expect(correction.durationSeconds).toBeNull();
        expect(correction.correctionOfId).toBe(entry.id);
        expect((await entries.get(entry.id!))!.durationHoursExact()).toBe(
          '1.0005',
        );
        expect((await charges.get(charge.id!))!.amount).toBe(12351);
        charge.rateSnapshot = '{}';
        await expect(charge.save()).rejects.toThrow(/immutable/);
      });
    });

    it('awaits commercial preflight before freezing evidence or writing either snapshot', async () => {
      await withTenant({ tenantId }, async () => {
        let resolverCalls = 0;
        const service = await ServiceEvidenceService.create(
          { db },
          {
            validateEntry: async () => {
              throw new Error('unsupported hours policy');
            },
            priceClient: async () => {
              resolverCalls++;
              return commercial.priceClient();
            },
            compensateProvider: async () => {
              resolverCalls++;
              return commercial.compensateProvider();
            },
          },
        );
        const entry = await service.record(input);
        await service.submit(entry);
        await expect(
          service.approve(entry, { approvalPath: 'operator' }),
        ).rejects.toThrow('unsupported hours policy');
        expect(resolverCalls).toBe(0);
        const entries = await ServiceTimeEntryCollection.create({ db });
        const reloaded = (await entries.get(entry.id!))!;
        expect(reloaded.status).toBe('submitted');
        expect(reloaded.approvedAt).toBeNull();
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
        const supported = await ServiceEvidenceService.create(
          { db },
          commercial,
        );
        await supported.approve(reloaded, { approvalPath: 'operator' });
        expect(reloaded.status).toBe('approved');
        await service.approve(reloaded, { approvalPath: 'operator' }); // Completed approval retries retain frozen terms without revalidation.
        expect(resolverCalls).toBe(0);
      });
    });

    it('binds every write to an owned transaction and rolls back evidence and snapshots', async () => {
      await withTenant({ tenantId }, async () => {
        if (!db.transaction)
          throw new Error('This contract requires transactions.');
        await expect(
          db.transaction(async (tx) => {
            const service = await ServiceEvidenceService.create(
              { db: tx },
              commercial,
            );
            const entry = await service.record(input);
            await service.submit(entry);
            await service.approve(entry, { approvalPath: 'operator' });
            throw new Error('owned rollback');
          }),
        ).rejects.toThrow('owned rollback');
        const collections = await Promise.all([
          ServiceTimeEntryCollection.create({ db }),
          ServiceChargeSnapshotCollection.create({ db }),
          ServiceCompensationSnapshotCollection.create({ db }),
        ]);
        for (const collection of collections) {
          expect(await collection.count({ where: { tenantId } })).toBe(0);
        }
      });
    });

    it('rejects ambiguous, malformed or unusable quantities before persistence', async () => {
      const service = await ServiceEvidenceService.create({ db });
      for (const durationHours of [
        null,
        '',
        '0',
        '-1',
        '1e-3',
        ' 1.0',
        '.5',
        '1.',
        'NaN',
        'Infinity',
        '9007199254740992',
        `0.${'0'.repeat(400)}1`,
        1.0005,
      ]) {
        await expect(
          service.record({ ...input, durationHours } as never),
        ).rejects.toThrow(/durationHours/);
      }
      for (const fields of [
        { durationSeconds: 3601.8 },
        { durationSeconds: 3600 },
        { startedAt: new Date() },
        { endedAt: new Date() },
      ]) {
        await expect(service.record({ ...input, ...fields })).rejects.toThrow(
          /cannot also supply/,
        );
      }
      await expect(
        service.record({ ...input, source: 'timer' }),
      ).rejects.toThrow(/Timer/);
      await expect(
        service.record({ ...input, source: 'unknown' } as never),
      ).rejects.toThrow(/Unsupported/);
      await expect(
        service.record({
          ...input,
          durationHours: undefined,
          durationSeconds: null,
        }),
      ).rejects.toThrow(/requires durationHours/);
      await expect(
        service.record({ ...input, durationHours: undefined }),
      ).rejects.toThrow(/positive integer/);
      await expect(
        service.record({
          ...input,
          evidence: [{ kind: SERVICE_DURATION_HOURS_EVIDENCE, hours: '1' }],
        }),
      ).rejects.toThrow(/reserved/);
      const entries = await ServiceTimeEntryCollection.create({ db });
      await expect(
        entries.create({
          ...input,
          durationHours: undefined,
          durationSeconds: null,
          evidence: '[]',
        }),
      ).rejects.toThrow(/requires explicit/);
      await expect(
        entries.create({
          ...input,
          durationHours: undefined,
          durationSeconds: null,
          evidence: JSON.stringify([
            { kind: SERVICE_DURATION_HOURS_EVIDENCE, hours: '1' },
            { kind: SERVICE_DURATION_HOURS_EVIDENCE, hours: '2' },
          ]),
        }),
      ).rejects.toThrow(/exactly one/);
      expect(await entries.count({ where: { tenantId } })).toBe(0);
    });

    it('keeps original formatting and existing integer-duration semantics', async () => {
      const service = await ServiceEvidenceService.create({ db });
      const exact = await service.record({
        ...input,
        durationHours: '0001.000500',
      });
      expect(exact.durationHoursExact()).toBe('0001.000500');
      const integer = await service.record({
        ...input,
        durationHours: undefined,
        durationSeconds: 3600,
      });
      expect(integer.durationHoursExact()).toBeNull();
      expect(integer.durationHours()).toBe(1);
      expect(integer.requireDurationSeconds()).toBe(3600);
      integer.evidence = '{}'; // Legacy non-array JSON must not gain new meaning.
      await integer.save();
      expect(integer.durationHoursExact()).toBeNull();
      const entries = await ServiceTimeEntryCollection.create({ db });
      const direct = await entries.create({
        tenantId,
        source: 'import',
        durationSeconds: null,
        evidence: JSON.stringify([
          { kind: SERVICE_DURATION_HOURS_EVIDENCE, hours: '1.000500' },
        ]),
      });
      expect((await entries.get(direct.id!))!.durationHoursExact()).toBe(
        '1.000500',
      );
    });
  });
}
