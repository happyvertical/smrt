import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Employment,
  EmploymentChange,
  EmploymentChangeCollection,
  EmploymentCollection,
  EmploymentService,
  EmploymentTermCollection,
  type HrActor,
  HrError,
  type HrErrorCode,
  type HrEvent,
} from '../index.js';
import {
  HeldQualification,
  HeldQualificationChangeCollection,
  HeldQualificationCollection,
  Qualification,
  QualificationCollection,
} from '../qualifications/models.js';
import { insertHr, persistHr } from '../write.js';

const uuid = () => crypto.randomUUID();

async function code(run: Promise<unknown>): Promise<HrErrorCode | 'no-error'> {
  try {
    await run;
    return 'no-error';
  } catch (error) {
    if (error instanceof HrError) return error.code;
    throw error;
  }
}

/** Employment behavior, shared by the SQLite and PostgreSQL suites. */
export function employmentSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let actor: HrActor;
    let events: HrEvent[];
    let service: EmploymentService;
    let number = 0;
    beforeEach(async () => {
      db = await create();
      actor = { tenantId: uuid(), profileId: uuid() };
      events = [];
      service = new EmploymentService(db, actor, {
        onEvent: (event) => {
          events.push(event);
        },
      });
    });
    afterEach(async () => {
      await cleanup();
    });

    const hire = (
      overrides: Partial<Parameters<EmploymentService['hire']>[0]> = {},
      using: EmploymentService = service,
    ) =>
      using.hire({
        profileId: uuid(),
        employeeNumber: `E-${++number}`,
        startedOn: '2026-01-05',
        ...overrides,
      });

    describe('hiring, ending and rehiring', () => {
      it('hires a person as an active employee with a first open term and a hired change', async () => {
        const profileId = uuid();
        const employment = await hire({
          profileId,
          employeeNumber: '  E-100  ',
          position: 'Welder',
        });
        expect(employment).toMatchObject({
          tenantId: actor.tenantId,
          profileId,
          employeeNumber: 'E-100',
          workerType: 'employee',
          position: 'Welder',
          status: 'active',
          userId: null,
          employerProfileId: null,
        });
        const id = employment.id as string;
        expect(await service.terms(id)).toEqual([
          expect.objectContaining({
            employmentId: id,
            startedOn: '2026-01-05',
            endedOn: null,
          }),
        ]);
        expect(await service.history(id)).toEqual([
          expect.objectContaining({
            kind: 'hired',
            effectiveOn: '2026-01-05',
            actorProfileId: actor.profileId,
          }),
        ]);
        expect((await service.findByProfile(profileId))?.id).toBe(id);
        expect((await service.findByEmployeeNumber(' E-100 '))?.id).toBe(id);
        expect(await service.findByProfile(uuid())).toBeNull();
        expect(await service.findByEmployeeNumber('nobody')).toBeNull();
      });

      it('rejects a hire without an employee number, a real date or a kebab-case worker type', async () => {
        expect(await code(hire({ employeeNumber: '   ' }))).toBe('HR_INVALID');
        expect(await code(hire({ startedOn: '2026-02-30' }))).toBe(
          'HR_INVALID',
        );
        expect(await code(hire({ startedOn: '05/01/2026' }))).toBe(
          'HR_INVALID',
        );
        expect(await code(hire({ workerType: 'Full Time' }))).toBe(
          'HR_INVALID',
        );
        expect(await code(hire({ profileId: ' ' }))).toBe('HR_INVALID');
        expect(
          (await hire({ workerType: 'seasonal-contractor' })).workerType,
        ).toBe('seasonal-contractor');
      });

      it('keeps one stable employment id and a full term history through end and rehire', async () => {
        const hired = await hire({ position: 'Labourer' });
        const id = hired.id as string;

        const ended = await service.end(id, {
          endedOn: '2026-03-31',
          reason: 'Season over',
        });
        expect(ended.id).toBe(id);
        expect(ended.status).toBe('ended');

        const rehired = await service.rehire(id, {
          startedOn: '2026-06-01',
          position: 'Foreman',
          workerType: 'contractor',
        });
        expect(rehired).toMatchObject({
          id,
          status: 'active',
          position: 'Foreman',
          workerType: 'contractor',
        });

        expect(
          (await service.terms(id)).map((term) => [
            term.startedOn,
            term.endedOn,
            term.endReason,
          ]),
        ).toEqual([
          ['2026-01-05', '2026-03-31', 'Season over'],
          ['2026-06-01', null, ''],
        ]);
        expect(
          (await service.history(id)).map((change) => [
            change.kind,
            change.effectiveOn,
            change.fromValue,
            change.toValue,
          ]),
        ).toEqual([
          ['hired', '2026-01-05', null, null],
          ['ended', '2026-03-31', null, null],
          ['rehired', '2026-06-01', null, null],
          ['position-changed', '2026-06-01', 'Labourer', 'Foreman'],
          ['worker-type-changed', '2026-06-01', 'employee', 'contractor'],
        ]);
        expect(
          (await service.history(id)).every(
            (change) => change.actorProfileId === actor.profileId,
          ),
        ).toBe(true);
      });

      it('rehires without position or worker-type changes when they are not given', async () => {
        const { id } = await hire({ position: 'Labourer' });
        await service.end(id as string, { endedOn: '2026-02-01' });
        const rehired = await service.rehire(id as string, {
          startedOn: '2026-02-02',
        });
        expect(rehired.position).toBe('Labourer');
        expect(
          (await service.history(id as string)).map((change) => change.kind),
        ).toEqual(['hired', 'ended', 'rehired']);
      });

      it('refuses to end an employment twice or before its term started', async () => {
        const { id } = await hire();
        expect(
          await code(service.end(id as string, { endedOn: '2026-01-04' })),
        ).toBe('HR_INVALID');
        // Ending on the start day is a one-day term.
        await service.end(id as string, { endedOn: '2026-01-05' });
        expect(
          await code(service.end(id as string, { endedOn: '2026-01-06' })),
        ).toBe('HR_STATUS_TRANSITION');
      });

      it('refuses to rehire someone still employed, or into a term that overlaps the last one', async () => {
        const { id } = await hire();
        expect(
          await code(service.rehire(id as string, { startedOn: '2026-02-01' })),
        ).toBe('HR_STATUS_TRANSITION');
        await service.end(id as string, { endedOn: '2026-03-31' });
        expect(
          await code(service.rehire(id as string, { startedOn: '2026-03-31' })),
        ).toBe('HR_TERM_OVERLAP');
        expect(
          await code(service.rehire(id as string, { startedOn: '2026-02-01' })),
        ).toBe('HR_TERM_OVERLAP');
        expect((await service.terms(id as string)).length).toBe(1);
        await service.rehire(id as string, { startedOn: '2026-04-01' });
        expect((await service.get(id as string)).status).toBe('active');
      });

      it('keeps the optional employer profile given at hire', async () => {
        const employerProfileId = uuid();
        const hired = await hire({ employerProfileId });
        expect(hired.employerProfileId).toBe(employerProfileId);
        expect((await service.get(hired.id as string)).employerProfileId).toBe(
          employerProfileId,
        );
        expect(
          (await service.findByProfile(hired.profileId))?.employerProfileId,
        ).toBe(employerProfileId);
        expect(await code(hire({ employerProfileId: ' ' }))).toBe('HR_INVALID');
      });

      it('refuses to end an employment before a change already recorded in the term, so no change outlives its term', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        await service.placeOnLeave(id as string, { effectiveOn: '2026-09-01' });
        expect(
          await code(service.end(id as string, { endedOn: '2026-04-15' })),
        ).toBe('HR_INVALID');
        expect((await service.get(id as string)).status).toBe('on-leave');
        expect((await service.terms(id as string))[0].endedOn).toBeNull();
        // The same holds for a position or worker-type change.
        const other = await hire();
        await service.changePosition(other.id as string, {
          position: 'Foreman',
          effectiveOn: '2026-08-01',
        });
        expect(
          await code(
            service.end(other.id as string, { endedOn: '2026-07-31' }),
          ),
        ).toBe('HR_INVALID');
        // Ending on or after the latest change is fine, and replay stays
        // inside the term.
        await service.end(id as string, { endedOn: '2026-09-01' });
        expect(await service.check(profileId, '2026-09-01')).toMatchObject({
          ok: true,
          onLeave: true,
        });
        expect(await service.asOf(id as string, '2026-09-02')).toMatchObject({
          employed: false,
          onLeave: false,
        });
      });

      it('refuses a rehire that starts before a change already recorded', async () => {
        const { id } = await hire();
        await service.end(id as string, { endedOn: '2026-03-31' });
        // A change dated after its term, as rows written before the end-date
        // rule could hold.
        await withTenant({ tenantId: actor.tenantId }, async () => {
          await insertHr(EmploymentChange, db, {
            tenantId: actor.tenantId,
            employmentId: id as string,
            kind: 'leave-started',
            effectiveOn: '2026-09-01',
            actorProfileId: actor.profileId,
          });
        });
        expect(
          await code(service.rehire(id as string, { startedOn: '2026-06-01' })),
        ).toBe('HR_INVALID');
        expect((await service.terms(id as string)).length).toBe(1);
        await service.rehire(id as string, { startedOn: '2026-09-01' });
        expect((await service.get(id as string)).status).toBe('active');
      });

      it('reports an unknown employment as not found', async () => {
        expect(await code(service.get(uuid()))).toBe('HR_NOT_FOUND');
        expect(await code(service.end(uuid(), { endedOn: '2026-01-05' }))).toBe(
          'HR_NOT_FOUND',
        );
        expect(await code(service.terms(uuid()))).toBe('HR_NOT_FOUND');
        expect(await code(service.history(uuid()))).toBe('HR_NOT_FOUND');
      });
    });

    describe('who is employed on a date', () => {
      it('answers from terms across two terms and the gap between them, including the start day and the inclusive last day', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        await service.end(id as string, { endedOn: '2026-03-31' });
        await service.rehire(id as string, { startedOn: '2026-06-01' });
        const other = await hire({ startedOn: '2026-04-15' });

        const employedIds = async (on: string) =>
          (await service.employedOn(on))
            .map((employment) => employment.id)
            .sort();
        expect(await employedIds('2026-01-04')).toEqual([]);
        expect(await employedIds('2026-01-05')).toEqual([id]);
        expect(await employedIds('2026-03-31')).toEqual([id]);
        expect(await employedIds('2026-04-01')).toEqual([]);
        expect(await employedIds('2026-05-31')).toEqual([other.id]);
        expect(await employedIds('2026-06-01')).toEqual([id, other.id].sort());
        expect(await employedIds('2030-01-01')).toEqual([id, other.id].sort());
        expect(await code(service.employedOn('yesterday'))).toBe('HR_INVALID');
      });

      it('explains why a person is not employed: never hired, not started yet, or ended', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        await service.end(id as string, { endedOn: '2026-03-31' });
        await service.rehire(id as string, { startedOn: '2026-06-01' });

        expect(await service.check(uuid(), '2026-02-01')).toEqual({
          ok: false,
          reason: 'not-employed',
        });
        expect(await service.check('  ', '2026-02-01')).toEqual({
          ok: false,
          reason: 'not-employed',
        });
        expect(await service.check(profileId, '2026-01-04')).toEqual({
          ok: false,
          reason: 'not-started',
        });
        expect(await service.check(profileId, '2026-01-05')).toEqual({
          ok: true,
          employmentId: id,
          onLeave: false,
        });
        expect(await service.check(profileId, '2026-03-31')).toEqual({
          ok: true,
          employmentId: id,
          onLeave: false,
        });
        // The gap between two terms reads as ended, not as not-started.
        expect(await service.check(profileId, '2026-04-01')).toEqual({
          ok: false,
          reason: 'ended',
        });
        expect(await service.check(profileId, '2026-06-01')).toEqual({
          ok: true,
          employmentId: id,
          onLeave: false,
        });
        await service.end(id as string, { endedOn: '2026-08-31' });
        expect(await service.check(profileId, '2026-09-01')).toEqual({
          ok: false,
          reason: 'ended',
        });
        expect(await code(service.check(profileId, '2026-13-01'))).toBe(
          'HR_INVALID',
        );
      });

      it('still counts a person on leave as employed, and answers past dates with the leave state of that day', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        const onLeave = await service.placeOnLeave(id as string, {
          effectiveOn: '2026-02-10',
          note: 'Parental leave',
        });
        expect(onLeave.status).toBe('on-leave');
        expect(
          (await service.employedOn('2026-02-15')).map((row) => row.id),
        ).toEqual([id]);
        expect(await service.check(profileId, '2026-02-15')).toEqual({
          ok: true,
          employmentId: id,
          onLeave: true,
        });

        const back = await service.returnFromLeave(id as string, {
          effectiveOn: '2026-03-01',
        });
        expect(back.status).toBe('active');
        const leaveOn = async (on: string) => {
          const result = await service.check(profileId, on);
          return result.ok ? result.onLeave : result.reason;
        };
        expect(await leaveOn('2026-02-09')).toBe(false);
        expect(await leaveOn('2026-02-10')).toBe(true);
        expect(await leaveOn('2026-02-28')).toBe(true);
        expect(await leaveOn('2026-03-01')).toBe(false);
        expect(await leaveOn('2026-12-01')).toBe(false);
      });

      it('replays leave that starts and ends on the same day in the order it was recorded', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        await service.placeOnLeave(id as string, { effectiveOn: '2026-02-10' });
        await service.returnFromLeave(id as string, {
          effectiveOn: '2026-02-10',
        });
        await service.placeOnLeave(id as string, { effectiveOn: '2026-02-10' });
        expect(
          (await service.history(id as string)).map((change) => change.kind),
        ).toEqual(['hired', 'leave-started', 'leave-ended', 'leave-started']);
        // Recording instants strictly increase, so the order is not luck.
        const recorded = (await service.history(id as string))
          .slice(1)
          .map((change) => new Date(change.created_at as Date).getTime());
        expect(recorded[0]).toBeLessThan(recorded[1]);
        expect(recorded[1]).toBeLessThan(recorded[2]);
        expect(await service.check(profileId, '2026-02-10')).toMatchObject({
          onLeave: true,
        });
      });

      it('ends an employment from leave, and a rehire starts back at work', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        await service.placeOnLeave(id as string, { effectiveOn: '2026-02-10' });
        await service.end(id as string, { endedOn: '2026-02-20' });
        expect(await service.check(profileId, '2026-02-20')).toMatchObject({
          ok: true,
          onLeave: true,
        });
        expect(
          await code(
            service.returnFromLeave(id as string, {
              effectiveOn: '2026-02-21',
            }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        await service.rehire(id as string, { startedOn: '2026-05-01' });
        expect(await service.check(profileId, '2026-05-02')).toMatchObject({
          ok: true,
          onLeave: false,
        });
      });

      it('enforces the leave status transitions and the order of leave dates', async () => {
        const { id } = await hire();
        expect(
          await code(
            service.returnFromLeave(id as string, {
              effectiveOn: '2026-02-01',
            }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          await code(
            service.placeOnLeave(id as string, { effectiveOn: '2026-01-04' }),
          ),
        ).toBe('HR_INVALID');
        await service.placeOnLeave(id as string, { effectiveOn: '2026-02-10' });
        expect(
          await code(
            service.placeOnLeave(id as string, { effectiveOn: '2026-02-11' }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          await code(
            service.returnFromLeave(id as string, {
              effectiveOn: '2026-02-09',
            }),
          ),
        ).toBe('HR_INVALID');
        expect((await service.get(id as string)).status).toBe('on-leave');
      });
    });

    describe('position and worker type history', () => {
      it('keeps the latest value on the employment and the dated from/to values in the history', async () => {
        const { id } = await hire({ position: 'Apprentice welder' });
        const promoted = await service.changePosition(id as string, {
          position: 'Welder',
          effectiveOn: '2026-04-01',
          note: 'Passed ticket',
        });
        expect(promoted.position).toBe('Welder');
        const converted = await service.changeWorkerType(id as string, {
          workerType: 'contractor',
          effectiveOn: '2026-05-01',
        });
        expect(converted.workerType).toBe('contractor');
        const cleared = await service.changePosition(id as string, {
          position: null,
          effectiveOn: '2026-07-01',
        });
        expect(cleared.position).toBeNull();

        expect(
          (await service.history(id as string))
            .filter((change) => change.kind !== 'hired')
            .map((change) => [
              change.kind,
              change.effectiveOn,
              change.fromValue,
              change.toValue,
              change.note,
            ]),
        ).toEqual([
          [
            'position-changed',
            '2026-04-01',
            'Apprentice welder',
            'Welder',
            'Passed ticket',
          ],
          ['worker-type-changed', '2026-05-01', 'employee', 'contractor', ''],
          ['position-changed', '2026-07-01', 'Welder', null, ''],
        ]);
      });

      it('answers what a person was, and whether they were employed or on leave, as of any date', async () => {
        const { id } = await hire({ position: 'Apprentice welder' });
        await service.changePosition(id as string, {
          position: 'Welder',
          effectiveOn: '2026-04-01',
        });
        await service.changeWorkerType(id as string, {
          workerType: 'contractor',
          effectiveOn: '2026-05-01',
        });
        await service.placeOnLeave(id as string, { effectiveOn: '2026-05-10' });
        await service.end(id as string, { endedOn: '2026-05-31' });
        await service.rehire(id as string, {
          startedOn: '2026-09-01',
          position: 'Foreman',
        });

        expect(await service.asOf(id as string, '2025-12-31')).toEqual({
          position: 'Apprentice welder',
          workerType: 'employee',
          employed: false,
          onLeave: false,
        });
        expect(await service.asOf(id as string, '2026-03-31')).toEqual({
          position: 'Apprentice welder',
          workerType: 'employee',
          employed: true,
          onLeave: false,
        });
        expect(await service.asOf(id as string, '2026-04-01')).toEqual({
          position: 'Welder',
          workerType: 'employee',
          employed: true,
          onLeave: false,
        });
        expect(await service.asOf(id as string, '2026-05-20')).toEqual({
          position: 'Welder',
          workerType: 'contractor',
          employed: true,
          onLeave: true,
        });
        expect(await service.asOf(id as string, '2026-07-01')).toEqual({
          position: 'Welder',
          workerType: 'contractor',
          employed: false,
          onLeave: false,
        });
        expect(await service.asOf(id as string, '2026-09-01')).toEqual({
          position: 'Foreman',
          workerType: 'contractor',
          employed: true,
          onLeave: false,
        });
      });

      it('answers as-of for an employment with no changes from its current values', async () => {
        const { id } = await hire({ position: 'Welder' });
        expect(await service.asOf(id as string, '2026-06-01')).toEqual({
          position: 'Welder',
          workerType: 'employee',
          employed: true,
          onLeave: false,
        });
      });

      it('rejects a change that changes nothing, is dated outside the open term, or is dated before the previous one', async () => {
        const { id } = await hire({ position: 'Welder' });
        expect(
          await code(
            service.changePosition(id as string, {
              position: ' Welder ',
              effectiveOn: '2026-02-01',
            }),
          ),
        ).toBe('HR_INVALID');
        expect(
          await code(
            service.changeWorkerType(id as string, {
              workerType: 'employee',
              effectiveOn: '2026-02-01',
            }),
          ),
        ).toBe('HR_INVALID');
        expect(
          await code(
            service.changeWorkerType(id as string, {
              workerType: 'Contractor',
              effectiveOn: '2026-02-01',
            }),
          ),
        ).toBe('HR_INVALID');
        expect(
          await code(
            service.changePosition(id as string, {
              position: 'Foreman',
              effectiveOn: '2026-01-04',
            }),
          ),
        ).toBe('HR_INVALID');
        await service.changePosition(id as string, {
          position: 'Foreman',
          effectiveOn: '2026-03-01',
        });
        expect(
          await code(
            service.changePosition(id as string, {
              position: 'Supervisor',
              effectiveOn: '2026-02-28',
            }),
          ),
        ).toBe('HR_INVALID');
        // A worker-type change is ordered against worker-type changes only.
        await service.changeWorkerType(id as string, {
          workerType: 'contractor',
          effectiveOn: '2026-02-01',
        });
        expect((await service.get(id as string)).position).toBe('Foreman');
      });

      it('refuses a position, worker-type or leave change dated after the last day of an ended employment', async () => {
        const { id } = await hire();
        await service.end(id as string, { endedOn: '2026-03-31' });
        expect(
          await code(
            service.changePosition(id as string, {
              position: 'Foreman',
              effectiveOn: '2026-04-01',
            }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          await code(
            service.changeWorkerType(id as string, {
              workerType: 'contractor',
              effectiveOn: '2026-04-01',
            }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          await code(
            service.placeOnLeave(id as string, { effectiveOn: '2026-04-01' }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
      });
    });

    describe('a notice period: an end recorded ahead of the last day', () => {
      const onNotice = async () => {
        const profileId = uuid();
        const userId = uuid();
        const hired = await hire({ profileId, userId, position: 'Welder' });
        const id = hired.id as string;
        const ended = await service.end(id, { endedOn: '2026-12-31' });
        expect(ended.status).toBe('ended');
        return { id, profileId, userId };
      };
      const status = async (id: string) => (await service.get(id)).status;

      it('still resolves the login of a worker on notice when asked by date', async () => {
        const { id, profileId, userId } = await onNotice();
        expect(await service.check(profileId, '2026-10-03')).toEqual({
          ok: true,
          employmentId: id,
          onLeave: false,
        });
        expect((await service.findByUser(userId, '2026-10-03'))?.id).toBe(id);
        expect((await service.findByUser(userId, '2026-12-31'))?.id).toBe(id);
        expect(await service.findByUser(userId, '2027-01-01')).toBeNull();
        expect(await service.findByUser(userId, '2026-01-04')).toBeNull();
        // Without a date the stored status decides, and an end is recorded.
        expect(await service.findByUser(userId)).toBeNull();
        expect(await service.findByUser(uuid(), '2026-10-03')).toBeNull();
        expect(await service.findByUser('', '2026-10-03')).toBeNull();
        expect(await code(service.findByUser(userId, '03/10/2026'))).toBe(
          'HR_INVALID',
        );
        expect(await status(id)).toBe('ended');
      });

      it('accepts position and worker-type changes dated inside the final term, and replays them', async () => {
        const { id } = await onNotice();
        const changed = await service.changePosition(id, {
          position: 'Foreman',
          effectiveOn: '2026-11-01',
        });
        expect(changed).toMatchObject({ status: 'ended', position: 'Foreman' });
        const retyped = await service.changeWorkerType(id, {
          workerType: 'contractor',
          effectiveOn: '2026-12-31',
        });
        expect(retyped).toMatchObject({
          status: 'ended',
          workerType: 'contractor',
        });
        expect(await service.asOf(id, '2026-10-31')).toEqual({
          position: 'Welder',
          workerType: 'employee',
          employed: true,
          onLeave: false,
        });
        expect(await service.asOf(id, '2026-11-15')).toEqual({
          position: 'Foreman',
          workerType: 'employee',
          employed: true,
          onLeave: false,
        });
        expect(await service.asOf(id, '2026-12-31')).toMatchObject({
          workerType: 'contractor',
          employed: true,
        });
        // Still ordered against the previous change of the same kind.
        expect(
          await code(
            service.changePosition(id, {
              position: 'Supervisor',
              effectiveOn: '2026-10-31',
            }),
          ),
        ).toBe('HR_INVALID');
        expect(
          events
            .filter((event) => event.effectiveOn > '2026-06-01')
            .map((event) => [event.type, event.effectiveOn]),
        ).toEqual([
          ['employment.ended', '2026-12-31'],
          ['employment.position-changed', '2026-11-01'],
          ['employment.worker-type-changed', '2026-12-31'],
        ]);
      });

      it('records leave inside the final term from the replayed leave state, never twice', async () => {
        const { id, profileId } = await onNotice();
        // Not on leave yet, so there is nothing to return from.
        expect(
          await code(
            service.returnFromLeave(id, { effectiveOn: '2026-11-05' }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        const onLeave = await service.placeOnLeave(id, {
          effectiveOn: '2026-11-10',
        });
        expect(onLeave.status).toBe('ended');
        expect(await service.check(profileId, '2026-11-12')).toEqual({
          ok: true,
          employmentId: id,
          onLeave: true,
        });
        expect(await service.check(profileId, '2026-11-09')).toMatchObject({
          onLeave: false,
        });
        expect(
          await code(service.placeOnLeave(id, { effectiveOn: '2026-11-12' })),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          await code(
            service.returnFromLeave(id, { effectiveOn: '2026-11-09' }),
          ),
        ).toBe('HR_INVALID');
        const back = await service.returnFromLeave(id, {
          effectiveOn: '2026-11-20',
        });
        expect(back.status).toBe('ended');
        expect(await service.asOf(id, '2026-11-15')).toMatchObject({
          employed: true,
          onLeave: true,
        });
        expect(await service.check(profileId, '2026-11-20')).toMatchObject({
          ok: true,
          onLeave: false,
        });
        expect(
          await code(
            service.returnFromLeave(id, { effectiveOn: '2026-11-25' }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          events
            .filter((event) => event.type.startsWith('employment.leave'))
            .map((event) => [event.type, event.effectiveOn]),
        ).toEqual([
          ['employment.leave-started', '2026-11-10'],
          ['employment.leave-ended', '2026-11-20'],
        ]);
      });

      it('returns a worker whose end was recorded while on leave, inside the final term', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        await service.placeOnLeave(id as string, { effectiveOn: '2026-09-01' });
        await service.end(id as string, { endedOn: '2026-12-31' });
        expect(
          await code(
            service.placeOnLeave(id as string, { effectiveOn: '2026-10-03' }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        await service.returnFromLeave(id as string, {
          effectiveOn: '2026-10-05',
        });
        expect(await service.check(profileId, '2026-10-04')).toMatchObject({
          onLeave: true,
        });
        expect(await service.check(profileId, '2026-10-05')).toMatchObject({
          onLeave: false,
        });
        expect(await status(id as string)).toBe('ended');
      });

      it('rejects a change dated after the last day or before the final term', async () => {
        const { id } = await onNotice();
        const after = { effectiveOn: '2027-01-05' };
        expect(
          await code(
            service.changePosition(id, { position: 'Foreman', ...after }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          await code(
            service.changeWorkerType(id, {
              workerType: 'contractor',
              ...after,
            }),
          ),
        ).toBe('HR_STATUS_TRANSITION');
        expect(await code(service.placeOnLeave(id, after))).toBe(
          'HR_STATUS_TRANSITION',
        );
        expect(await code(service.returnFromLeave(id, after))).toBe(
          'HR_STATUS_TRANSITION',
        );
        expect(
          await code(
            service.changePosition(id, {
              position: 'Foreman',
              effectiveOn: '2026-01-04',
            }),
          ),
        ).toBe('HR_INVALID');
        expect(await code(service.end(id, { endedOn: '2026-12-31' }))).toBe(
          'HR_STATUS_TRANSITION',
        );
        expect(await service.get(id)).toMatchObject({
          status: 'ended',
          position: 'Welder',
        });
        expect((await service.history(id)).map((c) => c.kind)).toEqual([
          'hired',
          'ended',
        ]);
      });

      it('rehires after a notice period with changes, and replays both terms correctly', async () => {
        const { id, profileId, userId } = await onNotice();
        await service.changePosition(id, {
          position: 'Foreman',
          effectiveOn: '2026-11-01',
        });
        await service.placeOnLeave(id, { effectiveOn: '2026-11-10' });
        await service.returnFromLeave(id, { effectiveOn: '2026-11-20' });
        await service.placeOnLeave(id, { effectiveOn: '2026-12-20' });
        expect(await status(id)).toBe('ended');

        // A new term cannot start inside the notice period.
        expect(
          await code(service.rehire(id, { startedOn: '2026-12-31' })),
        ).toBe('HR_TERM_OVERLAP');
        const rehired = await service.rehire(id, { startedOn: '2027-02-01' });
        expect(rehired).toMatchObject({
          status: 'active',
          position: 'Foreman',
        });

        expect(await service.asOf(id, '2026-11-15')).toEqual({
          position: 'Foreman',
          workerType: 'employee',
          employed: true,
          onLeave: true,
        });
        expect(await service.asOf(id, '2026-12-31')).toMatchObject({
          employed: true,
          onLeave: true,
        });
        expect(await service.asOf(id, '2027-01-15')).toMatchObject({
          employed: false,
          onLeave: false,
        });
        // The new term starts back at work.
        expect(await service.check(profileId, '2027-02-15')).toEqual({
          ok: true,
          employmentId: id,
          onLeave: false,
        });
        expect(await service.check(profileId, '2027-01-15')).toEqual({
          ok: false,
          reason: 'ended',
        });
        expect((await service.findByUser(userId))?.id).toBe(id);
        expect((await service.findByUser(userId, '2027-02-15'))?.id).toBe(id);
        expect(await service.findByUser(userId, '2027-01-15')).toBeNull();

        // A later end is still ordered against the latest recorded change.
        await service.changePosition(id, {
          position: 'Supervisor',
          effectiveOn: '2027-03-01',
        });
        expect(await code(service.end(id, { endedOn: '2027-02-15' }))).toBe(
          'HR_INVALID',
        );
        await service.end(id, { endedOn: '2027-03-31' });
        expect((await service.terms(id)).map((term) => term.endedOn)).toEqual([
          '2026-12-31',
          '2027-03-31',
        ]);
      });

      it('keeps the login with a worker on notice, so nobody else can take it and lock them both out', async () => {
        const { id, userId } = await onNotice();
        // The end is recorded but the last day is ahead: the login stays put.
        expect(await code(hire({ userId, startedOn: '2026-12-01' }))).toBe(
          'HR_INVALID',
        );
        const second = await hire({ startedOn: '2026-12-01' });
        expect(
          await code(
            service.linkLogin(second.id as string, userId, {
              effectiveOn: '2026-12-01',
            }),
          ),
        ).toBe('HR_INVALID');
        expect((await service.get(second.id as string)).userId).toBeNull();
        expect((await service.findByUser(userId, '2026-12-15'))?.id).toBe(id);

        // Unlinking it from the employment on notice is what frees it.
        await service.unlinkLogin(id, { effectiveOn: '2026-12-10' });
        await service.linkLogin(second.id as string, userId, {
          effectiveOn: '2026-12-10',
        });
        expect((await service.findByUser(userId, '2026-12-15'))?.id).toBe(
          second.id,
        );
        expect((await service.findByUser(userId))?.id).toBe(second.id);
      });

      it('fails closed by date when two employments sharing a login both cover the date', async () => {
        const { id, userId } = await onNotice();
        // The service refuses to link a login twice, so share it the way
        // rows written some other way could: directly on the second row.
        const second = await hire({ startedOn: '2026-12-01' });
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const employments = await EmploymentCollection.create({ db });
          const [row] = await employments.list({ where: { id: second.id } });
          row.userId = userId;
          await persistHr(row);
        });
        expect((await service.findByUser(userId, '2026-11-30'))?.id).toBe(id);
        expect(await service.findByUser(userId, '2026-12-15')).toBeNull();
        expect((await service.findByUser(userId, '2027-01-01'))?.id).toBe(
          second.id,
        );
        expect((await service.findByUser(userId))?.id).toBe(second.id);
      });
    });

    describe('uniqueness', () => {
      it('keeps an employee number unique inside a tenant and reusable in another tenant', async () => {
        const first = await hire({ employeeNumber: 'E-7' });
        expect(await code(hire({ employeeNumber: 'E-7' }))).toBe(
          'HR_EMPLOYEE_NUMBER_TAKEN',
        );
        expect(await code(hire({ employeeNumber: ' E-7 ' }))).toBe(
          'HR_EMPLOYEE_NUMBER_TAKEN',
        );
        const elsewhere = new EmploymentService(db, {
          tenantId: uuid(),
          profileId: uuid(),
        });
        const second = await hire({ employeeNumber: 'E-7' }, elsewhere);
        expect(second.id).not.toBe(first.id);
        expect((await elsewhere.findByEmployeeNumber('E-7'))?.id).toBe(
          second.id,
        );
        expect((await service.findByEmployeeNumber('E-7'))?.id).toBe(first.id);
        expect((await service.get(first.id as string)).profileId).toBe(
          first.profileId,
        );
      });

      it('allows one employment per tenant and profile, pointing a returning person at rehire', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        expect(await code(hire({ profileId }))).toBe('HR_ALREADY_EMPLOYED');
        await service.end(id as string, { endedOn: '2026-03-31' });
        await expect(
          hire({ profileId, startedOn: '2026-06-01' }),
        ).rejects.toThrow(/rehire/);
        // The same person may work for another tenant.
        const elsewhere = new EmploymentService(db, {
          tenantId: uuid(),
          profileId: uuid(),
        });
        expect((await hire({ profileId }, elsewhere)).id).not.toBe(id);
      });

      it('backs both rules with unique indexes on the employments table', async () => {
        const first = await hire({ employeeNumber: 'E-1' });
        const indexes: string[][] = [];
        if (isPostgresDatabase(db)) {
          const { rows } = await db.query(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'employments' AND indexdef LIKE '%UNIQUE%'",
          );
          for (const row of rows as { indexdef: string }[])
            indexes.push(
              (/\(([^)]*)\)/.exec(row.indexdef)?.[1] ?? '')
                .split(',')
                .map((column) => column.trim()),
            );
        } else {
          const { rows } = await db.query("PRAGMA index_list('employments')");
          for (const row of rows as { name: string; unique: number }[]) {
            if (!row.unique) continue;
            const info = await db.query(`PRAGMA index_info('${row.name}')`);
            indexes.push((info.rows as { name: string }[]).map((c) => c.name));
          }
        }
        expect(indexes).toEqual(
          expect.arrayContaining([
            ['tenant_id', 'profile_id'],
            ['tenant_id', 'employee_number'],
          ]),
        );

        // The database itself refuses a second employment for the profile.
        await expect(
          withTenant({ tenantId: actor.tenantId }, () =>
            insertHr(Employment, db, {
              tenantId: actor.tenantId,
              profileId: first.profileId,
              employeeNumber: 'E-2',
            }),
          ),
        ).rejects.toThrow();
        expect(await service.findByEmployeeNumber('E-2')).toBeNull();
      });
    });

    describe('tenant isolation', () => {
      it("hides one tenant's employments from another tenant's actor, for reads and for mutations", async () => {
        const profileId = uuid();
        const userId = uuid();
        const { id } = await hire({ profileId, userId, employeeNumber: 'E-1' });
        const outsider = new EmploymentService(db, {
          tenantId: uuid(),
          profileId: actor.profileId,
        });
        const employmentId = id as string;

        expect(await code(outsider.get(employmentId))).toBe('HR_NOT_FOUND');
        expect(await outsider.findByProfile(profileId)).toBeNull();
        expect(await outsider.findByEmployeeNumber('E-1')).toBeNull();
        expect(await outsider.findByUser(userId)).toBeNull();
        expect(await outsider.employedOn('2026-02-01')).toEqual([]);
        expect(await outsider.check(profileId, '2026-02-01')).toEqual({
          ok: false,
          reason: 'not-employed',
        });
        expect(await code(outsider.terms(employmentId))).toBe('HR_NOT_FOUND');
        expect(await code(outsider.history(employmentId))).toBe('HR_NOT_FOUND');
        expect(await code(outsider.asOf(employmentId, '2026-02-01'))).toBe(
          'HR_NOT_FOUND',
        );

        const date = { effectiveOn: '2026-02-01' };
        for (const attempt of [
          () => outsider.end(employmentId, { endedOn: '2026-02-01' }),
          () => outsider.rehire(employmentId, { startedOn: '2026-02-01' }),
          () =>
            outsider.changePosition(employmentId, { position: 'X', ...date }),
          () =>
            outsider.changeWorkerType(employmentId, {
              workerType: 'contractor',
              ...date,
            }),
          () => outsider.placeOnLeave(employmentId, date),
          () => outsider.returnFromLeave(employmentId, date),
          () => outsider.linkLogin(employmentId, uuid(), date),
          () => outsider.unlinkLogin(employmentId, date),
        ])
          expect(await code(attempt())).toBe('HR_NOT_FOUND');

        expect(await service.get(employmentId)).toMatchObject({
          status: 'active',
          userId,
          position: null,
        });
        expect((await service.history(employmentId)).length).toBe(1);
      });

      it('rejects reads and writes made under a conflicting ambient tenant', async () => {
        const { id } = await hire();
        await withTenant({ tenantId: uuid() }, async () => {
          expect(await code(service.get(id as string))).toBe(
            'HR_TENANT_MISMATCH',
          );
          expect(await code(service.employedOn('2026-02-01'))).toBe(
            'HR_TENANT_MISMATCH',
          );
          expect(await code(hire())).toBe('HR_TENANT_MISMATCH');
          expect(
            await code(service.end(id as string, { endedOn: '2026-02-01' })),
          ).toBe('HR_TENANT_MISMATCH');
        });
        // The actor's own tenant as ambient context is fine.
        await withTenant({ tenantId: actor.tenantId }, async () => {
          expect((await service.get(id as string)).status).toBe('active');
        });
      });

      it('requires a trusted tenant and profile to construct the service', () => {
        expect(
          () => new EmploymentService(db, { tenantId: '', profileId: uuid() }),
        ).toThrow(HrError);
        expect(
          () => new EmploymentService(db, { tenantId: uuid(), profileId: ' ' }),
        ).toThrow(HrError);
      });
    });

    describe('closed models', () => {
      it('rejects a direct save or delete of an employment, term or change outside the service', async () => {
        const { id } = await hire();
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const employments = await EmploymentCollection.create({ db });
          const terms = await EmploymentTermCollection.create({ db });
          const changes = await EmploymentChangeCollection.create({ db });

          const [employment] = await employments.list({ where: { id } });
          employment.position = 'Sneaky';
          expect(await code(employment.save())).toBe('HR_WRITE_FORBIDDEN');
          expect(await code(employment.delete())).toBe('HR_HISTORY_IMMUTABLE');

          const [term] = await terms.list({ where: { employmentId: id } });
          term.endedOn = '2026-01-06';
          expect(await code(term.save())).toBe('HR_WRITE_FORBIDDEN');
          expect(await code(term.delete())).toBe('HR_HISTORY_IMMUTABLE');

          const [change] = await changes.list({ where: { employmentId: id } });
          expect(await code(change.save())).toBe('HR_WRITE_FORBIDDEN');
          expect(await code(change.delete())).toBe('HR_HISTORY_IMMUTABLE');

          const fresh = await new Employment({
            db,
            _skipLoad: true,
            tenantId: actor.tenantId,
            profileId: uuid(),
            employeeNumber: 'direct',
          }).initialize();
          expect(await code(fresh.save())).toBe('HR_WRITE_FORBIDDEN');
        });
        expect(await service.get(id as string)).toMatchObject({
          position: null,
          status: 'active',
        });
        expect(await service.findByEmployeeNumber('direct')).toBeNull();
        expect((await service.terms(id as string))[0].endedOn).toBeNull();
      });
    });

    describe('events', () => {
      it('delivers each lifecycle event after its change is committed', async () => {
        const seen: { type: string; status: string; terms: number }[] = [];
        const watching = new EmploymentService(db, actor, {
          onEvent: async (event) => {
            if (!('employment' in event)) return;
            // Reading through the root connection proves the commit happened.
            const id = event.employment.id as string;
            seen.push({
              type: event.type,
              status: (await service.get(id)).status,
              terms: (await service.terms(id)).length,
            });
            expect(event.byProfileId).toBe(actor.profileId);
            expect(event.at).toBeInstanceOf(Date);
          },
        });
        const { id } = await hire({}, watching);
        const employmentId = id as string;
        await watching.changePosition(employmentId, {
          position: 'Welder',
          effectiveOn: '2026-02-01',
        });
        await watching.changeWorkerType(employmentId, {
          workerType: 'contractor',
          effectiveOn: '2026-02-01',
        });
        await watching.placeOnLeave(employmentId, {
          effectiveOn: '2026-02-10',
        });
        await watching.returnFromLeave(employmentId, {
          effectiveOn: '2026-02-20',
        });
        await watching.end(employmentId, { endedOn: '2026-03-31' });
        await watching.rehire(employmentId, { startedOn: '2026-06-01' });
        expect(seen).toEqual([
          { type: 'employment.hired', status: 'active', terms: 1 },
          { type: 'employment.position-changed', status: 'active', terms: 1 },
          {
            type: 'employment.worker-type-changed',
            status: 'active',
            terms: 1,
          },
          { type: 'employment.leave-started', status: 'on-leave', terms: 1 },
          { type: 'employment.leave-ended', status: 'active', terms: 1 },
          { type: 'employment.ended', status: 'ended', terms: 1 },
          { type: 'employment.rehired', status: 'active', terms: 2 },
        ]);
      });

      it('carries the effective date on the event', async () => {
        const { id } = await hire();
        await service.end(id as string, { endedOn: '2026-03-31' });
        expect(events.map((event) => [event.type, event.effectiveOn])).toEqual([
          ['employment.hired', '2026-01-05'],
          ['employment.ended', '2026-03-31'],
        ]);
      });

      it('delivers nothing when the mutation throws', async () => {
        const { id } = await hire({ employeeNumber: 'E-1' });
        events.length = 0;
        expect(await code(hire({ employeeNumber: 'E-1' }))).toBe(
          'HR_EMPLOYEE_NUMBER_TAKEN',
        );
        expect(
          await code(service.rehire(id as string, { startedOn: '2026-02-01' })),
        ).toBe('HR_STATUS_TRANSITION');
        expect(
          await code(service.end(id as string, { endedOn: '2026-01-01' })),
        ).toBe('HR_INVALID');
        expect(events).toEqual([]);
        expect((await service.get(id as string)).status).toBe('active');
      });

      it('keeps the change when the event handler throws', async () => {
        const fragile = new EmploymentService(db, actor, {
          onEvent: () => {
            throw new Error('reminder service is down');
          },
        });
        const { id } = await hire({}, fragile);
        const ended = await fragile.end(id as string, {
          endedOn: '2026-03-31',
        });
        expect(ended.status).toBe('ended');
        expect((await service.get(id as string)).status).toBe('ended');
      });

      it('refuses a mutation through a handle that is already inside a transaction, so an outer rollback never leaves an event behind', async () => {
        const delivered: HrEvent[] = [];
        const listen = {
          onEvent: (event: HrEvent) => void delivered.push(event),
        };
        const profileId = uuid();
        const input = {
          profileId,
          employeeNumber: 'TX-1',
          startedOn: '2026-01-05',
        };
        const existing = await hire();
        if (!db.transaction || !db.beginTransaction)
          throw new Error('The test database must support transactions.');

        // The `tx` of db.transaction(): the service would only complete a
        // savepoint, and the outer work can still fail afterwards.
        const refused: string[] = [];
        await expect(
          db.transaction(async (tx) => {
            const inside = new EmploymentService(tx, actor, listen);
            refused.push(await code(inside.hire(input)));
            refused.push(
              await code(
                inside.end(existing.id as string, { endedOn: '2026-03-31' }),
              ),
            );
            // Reads are fine on any handle.
            expect((await inside.get(existing.id as string)).status).toBe(
              'active',
            );
            throw new Error('outer work failed');
          }),
        ).rejects.toThrow('outer work failed');

        // A beginTransaction() handle is the same case.
        const handle = await db.beginTransaction();
        try {
          refused.push(
            await code(
              new EmploymentService(handle, actor, listen).hire(input),
            ),
          );
        } finally {
          await handle.rollback();
        }

        expect(refused).toEqual([
          'HR_TRANSACTION_UNSUPPORTED',
          'HR_TRANSACTION_UNSUPPORTED',
          'HR_TRANSACTION_UNSUPPORTED',
        ]);
        expect(delivered).toEqual([]);
        expect(await service.findByProfile(profileId)).toBeNull();
        expect((await service.get(existing.id as string)).status).toBe(
          'active',
        );

        // The same service on the root handle writes and delivers.
        await new EmploymentService(db, actor, listen).hire(input);
        expect(delivered.map((event) => event.type)).toEqual([
          'employment.hired',
        ]);
      });

      it('raises no event for linking or unlinking a login', async () => {
        const { id } = await hire();
        events.length = 0;
        await service.linkLogin(id as string, uuid(), {
          effectiveOn: '2026-01-05',
        });
        await service.unlinkLogin(id as string, { effectiveOn: '2026-01-06' });
        expect(events).toEqual([]);
      });
    });

    describe('qualifications that belong to the employment', () => {
      it('revokes an employment-scoped qualification when the employment ends, and leaves a person-scoped one alone', async () => {
        const profileId = uuid();
        const { id } = await hire({ profileId });
        const employmentId = id as string;
        const held = await withTenant(
          { tenantId: actor.tenantId },
          async () => {
            const grant = async (
              key: string,
              scope: 'person' | 'employment',
            ) => {
              const definition = await insertHr(Qualification, db, {
                tenantId: actor.tenantId,
                key,
                name: key,
                scope,
              });
              return insertHr(HeldQualification, db, {
                tenantId: actor.tenantId,
                qualificationId: definition.id as string,
                profileId,
                employmentId: scope === 'employment' ? employmentId : null,
                issuedOn: '2026-01-10',
              });
            };
            return {
              site: await grant('site-induction', 'employment'),
              firstAid: await grant('first-aid', 'person'),
            };
          },
        );
        events.length = 0;

        await service.end(employmentId, { endedOn: '2026-03-31' });

        await withTenant({ tenantId: actor.tenantId }, async () => {
          const heldRows = await HeldQualificationCollection.create({ db });
          const status = async (heldId: unknown) =>
            (await heldRows.list({ where: { id: heldId as string } }))[0]
              .status;
          expect(await status(held.site.id)).toBe('revoked');
          expect(await status(held.firstAid.id)).toBe('valid');
          const changes = await HeldQualificationChangeCollection.create({
            db,
          });
          expect(
            await changes.list({
              where: { heldQualificationId: held.site.id as string },
            }),
          ).toEqual([
            // In force from the day after the last day employed.
            expect.objectContaining({
              kind: 'revoked',
              effectiveOn: '2026-04-01',
              reason: 'employment-ended',
              actorProfileId: actor.profileId,
            }),
          ]);
          expect(
            await changes.list({
              where: { heldQualificationId: held.firstAid.id as string },
            }),
          ).toEqual([]);
        });
        expect(events.map((event) => event.type)).toEqual([
          'held-qualification.revoked',
          'employment.ended',
        ]);
      });
    });

    describe('logins', () => {
      it('links and unlinks a login with dated changes', async () => {
        const { id } = await hire();
        const userId = uuid();
        const replacement = uuid();
        const date = { effectiveOn: '2026-02-01' };
        expect(
          (await service.linkLogin(id as string, userId, date)).userId,
        ).toBe(userId);
        expect(await code(service.linkLogin(id as string, userId, date))).toBe(
          'HR_INVALID',
        );
        expect(await code(service.linkLogin(id as string, ' ', date))).toBe(
          'HR_INVALID',
        );
        await service.linkLogin(id as string, replacement, date);
        expect(
          (await service.unlinkLogin(id as string, date)).userId,
        ).toBeNull();
        expect(await code(service.unlinkLogin(id as string, date))).toBe(
          'HR_INVALID',
        );
        expect(
          (await service.history(id as string))
            .filter((change) => change.kind !== 'hired')
            .map((change) => [change.kind, change.fromValue, change.toValue]),
        ).toEqual([
          ['login-linked', null, userId],
          ['login-linked', userId, replacement],
          ['login-unlinked', replacement, null],
        ]);
      });

      it('links a login to one employment at a time, until it is unlinked there', async () => {
        const userId = uuid();
        const date = { effectiveOn: '2026-02-01' };
        const first = await hire({ userId });
        const second = await hire();
        expect(
          await code(service.linkLogin(second.id as string, userId, date)),
        ).toBe('HR_INVALID');
        expect(await code(hire({ userId }))).toBe('HR_INVALID');
        expect((await service.get(second.id as string)).userId).toBeNull();
        expect((await service.findByUser(userId))?.id).toBe(first.id);
        expect(
          (await service.history(second.id as string)).map((c) => c.kind),
        ).toEqual(['hired']);

        // Another tenant may link the same login.
        const elsewhere = new EmploymentService(db, {
          tenantId: uuid(),
          profileId: uuid(),
        });
        expect((await hire({ userId }, elsewhere)).userId).toBe(userId);

        // Ending the first employment does not free the login, even once
        // its last day has passed: it stays there until it is unlinked.
        await service.end(first.id as string, { endedOn: '2026-03-31' });
        expect(
          await code(
            service.linkLogin(second.id as string, userId, {
              effectiveOn: '2026-04-01',
            }),
          ),
        ).toBe('HR_INVALID');
        expect(await code(hire({ userId, startedOn: '2026-04-01' }))).toBe(
          'HR_INVALID',
        );
        await service.unlinkLogin(first.id as string, {
          effectiveOn: '2026-04-01',
        });
        await service.linkLogin(second.id as string, userId, {
          effectiveOn: '2026-04-01',
        });
        expect((await service.findByUser(userId))?.id).toBe(second.id);

        // An ended employment that kept its login is rehired with it.
        const kept = uuid();
        const third = await hire({ userId: kept });
        await service.end(third.id as string, { endedOn: '2026-03-31' });
        const rehired = await service.rehire(third.id as string, {
          startedOn: '2026-06-01',
        });
        expect(rehired.userId).toBe(kept);
        expect((await service.findByUser(kept, '2026-06-01'))?.id).toBe(
          third.id,
        );
      });

      it('refuses a rehire while the login the ended employment kept is also stored on another employment', async () => {
        const userId = uuid();
        const first = await hire({ userId });
        const second = await hire();
        await service.end(first.id as string, { endedOn: '2026-03-31' });
        // The service never lets the kept login move without an unlink, so
        // put it on a second row directly, as rows written some other way
        // could hold it.
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const employments = await EmploymentCollection.create({ db });
          const [row] = await employments.list({ where: { id: second.id } });
          row.userId = userId;
          await persistHr(row);
        });

        // The ended employment still stores the login it had.
        expect(
          await code(
            service.rehire(first.id as string, { startedOn: '2026-06-01' }),
          ),
        ).toBe('HR_INVALID');
        expect((await service.get(first.id as string)).status).toBe('ended');
        expect((await service.findByUser(userId))?.id).toBe(second.id);

        // Unlinking it from the ended employment clears the way.
        await service.unlinkLogin(first.id as string, {
          effectiveOn: '2026-05-01',
        });
        const rehired = await service.rehire(first.id as string, {
          startedOn: '2026-06-01',
        });
        expect(rehired.status).toBe('active');
        expect(rehired.userId).toBeNull();
        expect((await service.findByUser(userId))?.id).toBe(second.id);
      });

      it('finds the employment for a login, and fails closed when it is ended, missing or ambiguous', async () => {
        const userId = uuid();
        const { id } = await hire({ userId });
        expect((await service.findByUser(userId))?.id).toBe(id);
        expect(await service.findByUser(uuid())).toBeNull();
        expect(await service.findByUser('')).toBeNull();

        // Still found while on leave.
        await service.placeOnLeave(id as string, { effectiveOn: '2026-02-01' });
        expect((await service.findByUser(userId))?.id).toBe(id);

        // The service refuses a double link, so make one the way stored
        // rows from before that rule could hold it: two live employments
        // share the login, and neither is returned.
        const second = await hire();
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const employments = await EmploymentCollection.create({ db });
          const [row] = await employments.list({ where: { id: second.id } });
          row.userId = userId;
          await persistHr(row);
        });
        expect(await service.findByUser(userId)).toBeNull();

        // Once one of them ends, the other is unambiguous again.
        await service.end(id as string, { endedOn: '2026-03-31' });
        expect((await service.findByUser(userId))?.id).toBe(second.id);

        // An ended employment never resolves a login.
        await service.end(second.id as string, { endedOn: '2026-03-31' });
        expect(await service.findByUser(userId)).toBeNull();
      });
    });

    describe('README usage', () => {
      it('hires, checks, ends and rehires a person as the README shows', async () => {
        const tenantId = actor.tenantId;
        const managerProfileId = actor.profileId;
        const workerProfileId = uuid();
        const notified: string[] = [];

        // --- README snippet start ---
        const hr = new EmploymentService(
          db,
          { tenantId, profileId: managerProfileId },
          { onEvent: (event) => void notified.push(event.type) },
        );

        const employment = await hr.hire({
          profileId: workerProfileId,
          employeeNumber: 'E-1042',
          startedOn: '2026-01-05',
          position: 'Welder',
        });

        const check = await hr.check(workerProfileId, '2026-02-01');
        // { ok: true, employmentId: employment.id, onLeave: false }

        await hr.end(employment.id as string, {
          endedOn: '2026-03-31', // last day employed, inclusive
          reason: 'Season over',
        });
        const after = await hr.check(workerProfileId, '2026-04-01');
        // { ok: false, reason: 'ended' }

        const rehired = await hr.rehire(employment.id as string, {
          startedOn: '2026-06-01',
        });
        // rehired.id === employment.id; hr.terms(rehired.id) has two terms
        // --- README snippet end ---

        expect(check).toEqual({
          ok: true,
          employmentId: employment.id,
          onLeave: false,
        });
        expect(after).toEqual({ ok: false, reason: 'ended' });
        expect(rehired.id).toBe(employment.id);
        expect((await hr.terms(rehired.id as string)).length).toBe(2);
        expect(notified).toEqual([
          'employment.hired',
          'employment.ended',
          'employment.rehired',
        ]);
      });
    });
  });
}
