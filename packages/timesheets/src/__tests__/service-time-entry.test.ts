/**
 * The shared time entry (#3288): a generic work reference, a participant, a
 * duration, an approval state machine, corrections as new rows, and
 * immutable charge / compensation snapshots in integer minor units.
 */
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CommercialSnapshot,
  SERVICE_TIME_ENTRY_FROZEN_FIELDS,
  SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
  ServiceEvidenceService,
  ServiceTimeEntryCollection,
} from '../index.js';

const WORK = {
  workRefType: '@fixture/builder:WorkPackage',
  workRefId: 'wp-7',
};

function commercial(charge: number, compensation: number) {
  return {
    priceClient: async (): Promise<CommercialSnapshot> => ({
      amount: charge,
      version: 'pricing-v1',
      strategy: 'hourly',
      terms: { hourlyRate: charge },
    }),
    compensateProvider: async (): Promise<CommercialSnapshot> => ({
      amount: compensation,
      version: 'terms-v1',
      terms: { hourlyRate: compensation },
    }),
  };
}

describe('ServiceTimeEntry', () => {
  let db: DatabaseInterface;
  let service: ServiceEvidenceService;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    service = await ServiceEvidenceService.create(
      { db },
      commercial(12000, 8000),
    );
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('records against a generic work reference with no domain foreign key', async () => {
    const entry = await service.record({
      ...WORK,
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'timer',
      description: 'Framed the north wall',
      startedAt: new Date('2026-07-01T08:00:00Z'),
      endedAt: new Date('2026-07-01T10:30:00Z'),
    });
    expect(entry).toMatchObject({
      ...WORK,
      status: 'draft',
      durationSeconds: 9000,
      participantKind: 'human',
      participantProfileId: 'profile-1',
    });
    expect(entry.durationHours()).toBe(2.5);

    const fields = ObjectRegistry.getFields(
      '@happyvertical/smrt-timesheets:ServiceTimeEntry',
    );
    expect(fields.has('workRefType')).toBe(true);
    expect(fields.has('caseId')).toBe(false);
    expect(fields.has('specialistId')).toBe(false);

    const entries = await ServiceTimeEntryCollection.create({ db });
    const forWork = await entries.forWork(WORK.workRefType, WORK.workRefId);
    expect(forWork.map((row) => row.id)).toEqual([entry.id]);
  });

  it('records exact decimal-hour-only source evidence without invented seconds', async () => {
    const entry = await service.record({
      ...WORK,
      participantKind: 'agent',
      agentRef: 'agent:importer',
      source: 'import',
      description: 'Exact accepted source',
      durationHours: '1.0005',
      evidence: [{ kind: 'original-time', hours: '1.0005' }],
    });
    const entries = await ServiceTimeEntryCollection.create({ db });
    const loaded = (await entries.get(entry.id!))!;
    expect(loaded.durationSeconds).toBeNull();
    expect(loaded.startedAt).toBeNull();
    expect(loaded.endedAt).toBeNull();
    expect(loaded.durationHoursExact()).toBe('1.0005');
    expect(loaded.durationHours()).toBe(1.0005);
  });

  it('validates the work reference, participant, and period', async () => {
    const base = {
      participantKind: 'agent' as const,
      agentRef: 'agent:estimator',
      source: 'agent' as const,
      description: 'Estimated takeoff',
      durationSeconds: 60,
    };
    await expect(service.record(base)).rejects.toThrow(/work reference/i);
    await expect(
      service.record({ ...base, workRefType: WORK.workRefType }),
    ).rejects.toThrow(/provided together/i);
    await expect(
      service.record({ ...base, ...WORK, agentRef: '' }),
    ).rejects.toThrow(/agentRef/);
    await expect(
      service.record({ ...WORK, ...base, participantKind: 'human' }),
    ).rejects.toThrow(/participantProfileId/);
    await expect(
      service.record({ ...WORK, ...base, durationSeconds: 0 }),
    ).rejects.toThrow(/positive integer/);
  });

  it('enforces the status machine on save', async () => {
    const entry = await service.record({
      ...WORK,
      participantKind: 'agent',
      agentRef: 'agent:estimator',
      source: 'agent',
      description: 'Estimated takeoff',
      durationSeconds: 600,
    });
    entry.status = 'approved';
    await expect(entry.save()).rejects.toThrow(/illegal status transition/);
    expect(SERVICE_TIME_ENTRY_STATUS_TRANSITIONS.approved).toEqual([
      'corrected',
    ]);
  });

  it('approves into immutable minor-unit snapshots and corrects with a new row', async () => {
    const entry = await service.record({
      ...WORK,
      tenantId: 'tenant-1',
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'manual',
      description: 'Hung drywall',
      durationSeconds: 3600,
    });
    await service.submit(entry, 'profile-1');
    await service.approve(entry, {
      actorProfileId: 'profile-lead',
      approvalPath: 'operator',
    });
    expect(entry.status).toBe('approved');

    const [charge] = await (
      await ServiceChargeSnapshotCollection.create({ db })
    ).list({ where: { timeEntryId: entry.id } });
    const [paid] = await (
      await ServiceCompensationSnapshotCollection.create({ db })
    ).list({ where: { timeEntryId: entry.id } });
    expect(charge.amount - paid.amount).toBe(4000);
    charge.amount = 1;
    await expect(charge.save()).rejects.toThrow(/immutable/);

    entry.description = 'rewritten history';
    await expect(entry.save()).rejects.toThrow(/immutable/);
    entry.description = 'Hung drywall';

    const correction = await service.correct(entry, {
      ...WORK,
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'manual',
      description: 'Hung drywall (corrected)',
      durationSeconds: 3300,
    });
    expect(entry.status).toBe('corrected');
    expect(correction).toMatchObject({
      correctionOfId: entry.id,
      tenantId: 'tenant-1',
      status: 'draft',
    });
  });

  it('keeps money integer minor units and exposes the frozen field list', () => {
    for (const className of [
      '@happyvertical/smrt-timesheets:ServiceChargeSnapshot',
      '@happyvertical/smrt-timesheets:ServiceCompensationSnapshot',
    ]) {
      const column = ObjectRegistry.getSchema(className)?.columns.amount;
      expect(column?.type, className).toBe('INTEGER');
    }
    expect(SERVICE_TIME_ENTRY_FROZEN_FIELDS).toContain('durationSeconds');
    expect(SERVICE_TIME_ENTRY_FROZEN_FIELDS).not.toContain('caseId');
  });

  describe('money boundary (#3288 review)', () => {
    async function entryFor(workRefId: string) {
      const entry = await service.record({
        ...WORK,
        workRefId,
        participantKind: 'agent',
        agentRef: 'agent:estimator',
        source: 'agent',
        description: 'Priced work',
        durationSeconds: 3600,
      });
      return String(entry.id);
    }

    it('rejects a non-integer or unsafe amount on direct snapshot writes', async () => {
      const charges = await ServiceChargeSnapshotCollection.create({ db });
      const paid = await ServiceCompensationSnapshotCollection.create({ db });
      for (const amount of [
        19.99,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        2 ** 53,
      ]) {
        const timeEntryId = await entryFor(`wp-money-${amount}`);
        await expect(
          charges.create({ timeEntryId, amount, currency: 'USD' }),
          `charge ${amount}`,
        ).rejects.toThrow(
          /ServiceChargeSnapshot.*integer number of minor units/,
        );
        await expect(
          paid.create({ timeEntryId, amount, currency: 'USD' }),
          `compensation ${amount}`,
        ).rejects.toThrow(
          /ServiceCompensationSnapshot.*integer number of minor units/,
        );
        expect(await charges.list({ where: { timeEntryId } })).toEqual([]);
        expect(await paid.list({ where: { timeEntryId } })).toEqual([]);
      }
    });

    it('refuses fractional resolver output instead of storing it', async () => {
      const fractional = await ServiceEvidenceService.create(
        { db },
        commercial(12000, 8000.5),
      );
      const entry = await fractional.record({
        ...WORK,
        workRefId: 'wp-fractional',
        participantKind: 'agent',
        agentRef: 'agent:estimator',
        source: 'agent',
        description: 'Fractional pay',
        durationSeconds: 3600,
      });
      await fractional.submit(entry);
      await expect(
        fractional.approve(entry, { approvalPath: 'automatic' }),
      ).rejects.toThrow(/integer number of minor units/);
      const timeEntryId = String(entry.id);
      expect(
        await (await ServiceCompensationSnapshotCollection.create({ db })).list(
          {
            where: { timeEntryId },
          },
        ),
      ).toEqual([]);
    });
  });
});
