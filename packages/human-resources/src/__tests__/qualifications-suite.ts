import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EmploymentService,
  HeldQualification,
  HeldQualificationChangeCollection,
  HeldQualificationCollection,
  type HrActor,
  type HrEvent,
  QualificationCollection,
  QualificationService,
  SUGGESTED_QUALIFICATIONS,
} from '../index.js';
import { EMPLOYMENT_ENDED_REASON } from '../qualifications/internal.js';
import { insertHr, persistHr } from '../write.js';

const uuid = () => crypto.randomUUID();
const code = (value: string) => ({ code: value });

/**
 * QualificationService behaviour, run against SQLite and (optionally)
 * PostgreSQL. Ids are UUIDs so the same suite is valid on both.
 */
export function qualificationsSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let actor: HrActor;
    let events: HrEvent[];
    let service: QualificationService;
    let employment: EmploymentService;
    let employmentEvents: HrEvent[];

    beforeEach(async () => {
      db = await create();
      actor = { tenantId: uuid(), profileId: uuid() };
      events = [];
      service = new QualificationService(db, actor, {
        onEvent: (event) => {
          events.push(event);
        },
      });
      employmentEvents = [];
      employment = new EmploymentService(db, actor, {
        onEvent: (event) => {
          employmentEvents.push(event);
        },
      });
    });
    afterEach(async () => {
      await cleanup();
    });

    const types = () => events.map((event) => event.type);

    /** Hire through the real EmploymentService; returns the employment id. */
    async function hire(profileId: string, startedOn: string): Promise<string> {
      const hired = await employment.hire({
        profileId,
        employeeNumber: uuid(),
        startedOn,
      });
      return hired.id as string;
    }

    /**
     * End through the real EmploymentService, `lastDay` being the last day
     * employed; returns the events that end delivered.
     */
    async function endEmployment(
      employmentId: string,
      lastDay: string,
    ): Promise<HrEvent[]> {
      employmentEvents.length = 0;
      await employment.end(employmentId, {
        endedOn: lastDay,
        reason: 'resigned',
      });
      return [...employmentEvents];
    }

    /** A held qualification's dated changes as `[kind, effectiveOn, reason]`. */
    const historyOf = async (id: unknown) =>
      (await service.history(id as string)).map((change) => [
        change.kind,
        change.effectiveOn,
        change.reason,
      ]);

    const firstAid = () =>
      service.define({
        key: 'first-aid',
        name: 'First aid',
        kind: 'certification',
        expires: true,
        validityMonths: 36,
      });
    const orientation = () =>
      service.define({
        key: 'site-orientation',
        name: 'Site orientation',
        kind: 'training',
      });

    describe('definitions', () => {
      it('defines a qualification with person scope by default and employment scope for an authorization', async () => {
        const ticket = await firstAid();
        expect(ticket).toMatchObject({
          tenantId: actor.tenantId,
          key: 'first-aid',
          name: 'First aid',
          kind: 'certification',
          issuingBody: '',
          expires: true,
          validityMonths: 36,
          scope: 'person',
          isActive: true,
        });
        const authorization = await service.define({
          key: 'forklift-on-site',
          name: 'Forklift on site',
          kind: 'authorization',
          issuingBody: 'Safety office',
        });
        expect(authorization).toMatchObject({
          scope: 'employment',
          expires: false,
          validityMonths: null,
          issuingBody: 'Safety office',
        });
        const personal = await service.define({
          key: 'signing-authority',
          name: 'Signing authority',
          kind: 'authorization',
          scope: 'person',
        });
        expect(personal.scope).toBe('person');
      });

      it('rejects a key that is not lowercase kebab-case and validity that makes no sense', async () => {
        for (const key of [
          'First Aid',
          'first_aid',
          '-first',
          'first--aid',
          '',
        ])
          await expect(
            service.define({ key, name: 'X', kind: 'ticket' }),
          ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.define({ key: 'a', name: ' ', kind: 'ticket' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.define({
            key: 'a',
            name: 'A',
            kind: 'licence' as 'ticket',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        for (const validityMonths of [0, -1, 1.5])
          await expect(
            service.define({
              key: 'a',
              name: 'A',
              kind: 'ticket',
              expires: true,
              validityMonths,
            }),
          ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.define({
            key: 'a',
            name: 'A',
            kind: 'ticket',
            validityMonths: 12,
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        expect(await service.list({ includeInactive: true })).toEqual([]);
      });

      it('keeps a key unique within a tenant while another tenant may reuse it', async () => {
        const mine = await firstAid();
        await expect(firstAid()).rejects.toMatchObject(
          code('HR_QUALIFICATION_KEY_TAKEN'),
        );
        const other = new QualificationService(db, {
          tenantId: uuid(),
          profileId: uuid(),
        });
        const theirs = await other.define({
          key: 'first-aid',
          name: 'Their first aid',
          kind: 'training',
        });
        expect(theirs.id).not.toBe(mine.id);
        expect((await service.get(mine.id as string)).name).toBe('First aid');
        expect(await service.list()).toHaveLength(1);
      });

      it('updates descriptive fields, clears validity when expiry is turned off, and hides inactive definitions', async () => {
        const ticket = await firstAid();
        const id = ticket.id as string;
        const renamed = await service.update(id, {
          name: 'Standard first aid',
          issuingBody: 'Training provider',
          validityMonths: 24,
        });
        expect(renamed).toMatchObject({
          key: 'first-aid',
          name: 'Standard first aid',
          issuingBody: 'Training provider',
          expires: true,
          validityMonths: 24,
        });
        await expect(
          service.update(id, { expires: false, validityMonths: 12 }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        expect((await service.get(id)).expires).toBe(true);
        expect(await service.update(id, { expires: false })).toMatchObject({
          expires: false,
          validityMonths: null,
        });
        await service.update(id, { isActive: false });
        expect(await service.list()).toEqual([]);
        expect(
          (await service.list({ includeInactive: true })).map((q) => q.key),
        ).toEqual(['first-aid']);
        await expect(
          service.update(uuid(), { name: 'X' }),
        ).rejects.toMatchObject(code('HR_NOT_FOUND'));
      });

      it('seeds the suggested list once: a second seed creates nothing and leaves edited rows alone', async () => {
        const first = await service.seed(SUGGESTED_QUALIFICATIONS);
        expect(first.map((q) => q.key)).toEqual([
          'first-aid',
          'site-orientation',
          'youth-worker',
        ]);
        expect(first[0]).toMatchObject({ expires: true, validityMonths: 36 });
        expect(first[2]).toMatchObject({ kind: 'restriction', expires: false });
        await service.update(first[0].id as string, { name: 'Edited' });
        const second = await service.seed([
          { key: 'youth-worker', name: 'Other name', kind: 'training' },
          { key: 'confined-space', name: 'Confined space', kind: 'ticket' },
          ...SUGGESTED_QUALIFICATIONS.slice(0, 2),
        ]);
        expect(second.map((q) => q.key)).toEqual([
          'youth-worker',
          'confined-space',
          'first-aid',
          'site-orientation',
        ]);
        expect(second[0]).toMatchObject({
          id: first[2].id,
          name: 'Youth worker',
          kind: 'restriction',
        });
        expect(second[2]).toMatchObject({ id: first[0].id, name: 'Edited' });
        expect((await service.list()).map((q) => q.key)).toEqual([
          'confined-space',
          'first-aid',
          'site-orientation',
          'youth-worker',
        ]);
        await expect(
          service.seed([
            { key: 'dup', name: 'A', kind: 'ticket' },
            { key: 'dup', name: 'B', kind: 'ticket' },
          ]),
        ).rejects.toMatchObject(code('HR_INVALID'));
      });

      it('finds a definition by key or id and reports a missing one', async () => {
        const ticket = await firstAid();
        expect((await service.findByKey('first-aid'))?.id).toBe(ticket.id);
        expect(await service.findByKey('nope')).toBeNull();
        await expect(service.get(uuid())).rejects.toMatchObject(
          code('HR_NOT_FOUND'),
        );
      });
    });

    describe('granting', () => {
      it('defaults the expiry from the definition validity, accepts an explicit expiry, and leaves a non-expiring one open', async () => {
        const ticket = await firstAid();
        const training = await orientation();
        const profileId = uuid();
        const defaulted = await service.grant({
          qualificationId: ticket.id as string,
          profileId,
          issuedOn: '2026-01-31',
          certificateNumber: ' FA-1 ',
        });
        expect(defaulted).toMatchObject({
          tenantId: actor.tenantId,
          profileId,
          qualificationId: ticket.id,
          employmentId: null,
          issuedOn: '2026-01-31',
          expiresOn: '2029-01-31',
          certificateNumber: 'FA-1',
          status: 'valid',
          verifiedByProfileId: null,
          verifiedAt: null,
          renewalOfId: null,
        });
        const explicit = await service.grant({
          qualificationId: ticket.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-31',
          expiresOn: '2026-12-31',
        });
        expect(explicit.expiresOn).toBe('2026-12-31');
        const open = await service.grant({
          qualificationId: training.id as string,
          profileId,
          issuedOn: '2026-02-01',
        });
        expect(open.expiresOn).toBeNull();
        expect(types()).toEqual([
          'held-qualification.granted',
          'held-qualification.granted',
          'held-qualification.granted',
        ]);
        expect(events[0]).toMatchObject({
          effectiveOn: '2026-01-31',
          byProfileId: actor.profileId,
        });
        const history = await service.history(defaulted.id as string);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          kind: 'granted',
          effectiveOn: '2026-01-31',
          actorProfileId: actor.profileId,
        });
      });

      it('refuses an expiry it cannot work out, an expiry on a non-expiring qualification, bad dates and inactive definitions', async () => {
        const noDefault = await service.define({
          key: 'medical',
          name: 'Medical',
          kind: 'certification',
          expires: true,
        });
        const training = await orientation();
        const profileId = uuid();
        await expect(
          service.grant({
            qualificationId: noDefault.id as string,
            profileId,
            issuedOn: '2026-01-01',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.grant({
            qualificationId: noDefault.id as string,
            profileId,
            issuedOn: '2026-01-02',
            expiresOn: '2026-01-01',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        const sameDay = await service.grant({
          qualificationId: noDefault.id as string,
          profileId,
          issuedOn: '2026-01-02',
          expiresOn: '2026-01-02',
        });
        expect(sameDay.expiresOn).toBe('2026-01-02');
        await expect(
          service.grant({
            qualificationId: training.id as string,
            profileId,
            issuedOn: '2026-01-01',
            expiresOn: '2027-01-01',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        for (const issuedOn of ['2026-02-30', '2026-1-1', ''])
          await expect(
            service.grant({
              qualificationId: training.id as string,
              profileId,
              issuedOn,
            }),
          ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.grant({
            qualificationId: uuid(),
            profileId,
            issuedOn: '2026-01-01',
          }),
        ).rejects.toMatchObject(code('HR_NOT_FOUND'));
        await service.update(training.id as string, { isActive: false });
        await expect(
          service.grant({
            qualificationId: training.id as string,
            profileId,
            issuedOn: '2026-01-01',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
      });

      it('refuses a second grant while a lapsed ticket nobody swept is still stored as valid', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const lapsed = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2025-01-01',
          expiresOn: '2025-12-31',
        });
        // No sweep ran: the check says expired, the stored status says valid.
        expect(
          await service.check(profileId, qualificationId, '2026-03-01'),
        ).toEqual({ ok: false, reason: 'expired' });
        await expect(
          service.grant({ qualificationId, profileId, issuedOn: '2026-03-01' }),
        ).rejects.toMatchObject({
          code: 'HR_ALREADY_HELD',
          message: expect.stringContaining('renew'),
        });
        const renewal = await service.renew(lapsed.id as string, {
          issuedOn: '2026-03-01',
        });
        expect(
          await service.check(profileId, qualificationId, '2026-03-01'),
        ).toMatchObject({ ok: true, heldQualificationId: renewal.id });
      });

      it('records who verified the document and when', async () => {
        const training = await orientation();
        const documentAssetId = uuid();
        const before = Date.now();
        const held = await service.grant({
          qualificationId: training.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
          documentAssetId,
          verified: true,
        });
        expect(held.verifiedByProfileId).toBe(actor.profileId);
        expect(held.documentAssetId).toBe(documentAssetId);
        const at = new Date(held.verifiedAt as Date).getTime();
        expect(at).toBeGreaterThanOrEqual(before - 1000);
        expect(at).toBeLessThanOrEqual(Date.now() + 1000);
      });

      it('refuses a second live grant and tells the caller to renew', async () => {
        const ticket = await firstAid();
        const profileId = uuid();
        const input = {
          qualificationId: ticket.id as string,
          profileId,
          issuedOn: '2026-01-01',
        };
        const held = await service.grant(input);
        await expect(
          service.grant({ ...input, issuedOn: '2026-06-01' }),
        ).rejects.toMatchObject({
          code: 'HR_ALREADY_HELD',
          message: expect.stringContaining('renew'),
        });
        await service.suspend(held.id as string, {
          effectiveOn: '2026-02-01',
          reason: 'under review',
        });
        await expect(service.grant(input)).rejects.toMatchObject(
          code('HR_ALREADY_HELD'),
        );
        // Someone else may hold the same qualification.
        await service.grant({ ...input, profileId: uuid() });
        // After revocation a fresh grant is the way back.
        await service.revoke(held.id as string, {
          effectiveOn: '2026-03-01',
          reason: 'forged',
        });
        const again = await service.grant({ ...input, issuedOn: '2026-04-01' });
        expect(again.renewalOfId).toBeNull();
        expect(
          await service.check(profileId, ticket.id as string, '2026-03-15'),
        ).toEqual({ ok: false, reason: 'revoked' });
        expect(
          await service.check(profileId, ticket.id as string, '2026-04-01'),
        ).toEqual({
          ok: true,
          heldQualificationId: again.id,
          expiresOn: '2029-04-01',
        });
      });
    });

    describe('checking on a date', () => {
      it('answers before issue, on the expiry day and the day after without any sweep', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        expect(
          await service.check(profileId, qualificationId, '2026-01-01'),
        ).toEqual({ ok: false, reason: 'not-held' });
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-03-10',
          expiresOn: '2026-09-30',
        });
        expect(
          await service.check(profileId, qualificationId, '2026-03-09'),
        ).toEqual({ ok: false, reason: 'not-yet-issued' });
        const good = {
          ok: true,
          heldQualificationId: held.id,
          expiresOn: '2026-09-30',
        };
        expect(
          await service.check(profileId, qualificationId, '2026-03-10'),
        ).toEqual(good);
        expect(
          await service.check(profileId, qualificationId, '2026-09-30'),
        ).toEqual(good);
        expect(
          await service.check(profileId, qualificationId, '2026-10-01'),
        ).toEqual({ ok: false, reason: 'expired' });
        // The stored status was never touched.
        expect(
          (await service.listForProfile(profileId, '2026-10-01'))[0].held
            .status,
        ).toBe('valid');
        await expect(
          service.check(profileId, qualificationId, 'yesterday'),
        ).rejects.toMatchObject(code('HR_INVALID'));
      });

      it('treats a restriction like any other qualification', async () => {
        const [restriction] = await service.seed([
          { key: 'youth-worker', name: 'Youth worker', kind: 'restriction' },
        ]);
        const profileId = uuid();
        const held = await service.grant({
          qualificationId: restriction.id as string,
          profileId,
          issuedOn: '2026-05-01',
        });
        expect(
          await service.check(
            profileId,
            restriction.id as string,
            '2026-05-01',
          ),
        ).toEqual({ ok: true, heldQualificationId: held.id, expiresOn: null });
        expect(
          await service.check(
            profileId,
            restriction.id as string,
            '2026-04-30',
          ),
        ).toEqual({ ok: false, reason: 'not-yet-issued' });
        await service.revoke(held.id as string, {
          effectiveOn: '2027-05-01',
          reason: 'turned 18',
        });
        expect(
          await service.check(
            profileId,
            restriction.id as string,
            '2027-05-01',
          ),
        ).toEqual({ ok: false, reason: 'revoked' });
        expect(
          (
            await service.check(
              profileId,
              restriction.id as string,
              '2027-04-30',
            )
          ).ok,
        ).toBe(true);
      });
    });

    describe('suspending, reinstating and revoking', () => {
      it('changes the answer from the effective date on and leaves earlier dates as they were', async () => {
        const training = await orientation();
        const qualificationId = training.id as string;
        const profileId = uuid();
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
        });
        const id = held.id as string;
        events.length = 0;
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        const ok = { ok: true, heldQualificationId: id, expiresOn: null };

        expect(
          await service.suspend(id, {
            effectiveOn: '2026-03-01',
            reason: 'incident review',
          }),
        ).toMatchObject({ status: 'suspended' });
        expect(await on('2026-02-28')).toEqual(ok);
        expect(await on('2026-03-01')).toEqual({
          ok: false,
          reason: 'suspended',
        });

        expect(
          await service.reinstate(id, { effectiveOn: '2026-04-01' }),
        ).toMatchObject({ status: 'valid' });
        expect(await on('2026-03-31')).toEqual({
          ok: false,
          reason: 'suspended',
        });
        expect(await on('2026-04-01')).toEqual(ok);

        expect(
          await service.revoke(id, {
            effectiveOn: '2026-06-01',
            reason: 'fraud',
          }),
        ).toMatchObject({ status: 'revoked' });
        expect(await on('2026-05-31')).toEqual(ok);
        expect(await on('2026-06-01')).toEqual({
          ok: false,
          reason: 'revoked',
        });
        expect(await on('2026-02-28')).toEqual(ok);
        expect(await on('2026-03-15')).toEqual({
          ok: false,
          reason: 'suspended',
        });

        expect(types()).toEqual([
          'held-qualification.suspended',
          'held-qualification.reinstated',
          'held-qualification.revoked',
        ]);
        expect(events[2]).toMatchObject({ effectiveOn: '2026-06-01' });
        expect(
          (await service.history(id)).map((change) => [
            change.kind,
            change.effectiveOn,
            change.reason,
            change.actorProfileId,
          ]),
        ).toEqual([
          ['granted', '2026-01-01', '', actor.profileId],
          ['suspended', '2026-03-01', 'incident review', actor.profileId],
          ['reinstated', '2026-04-01', '', actor.profileId],
          ['revoked', '2026-06-01', 'fraud', actor.profileId],
        ]);
      });

      it('suspends and reinstates on the same day without confusing the replay', async () => {
        const training = await orientation();
        const profileId = uuid();
        const held = await service.grant({
          qualificationId: training.id as string,
          profileId,
          issuedOn: '2026-01-01',
        });
        const id = held.id as string;
        const day = { effectiveOn: '2026-02-01', reason: 'mistake' };
        await service.suspend(id, day);
        await service.reinstate(id, day);
        expect(
          (await service.check(profileId, training.id as string, '2026-02-01'))
            .ok,
        ).toBe(true);
        await service.suspend(id, day);
        expect(
          await service.check(profileId, training.id as string, '2026-02-02'),
        ).toEqual({ ok: false, reason: 'suspended' });
      });

      it('rejects transitions the lifecycle does not allow, and revocation is final', async () => {
        const training = await orientation();
        const held = await service.grant({
          qualificationId: training.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-10',
        });
        const id = held.id as string;
        const transition = code('HR_STATUS_TRANSITION');
        await expect(
          service.reinstate(id, { effectiveOn: '2026-02-01' }),
        ).rejects.toMatchObject(transition);
        await expect(
          service.suspend(id, { effectiveOn: '2026-02-01', reason: ' ' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.suspend(id, { effectiveOn: '2026-01-09', reason: 'early' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await service.suspend(id, {
          effectiveOn: '2026-02-01',
          reason: 'review',
        });
        await expect(
          service.suspend(id, { effectiveOn: '2026-02-02', reason: 'again' }),
        ).rejects.toMatchObject(transition);
        await expect(
          service.reinstate(id, { effectiveOn: '2026-01-31' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await service.revoke(id, { effectiveOn: '2026-02-01', reason: 'done' });
        for (const attempt of [
          () => service.suspend(id, { effectiveOn: '2026-03-01', reason: 'x' }),
          () => service.reinstate(id, { effectiveOn: '2026-03-01' }),
          () => service.revoke(id, { effectiveOn: '2026-03-01', reason: 'x' }),
        ])
          await expect(attempt()).rejects.toMatchObject(transition);
        await expect(
          service.suspend(uuid(), { effectiveOn: '2026-03-01', reason: 'x' }),
        ).rejects.toMatchObject(code('HR_NOT_FOUND'));
        expect(await service.history(id)).toHaveLength(3);
      });
    });

    describe('renewing', () => {
      it('refuses a renewal that ends before what it renews, and says how to replace it with a shorter one', async () => {
        const licence = await service.define({
          key: 'drivers-licence',
          name: "Driver's licence",
          kind: 'ticket',
          expires: true,
        });
        const qualificationId = licence.id as string;
        const profileId = uuid();
        const fiveYear = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
          expiresOn: '2030-12-31',
        });
        // A two-year renewal would lapse while the five-year licence, which
        // still answers for its own period, kept the person passing.
        await expect(
          service.renew(fiveYear.id as string, {
            issuedOn: '2026-09-01',
            expiresOn: '2028-08-31',
          }),
        ).rejects.toMatchObject({
          code: 'HR_INVALID',
          message: expect.stringMatching(
            /cannot end before what it renews \(2030-12-31\).*revoke it from 2026-09-01 and grant a new one/,
          ),
        });
        expect(await service.history(fiveYear.id as string)).toHaveLength(1);
        // The same last day, or a later one, is a renewal.
        // The way to a shorter one is the one the message gives.
        await service.revoke(fiveYear.id as string, {
          effectiveOn: '2026-09-01',
          reason: 'replaced by a two-year licence',
        });
        const twoYear = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-09-01',
          expiresOn: '2028-08-31',
        });
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        expect(await on('2026-08-31')).toMatchObject({
          ok: true,
          heldQualificationId: fiveYear.id,
        });
        expect(await on('2028-08-31')).toMatchObject({
          ok: true,
          heldQualificationId: twoYear.id,
        });
        expect(await on('2028-09-01')).toEqual({
          ok: false,
          reason: 'expired',
        });
        // The lapse the sweep announces is one the gate agrees with.
        events.length = 0;
        const swept = await service.sweepExpired('2028-09-10');
        expect(swept.map((row) => row.id)).toEqual([twoYear.id]);
        const same = await service.renew(twoYear.id as string, {
          issuedOn: '2028-09-11',
          expiresOn: '2030-09-10',
        });
        expect(same.renewalOfId).toBe(twoYear.id);
      });

      it('refuses to renew a ticket that never expires with one that does', async () => {
        const training = await orientation();
        const held = await service.grant({
          qualificationId: training.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        await service.update(training.id as string, {
          expires: true,
          validityMonths: 12,
        });
        await expect(
          service.renew(held.id as string, { issuedOn: '2026-06-01' }),
        ).rejects.toMatchObject({
          code: 'HR_INVALID',
          message: expect.stringContaining('(no expiry)'),
        });
      });

      it('adds a new row that points at the old one, so past dates still answer from the old row', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const old = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2023-06-01',
          certificateNumber: 'OLD',
        });
        expect(old.expiresOn).toBe('2026-06-01');
        events.length = 0;
        const renewed = await service.renew(old.id as string, {
          issuedOn: '2026-05-15',
          certificateNumber: 'NEW',
          verified: true,
        });
        expect(renewed).toMatchObject({
          renewalOfId: old.id,
          profileId,
          qualificationId,
          issuedOn: '2026-05-15',
          expiresOn: '2029-05-15',
          certificateNumber: 'NEW',
          status: 'valid',
          verifiedByProfileId: actor.profileId,
        });
        expect(renewed.id).not.toBe(old.id);
        expect(types()).toEqual(['held-qualification.renewed']);
        const [event] = events;
        expect('heldQualification' in event && event.heldQualification.id).toBe(
          renewed.id,
        );
        expect(event.effectiveOn).toBe('2026-05-15');

        // The old row is untouched and still answers for its own period.
        expect(
          await service.check(profileId, qualificationId, '2025-01-01'),
        ).toEqual({
          ok: true,
          heldQualificationId: old.id,
          expiresOn: '2026-06-01',
        });
        // Where both are good the one that lasts longest answers.
        expect(
          await service.check(profileId, qualificationId, '2026-05-20'),
        ).toEqual({
          ok: true,
          heldQualificationId: renewed.id,
          expiresOn: '2029-05-15',
        });
        expect(
          await service.check(profileId, qualificationId, '2029-05-16'),
        ).toEqual({ ok: false, reason: 'expired' });
        expect(
          (await service.history(old.id as string)).map((c) => c.kind),
        ).toEqual(['granted']);
        expect(
          (await service.history(renewed.id as string)).map((c) => [
            c.kind,
            c.effectiveOn,
          ]),
        ).toEqual([['renewed', '2026-05-15']]);
        // The list for the person shows only the renewal.
        const listed = await service.listForProfile(profileId, '2026-05-20');
        expect(listed.map((entry) => entry.held.id)).toEqual([renewed.id]);
      });

      it('renews a lapsed ticket with a gap that stays a gap', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const old = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2025-01-01',
          expiresOn: '2025-12-31',
        });
        await service.sweepExpired('2026-02-01');
        const renewed = await service.renew(old.id as string, {
          issuedOn: '2026-03-01',
          expiresOn: '2027-02-28',
        });
        expect(
          await service.check(profileId, qualificationId, '2026-01-15'),
        ).toEqual({ ok: false, reason: 'expired' });
        expect(
          (await service.check(profileId, qualificationId, '2026-03-01')).ok,
        ).toBe(true);
        expect(renewed.renewalOfId).toBe(old.id);
      });

      it('refuses to renew twice, to renew a revoked row, or to backdate a renewal', async () => {
        const ticket = await firstAid();
        const old = await service.grant({
          qualificationId: ticket.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        await expect(
          service.renew(old.id as string, { issuedOn: '2025-12-31' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        const renewed = await service.renew(old.id as string, {
          issuedOn: '2026-06-01',
        });
        await expect(
          service.renew(old.id as string, { issuedOn: '2026-07-01' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await service.revoke(renewed.id as string, {
          effectiveOn: '2026-08-01',
          reason: 'withdrawn',
        });
        await expect(
          service.renew(renewed.id as string, { issuedOn: '2026-09-01' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.renew(uuid(), { issuedOn: '2026-09-01' }),
        ).rejects.toMatchObject(code('HR_NOT_FOUND'));
      });
    });

    describe('employment-scoped qualifications', () => {
      it('requires the person to be employed on the issue date and rejects an employment on a person-scoped grant', async () => {
        const authorization = await service.define({
          key: 'forklift-on-site',
          name: 'Forklift on site',
          kind: 'authorization',
        });
        const training = await orientation();
        const qualificationId = authorization.id as string;
        const profileId = uuid();
        const scope = code('HR_QUALIFICATION_SCOPE');
        await expect(
          service.grant({ qualificationId, profileId, issuedOn: '2026-03-01' }),
        ).rejects.toMatchObject(scope);
        const employmentId = await hire(profileId, '2026-02-01');
        await expect(
          service.grant({ qualificationId, profileId, issuedOn: '2026-01-31' }),
        ).rejects.toMatchObject(scope);
        const otherEmploymentId = await hire(uuid(), '2026-02-01');
        await expect(
          service.grant({
            qualificationId,
            profileId,
            issuedOn: '2026-03-01',
            employmentId: otherEmploymentId,
          }),
        ).rejects.toMatchObject(scope);
        await expect(
          service.grant({
            qualificationId: training.id as string,
            profileId,
            issuedOn: '2026-03-01',
            employmentId,
          }),
        ).rejects.toMatchObject(scope);
        const resolved = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-02-01',
        });
        expect(resolved.employmentId).toBe(employmentId);
        const secondProfile = uuid();
        const secondEmployment = await hire(secondProfile, '2026-01-01');
        const explicit = await service.grant({
          qualificationId,
          profileId: secondProfile,
          issuedOn: '2026-03-01',
          employmentId: secondEmployment,
        });
        expect(explicit.employmentId).toBe(secondEmployment);
        const renewal = await service.renew(explicit.id as string, {
          issuedOn: '2026-04-01',
        });
        expect(renewal.employmentId).toBe(secondEmployment);
      });

      it('is revoked when the employment ends while a person-scoped one survives', async () => {
        const authorization = await service.define({
          key: 'forklift-on-site',
          name: 'Forklift on site',
          kind: 'authorization',
        });
        const ticket = await firstAid();
        const profileId = uuid();
        const employmentId = await hire(profileId, '2026-01-01');
        const scoped = await service.grant({
          qualificationId: authorization.id as string,
          profileId,
          issuedOn: '2026-01-05',
        });
        const personal = await service.grant({
          qualificationId: ticket.id as string,
          profileId,
          issuedOn: '2026-01-05',
        });
        const queued = await endEmployment(employmentId, '2026-06-30');
        expect(queued.map((event) => event.type)).toEqual([
          'held-qualification.revoked',
          'employment.ended',
        ]);
        expect(queued[0]).toMatchObject({ effectiveOn: '2026-07-01' });
        const check = (date: string) =>
          service.check(profileId, authorization.id as string, date);
        expect(await check('2026-06-30')).toEqual({
          ok: true,
          heldQualificationId: scoped.id,
          expiresOn: null,
        });
        expect(await check('2026-07-01')).toEqual({
          ok: false,
          reason: 'revoked',
        });
        expect(
          (await service.history(scoped.id as string)).map((change) => [
            change.kind,
            change.effectiveOn,
            change.reason,
          ]),
        ).toEqual([
          ['granted', '2026-01-05', ''],
          ['revoked', '2026-07-01', EMPLOYMENT_ENDED_REASON],
        ]);
        expect(
          await service.check(profileId, ticket.id as string, '2026-07-01'),
        ).toEqual({
          ok: true,
          heldQualificationId: personal.id,
          expiresOn: '2029-01-05',
        });
        const listed = await service.listForProfile(profileId, '2026-07-01');
        expect(
          listed.map((entry) => [entry.qualification.key, entry.status]),
        ).toEqual([
          ['first-aid', 'valid'],
          ['forklift-on-site', 'revoked'],
        ]);
        // No longer employed, so the authorization cannot be granted again.
        await expect(
          service.grant({
            qualificationId: authorization.id as string,
            profileId,
            issuedOn: '2026-07-02',
          }),
        ).rejects.toMatchObject(code('HR_QUALIFICATION_SCOPE'));
      });
    });

    describe('ending the employment for real', () => {
      it('keeps an employment-scoped qualification good on the last day employed and revokes it the day after', async () => {
        const authorization = await service.define({
          key: 'forklift-on-site',
          name: 'Forklift on site',
          kind: 'authorization',
        });
        const qualificationId = authorization.id as string;
        const profileId = uuid();
        const employmentId = await hire(profileId, '2026-01-01');
        const scoped = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-05',
        });
        await employment.end(employmentId, { endedOn: '2026-06-30' });

        // The last day: still employed, so still authorized.
        expect(await employment.check(profileId, '2026-06-30')).toMatchObject({
          ok: true,
        });
        expect(
          await service.check(profileId, qualificationId, '2026-06-30'),
        ).toEqual({
          ok: true,
          heldQualificationId: scoped.id,
          expiresOn: null,
        });
        expect(
          (await service.holders(qualificationId, '2026-06-30')).map(
            (row) => row.id,
          ),
        ).toEqual([scoped.id]);
        // The day after: neither.
        expect(await employment.check(profileId, '2026-07-01')).toEqual({
          ok: false,
          reason: 'ended',
        });
        expect(
          await service.check(profileId, qualificationId, '2026-07-01'),
        ).toEqual({ ok: false, reason: 'revoked' });
        expect(await service.holders(qualificationId, '2026-07-01')).toEqual(
          [],
        );
      });
    });

    describe('a renewal chain shares its standing', () => {
      /** A ticket valid through 2026, renewed in June through June 2027. */
      async function renewedTicket() {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const old = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
          expiresOn: '2026-12-31',
        });
        const renewal = await service.renew(old.id as string, {
          issuedOn: '2026-06-01',
          expiresOn: '2027-06-01',
        });
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        const holderIds = async (date: string) =>
          (await service.holders(qualificationId, date)).map((row) => row.id);
        const listed = async (date: string) =>
          (await service.listForProfile(profileId, date)).map((entry) => [
            entry.held.id,
            entry.status,
          ]);
        return { old, renewal, on, holderIds, listed };
      }

      it('fails the check when the renewal is revoked, even though the row it renewed has not expired', async () => {
        const { old, renewal, on, holderIds, listed } = await renewedTicket();
        await service.revoke(renewal.id as string, {
          effectiveOn: '2026-07-01',
          reason: 'forged',
        });
        expect(await on('2026-07-15')).toEqual({
          ok: false,
          reason: 'revoked',
        });
        expect(await holderIds('2026-07-15')).toEqual([]);
        expect(await listed('2026-07-15')).toEqual([[renewal.id, 'revoked']]);
        // Dates before the revocation answer as they did.
        expect(await on('2026-06-30')).toEqual({
          ok: true,
          heldQualificationId: renewal.id,
          expiresOn: '2027-06-01',
        });
        expect(await on('2026-03-01')).toEqual({
          ok: true,
          heldQualificationId: old.id,
          expiresOn: '2026-12-31',
        });
        expect(await holderIds('2026-03-01')).toEqual([old.id]);
      });

      it('fails the check while the renewal is suspended and passes again once it is reinstated', async () => {
        const { renewal, on, holderIds, listed } = await renewedTicket();
        await service.suspend(renewal.id as string, {
          effectiveOn: '2026-07-01',
          reason: 'under review',
        });
        expect(await on('2026-07-15')).toEqual({
          ok: false,
          reason: 'suspended',
        });
        expect(await holderIds('2026-07-15')).toEqual([]);
        expect(await listed('2026-07-15')).toEqual([[renewal.id, 'suspended']]);
        await service.reinstate(renewal.id as string, {
          effectiveOn: '2026-08-01',
        });
        expect(await on('2026-07-15')).toEqual({
          ok: false,
          reason: 'suspended',
        });
        expect(await on('2026-08-01')).toEqual({
          ok: true,
          heldQualificationId: renewal.id,
          expiresOn: '2027-06-01',
        });
        expect(await holderIds('2026-08-01')).toEqual([renewal.id]);
      });

      it('rejects revoking, suspending or reinstating a row that was renewed and points at the latest row', async () => {
        const { old, renewal, on } = await renewedTicket();
        const change = { effectiveOn: '2026-07-01', reason: 'forged' };
        for (const attempt of [
          () => service.revoke(old.id as string, change),
          () => service.suspend(old.id as string, change),
          () => service.reinstate(old.id as string, change),
        ])
          await expect(attempt()).rejects.toMatchObject({
            code: 'HR_INVALID',
            message: expect.stringContaining('latest row'),
          });
        expect(
          (await service.history(old.id as string)).map((c) => c.kind),
        ).toEqual(['granted']);
        // Nothing changed, so the person still passes through the renewal.
        expect(await on('2026-07-15')).toEqual({
          ok: true,
          heldQualificationId: renewal.id,
          expiresOn: '2027-06-01',
        });
      });

      it('lists a person as holding the qualification on a date the row being renewed covers', async () => {
        const { renewal, on, listed } = await renewedTicket();
        expect((await on('2026-03-01')).ok).toBe(true);
        expect(await listed('2026-03-01')).toEqual([[renewal.id, 'valid']]);
        expect(await listed('2025-12-31')).toEqual([
          [renewal.id, 'not-yet-issued'],
        ]);
      });

      it('renews a lapsed ticket up to its scheduled revocation even after the next grant was recorded from that day', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const first = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
          expiresOn: '2026-05-31',
        });
        await service.revoke(first.id as string, {
          effectiveOn: '2026-07-01',
          reason: 'replaced by the new scheme',
        });
        const next = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-07-01',
          expiresOn: '2027-06-30',
        });
        // The June gap is closed although the July grant was recorded first:
        // the renewal is cut off on the day the other grant starts.
        const renewal = await service.renew(first.id as string, {
          issuedOn: '2026-06-01',
          expiresOn: '2026-12-31',
        });
        expect(await historyOf(renewal.id)).toEqual([
          ['renewed', '2026-06-01', ''],
          ['revoked', '2026-07-01', 'replaced by the new scheme'],
        ]);
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        expect(await on('2026-06-15')).toMatchObject({
          ok: true,
          heldQualificationId: renewal.id,
        });
        expect(await on('2026-07-01')).toMatchObject({
          ok: true,
          heldQualificationId: next.id,
        });
      });

      it('refuses to renew an old row while the person holds a newer grant outside its chain', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const lapsed = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2025-01-01',
          expiresOn: '2025-12-31',
        });
        await service.sweepExpired('2026-01-15');
        // Sweeping stores `expired` and changes nothing about the rule: a
        // lapsed ticket is renewed, never granted again.
        await expect(
          service.grant({ qualificationId, profileId, issuedOn: '2026-02-01' }),
        ).rejects.toMatchObject({
          code: 'HR_ALREADY_HELD',
          message: expect.stringContaining('renew'),
        });
        // The service cannot produce a second chain beside a lapsed one, so
        // write one directly, as rows from before that rule could hold it.
        const fresh = await withTenant({ tenantId: actor.tenantId }, () =>
          insertHr(HeldQualification, db, {
            tenantId: actor.tenantId,
            qualificationId,
            profileId,
            issuedOn: '2026-02-01',
            expiresOn: '2029-02-01',
            status: 'valid',
          }),
        );
        await expect(
          service.renew(lapsed.id as string, { issuedOn: '2026-03-01' }),
        ).rejects.toMatchObject(code('HR_ALREADY_HELD'));
        expect(
          (await service.listForProfile(profileId, '2026-03-01')).map(
            (entry) => entry.held.id,
          ),
        ).toEqual([lapsed.id, fresh.id]);
        // Two chains that are both still held block each other; revoking the
        // stale one on or before the issue date leaves one to renew.
        await expect(
          service.renew(fresh.id as string, { issuedOn: '2026-03-01' }),
        ).rejects.toMatchObject(code('HR_ALREADY_HELD'));
        await service.revoke(lapsed.id as string, {
          effectiveOn: '2026-03-01',
          reason: 'superseded by a separate grant',
        });
        const renewal = await service.renew(fresh.id as string, {
          issuedOn: '2026-03-01',
        });
        expect(renewal.renewalOfId).toBe(fresh.id);
      });

      it('refuses to renew a suspended qualification until it is reinstated', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
        });
        await service.suspend(held.id as string, {
          effectiveOn: '2026-02-01',
          reason: 'under review',
        });
        await expect(
          service.renew(held.id as string, { issuedOn: '2026-03-01' }),
        ).rejects.toMatchObject({
          code: 'HR_STATUS_TRANSITION',
          message: expect.stringContaining('reinstate'),
        });
        expect(
          await service.check(profileId, qualificationId, '2026-03-15'),
        ).toEqual({ ok: false, reason: 'suspended' });
        await service.reinstate(held.id as string, {
          effectiveOn: '2026-04-01',
        });
        const renewal = await service.renew(held.id as string, {
          issuedOn: '2026-04-01',
        });
        expect(
          await service.check(profileId, qualificationId, '2026-04-02'),
        ).toMatchObject({ ok: true, heldQualificationId: renewal.id });
      });
    });

    describe('standing is decided by date, not by the stored status', () => {
      const authorizationFor = async () =>
        (
          await service.define({
            key: 'forklift-on-site',
            name: 'Forklift on site',
            kind: 'authorization',
          })
        ).id as string;
      const historyOf = async (id: unknown) =>
        (await service.history(id as string)).map((change) => [
          change.kind,
          change.effectiveOn,
          change.reason,
        ]);

      it('ends an employment-scoped qualification granted after the end was recorded on the last day employed', async () => {
        const qualificationId = await authorizationFor();
        const profileId = uuid();
        const employmentId = await hire(profileId, '2026-01-01');
        // Notice: the end is recorded first, the authorization granted after.
        await endEmployment(employmentId, '2026-06-30');
        events.length = 0;
        const late = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-03-01',
        });
        expect(late).toMatchObject({ employmentId, status: 'revoked' });
        expect(events.map((event) => [event.type, event.effectiveOn])).toEqual([
          ['held-qualification.granted', '2026-03-01'],
          ['held-qualification.revoked', '2026-07-01'],
        ]);
        expect(await historyOf(late.id)).toEqual([
          ['granted', '2026-03-01', ''],
          ['revoked', '2026-07-01', EMPLOYMENT_ENDED_REASON],
        ]);
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        expect(await on('2026-06-30')).toEqual({
          ok: true,
          heldQualificationId: late.id,
          expiresOn: null,
        });
        expect(await on('2026-07-01')).toEqual({
          ok: false,
          reason: 'revoked',
        });
        expect(await service.holders(qualificationId, '2026-07-01')).toEqual(
          [],
        );
        expect(
          (await service.listForProfile(profileId, '2026-07-01')).map(
            (entry) => entry.status,
          ),
        ).toEqual(['revoked']);
      });

      it('cuts an employment-scoped qualification off at the employment end even when a later revocation was already recorded', async () => {
        const qualificationId = await authorizationFor();
        const profileId = uuid();
        const employmentId = await hire(profileId, '2026-01-01');
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
        });
        // Stored as revoked at once, though it takes effect in December.
        await service.revoke(held.id as string, {
          effectiveOn: '2026-12-31',
          reason: 'project closes',
        });
        const delivered = await endEmployment(employmentId, '2026-06-30');
        expect(
          delivered.map((event) => [event.type, event.effectiveOn]),
        ).toEqual([
          ['held-qualification.revoked', '2026-07-01'],
          ['employment.ended', '2026-06-30'],
        ]);
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        expect((await on('2026-06-30')).ok).toBe(true);
        for (const date of ['2026-07-01', '2026-09-15', '2026-12-30'])
          expect(await on(date)).toEqual({ ok: false, reason: 'revoked' });
        expect(await service.holders(qualificationId, '2026-09-15')).toEqual(
          [],
        );
        // History stays append-only: the earlier cutoff is one more row.
        expect(await historyOf(held.id)).toEqual([
          ['granted', '2026-01-01', ''],
          ['revoked', '2026-07-01', EMPLOYMENT_ENDED_REASON],
          ['revoked', '2026-12-31', 'project closes'],
        ]);
      });

      it('adds no employment-end revocation to a qualification already revoked on or before the cutoff', async () => {
        const qualificationId = await authorizationFor();
        const profileId = uuid();
        const employmentId = await hire(profileId, '2026-01-01');
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
        });
        await service.revoke(held.id as string, {
          effectiveOn: '2026-07-01',
          reason: 'withdrawn',
        });
        const delivered = await endEmployment(employmentId, '2026-06-30');
        expect(delivered.map((event) => event.type)).toEqual([
          'employment.ended',
        ]);
        expect(await historyOf(held.id)).toEqual([
          ['granted', '2026-01-01', ''],
          ['revoked', '2026-07-01', 'withdrawn'],
        ]);
      });

      it('refuses a fresh grant dated before a scheduled revocation takes effect', async () => {
        const training = await orientation();
        const qualificationId = training.id as string;
        const profileId = uuid();
        const old = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
        });
        // Recorded now, effective next year: the old row is good all of 2026.
        expect(
          await service.revoke(old.id as string, {
            effectiveOn: '2027-01-01',
            reason: 'replaced by the new scheme',
          }),
        ).toMatchObject({ status: 'revoked' });
        await expect(
          service.grant({ qualificationId, profileId, issuedOn: '2026-06-01' }),
        ).rejects.toMatchObject({
          code: 'HR_ALREADY_HELD',
          message: expect.stringMatching(/2027-01-01.*renew the existing one/),
        });
        await expect(
          service.grant({ qualificationId, profileId, issuedOn: '2026-12-31' }),
        ).rejects.toMatchObject(code('HR_ALREADY_HELD'));
        const fresh = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2027-01-01',
        });
        expect(
          await service.check(profileId, qualificationId, '2026-12-31'),
        ).toMatchObject({ ok: true, heldQualificationId: old.id });
        expect(
          await service.check(profileId, qualificationId, '2027-01-01'),
        ).toMatchObject({ ok: true, heldQualificationId: fresh.id });
        expect(
          (await service.holders(qualificationId, '2026-12-31')).map(
            (row) => row.id,
          ),
        ).toEqual([old.id]);
      });

      it('refuses a renewal that reaches back over a recorded suspension', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
        });
        const id = held.id as string;
        await service.suspend(id, {
          effectiveOn: '2026-02-01',
          reason: 'under review',
        });
        // The stored status is valid again from the moment this is recorded.
        expect(
          await service.reinstate(id, { effectiveOn: '2026-04-01' }),
        ).toMatchObject({ status: 'valid' });
        await expect(
          service.renew(id, { issuedOn: '2026-03-01' }),
        ).rejects.toMatchObject({
          code: 'HR_INVALID',
          message: expect.stringContaining('2026-04-01'),
        });
        expect(
          await service.check(profileId, qualificationId, '2026-03-15'),
        ).toEqual({ ok: false, reason: 'suspended' });
        const renewal = await service.renew(id, { issuedOn: '2026-04-01' });
        expect(
          await service.check(profileId, qualificationId, '2026-03-15'),
        ).toEqual({ ok: false, reason: 'suspended' });
        expect(
          await service.check(profileId, qualificationId, '2026-04-01'),
        ).toMatchObject({ ok: true, heldQualificationId: renewal.id });

        // A suspension recorded ahead of time blocks an earlier renewal too.
        const other = await service.grant({
          qualificationId,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        await service.suspend(other.id as string, {
          effectiveOn: '2026-09-01',
          reason: 'audit booked',
        });
        await expect(
          service.renew(other.id as string, { issuedOn: '2026-06-01' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await expect(
          service.renew(other.id as string, { issuedOn: '2026-09-01' }),
        ).rejects.toMatchObject(code('HR_STATUS_TRANSITION'));
      });

      /** A ticket valid through 2026 whose 2027 renewal is already recorded. */
      async function renewedAhead() {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const current = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
          expiresOn: '2026-12-31',
        });
        const renewal = await service.renew(current.id as string, {
          issuedOn: '2027-01-01',
          expiresOn: '2027-12-31',
        });
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        const holderIds = async (date: string) =>
          (await service.holders(qualificationId, date)).map((row) => row.id);
        const listed = async (date: string) =>
          (await service.listForProfile(profileId, date)).map((entry) => [
            entry.held.id,
            entry.status,
          ]);
        return { current, renewal, on, holderIds, listed };
      }

      it('suspends and reinstates the ticket in force today after its renewal was recorded ahead of time', async () => {
        const { current, renewal, on, holderIds, listed } =
          await renewedAhead();
        const renewalId = renewal.id as string;
        const good2026 = {
          ok: true,
          heldQualificationId: current.id,
          expiresOn: '2026-12-31',
        };
        const good2027 = {
          ok: true,
          heldQualificationId: renewal.id,
          expiresOn: '2027-12-31',
        };
        const suspended = { ok: false, reason: 'suspended' };
        // Not before the chain was first issued.
        await expect(
          service.suspend(renewalId, {
            effectiveOn: '2025-12-31',
            reason: 'too early',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await service.suspend(renewalId, {
          effectiveOn: '2026-10-01',
          reason: 'incident review',
        });
        expect(await on('2026-09-30')).toEqual(good2026);
        expect(await on('2026-10-01')).toEqual(suspended);
        // The renewal's issue date does not lift the suspension.
        expect(await on('2027-01-15')).toEqual(suspended);
        expect(await holderIds('2026-10-15')).toEqual([]);
        expect(await holderIds('2027-01-15')).toEqual([]);
        expect(await listed('2026-09-30')).toEqual([[renewalId, 'valid']]);
        expect(await listed('2026-10-15')).toEqual([[renewalId, 'suspended']]);
        expect(await listed('2027-01-15')).toEqual([[renewalId, 'suspended']]);

        // Not before the suspension it lifts.
        await expect(
          service.reinstate(renewalId, { effectiveOn: '2026-09-30' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        await service.reinstate(renewalId, { effectiveOn: '2026-11-01' });
        expect(await on('2026-10-15')).toEqual(suspended);
        expect(await on('2026-11-01')).toEqual(good2026);
        expect(await on('2027-01-15')).toEqual(good2027);
        expect(await holderIds('2026-11-01')).toEqual([current.id]);
        expect(await holderIds('2027-01-15')).toEqual([renewalId]);
        expect(await listed('2026-10-15')).toEqual([[renewalId, 'suspended']]);
        expect(await listed('2026-11-01')).toEqual([[renewalId, 'valid']]);

        // A suspension still open when the renewal is issued carries over
        // until it is reinstated.
        await service.suspend(renewalId, {
          effectiveOn: '2026-12-01',
          reason: 'second review',
        });
        await service.reinstate(renewalId, { effectiveOn: '2027-02-01' });
        expect(await on('2026-12-15')).toEqual(suspended);
        expect(await on('2027-01-15')).toEqual(suspended);
        expect(await on('2027-02-01')).toEqual(good2027);
        expect(await listed('2027-01-15')).toEqual([[renewalId, 'suspended']]);
        // The row that was renewed still cannot be acted on by itself.
        await expect(
          service.suspend(current.id as string, {
            effectiveOn: '2026-12-10',
            reason: 'wrong row',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
      });

      it('revokes the ticket in force today after its renewal was recorded ahead of time, and the renewal never restores it', async () => {
        const { current, renewal, on, holderIds, listed } =
          await renewedAhead();
        const renewalId = renewal.id as string;
        await service.revoke(renewalId, {
          effectiveOn: '2026-10-01',
          reason: 'forged',
        });
        expect(await on('2026-09-30')).toEqual({
          ok: true,
          heldQualificationId: current.id,
          expiresOn: '2026-12-31',
        });
        for (const date of [
          '2026-10-01',
          '2026-12-31',
          '2027-01-01',
          '2027-06-01',
        ])
          expect(await on(date)).toEqual({ ok: false, reason: 'revoked' });
        expect(await holderIds('2026-09-30')).toEqual([current.id]);
        expect(await holderIds('2026-10-01')).toEqual([]);
        expect(await holderIds('2027-01-01')).toEqual([]);
        expect(await listed('2026-09-30')).toEqual([[renewalId, 'valid']]);
        expect(await listed('2026-10-01')).toEqual([[renewalId, 'revoked']]);
        expect(await listed('2027-01-01')).toEqual([[renewalId, 'revoked']]);
        expect(await historyOf(renewalId)).toEqual([
          ['revoked', '2026-10-01', 'forged'],
          ['renewed', '2027-01-01', ''],
        ]);
        expect(await historyOf(current.id)).toEqual([
          ['granted', '2026-01-01', ''],
        ]);
      });

      it('lists what is expiring by standing on the day asked, not by the stored status', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const grant = (issuedOn = '2026-01-01', expiresOn = '2026-06-30') =>
          service.grant({
            qualificationId,
            profileId: uuid(),
            issuedOn,
            expiresOn,
          });
        // Suspended on the day asked, though reinstatement is recorded and the
        // stored status already reads valid.
        const suspendedToday = await grant();
        await service.suspend(suspendedToday.id as string, {
          effectiveOn: '2026-05-01',
          reason: 'review',
        });
        expect(
          await service.reinstate(suspendedToday.id as string, {
            effectiveOn: '2026-07-01',
          }),
        ).toMatchObject({ status: 'valid' });
        // Valid on the day asked, though a later suspension is recorded and
        // the stored status already reads suspended.
        const suspendedLater = await grant('2026-01-01', '2026-06-20');
        expect(
          await service.suspend(suspendedLater.id as string, {
            effectiveOn: '2026-06-15',
            reason: 'booked audit',
          }),
        ).toMatchObject({ status: 'suspended' });
        // Same for a revocation that has not taken effect yet.
        const revokedLater = await grant('2026-01-01', '2026-06-25');
        await service.revoke(revokedLater.id as string, {
          effectiveOn: '2026-06-10',
          reason: 'scheme closes',
        });
        // Not issued yet on the day asked.
        await grant('2026-06-05', '2026-06-28');
        const plain = await grant('2026-01-01', '2026-06-12');

        const listed = async (today: string) =>
          (await service.expiringWithin(30, today)).map((row) => row.id);
        expect(await listed('2026-06-01')).toEqual([
          plain.id,
          suspendedLater.id,
          revokedLater.id,
        ]);
        for (const row of [suspendedToday, suspendedLater, revokedLater]) {
          const held = (
            await service.check(row.profileId, qualificationId, '2026-06-01')
          ).ok;
          expect(held).toBe(row.id !== suspendedToday.id);
        }
        // Once the later changes take effect the tickets drop out.
        expect(await listed('2026-06-15')).toHaveLength(1);
      });

      it('suspends, reinstates and revokes earlier a qualification whose revocation is recorded for a later date', async () => {
        const training = await orientation();
        const qualificationId = training.id as string;
        const profileId = uuid();
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-10',
        });
        const id = held.id as string;
        expect(
          await service.revoke(id, {
            effectiveOn: '2027-01-01',
            reason: 'scheme closes',
          }),
        ).toMatchObject({ status: 'revoked' });
        events.length = 0;
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        const holderIds = async (date: string) =>
          (await service.holders(qualificationId, date)).map((row) => row.id);
        const listed = async (date: string) =>
          (await service.listForProfile(profileId, date)).map(
            (entry) => entry.status,
          );
        const ok = { ok: true, heldQualificationId: id, expiresOn: null };
        const suspended = { ok: false, reason: 'suspended' };
        const revoked = { ok: false, reason: 'revoked' };
        expect(await on('2026-10-03')).toEqual(ok);

        // The stored status already reads `revoked`, and stays so: the
        // suspension is a dated change only.
        expect(
          await service.suspend(id, {
            effectiveOn: '2026-10-03',
            reason: 'incident',
          }),
        ).toMatchObject({ status: 'revoked' });
        expect(await on('2026-10-02')).toEqual(ok);
        expect(await on('2026-10-03')).toEqual(suspended);
        expect(await on('2026-12-31')).toEqual(suspended);
        expect(await on('2027-01-01')).toEqual(revoked);
        expect(await holderIds('2026-10-02')).toEqual([id]);
        expect(await holderIds('2026-10-03')).toEqual([]);
        expect(await listed('2026-10-03')).toEqual(['suspended']);
        expect(await listed('2027-01-01')).toEqual(['revoked']);

        expect(
          await service.reinstate(id, { effectiveOn: '2026-10-10' }),
        ).toMatchObject({ status: 'revoked' });
        expect(await on('2026-10-09')).toEqual(suspended);
        expect(await on('2026-10-10')).toEqual(ok);
        expect(await on('2026-12-31')).toEqual(ok);
        expect(await on('2027-01-01')).toEqual(revoked);
        expect(await holderIds('2026-12-31')).toEqual([id]);

        // An urgent revocation ahead of the scheduled one: the earliest wins.
        expect(
          await service.revoke(id, {
            effectiveOn: '2026-10-20',
            reason: 'fraud',
          }),
        ).toMatchObject({ status: 'revoked' });
        expect(await on('2026-10-19')).toEqual(ok);
        expect(await on('2026-10-20')).toEqual(revoked);
        expect(await on('2026-12-31')).toEqual(revoked);
        expect(await holderIds('2026-10-20')).toEqual([]);
        expect(await listed('2026-10-19')).toEqual(['valid']);
        expect(await listed('2026-10-20')).toEqual(['revoked']);

        expect(events.map((event) => [event.type, event.effectiveOn])).toEqual([
          ['held-qualification.suspended', '2026-10-03'],
          ['held-qualification.reinstated', '2026-10-10'],
          ['held-qualification.revoked', '2026-10-20'],
        ]);
        expect(await historyOf(id)).toEqual([
          ['granted', '2026-01-10', ''],
          ['suspended', '2026-10-03', 'incident'],
          ['reinstated', '2026-10-10', ''],
          ['revoked', '2026-10-20', 'fraud'],
          ['revoked', '2027-01-01', 'scheme closes'],
        ]);
      });

      it('suspends and revokes an employment-scoped authorization during the notice period', async () => {
        const qualificationId = await authorizationFor();
        const profileId = uuid();
        const employmentId = await hire(profileId, '2026-01-01');
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-10',
        });
        const id = held.id as string;
        // The end is recorded ahead: stored `revoked`, in force to the last day.
        await endEmployment(employmentId, '2026-12-31');
        events.length = 0;
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        const ok = { ok: true, heldQualificationId: id, expiresOn: null };
        expect(await on('2026-10-03')).toEqual(ok);

        expect(
          await service.suspend(id, {
            effectiveOn: '2026-10-03',
            reason: 'incident',
          }),
        ).toMatchObject({ status: 'revoked' });
        expect(await on('2026-10-03')).toEqual({
          ok: false,
          reason: 'suspended',
        });
        await service.reinstate(id, { effectiveOn: '2026-10-10' });
        expect(await on('2026-10-10')).toEqual(ok);
        expect(await on('2026-12-31')).toEqual(ok);
        expect(await on('2027-01-01')).toEqual({
          ok: false,
          reason: 'revoked',
        });

        await service.revoke(id, {
          effectiveOn: '2026-11-01',
          reason: 'misconduct',
        });
        expect(await on('2026-10-31')).toEqual(ok);
        expect(await on('2026-11-01')).toEqual({
          ok: false,
          reason: 'revoked',
        });
        expect(await service.holders(qualificationId, '2026-11-01')).toEqual(
          [],
        );
        expect(events.map((event) => [event.type, event.effectiveOn])).toEqual([
          ['held-qualification.suspended', '2026-10-03'],
          ['held-qualification.reinstated', '2026-10-10'],
          ['held-qualification.revoked', '2026-11-01'],
        ]);
        expect(await historyOf(id)).toEqual([
          ['granted', '2026-01-10', ''],
          ['suspended', '2026-10-03', 'incident'],
          ['reinstated', '2026-10-10', ''],
          ['revoked', '2026-11-01', 'misconduct'],
          ['revoked', '2027-01-01', EMPLOYMENT_ENDED_REASON],
        ]);
      });

      it('revokes urgently before a suspension recorded ahead of time, and refuses changes on dates already revoked', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-10',
          expiresOn: '2026-12-15',
        });
        const id = held.id as string;
        expect(
          await service.suspend(id, {
            effectiveOn: '2026-12-01',
            reason: 'booked audit',
          }),
        ).toMatchObject({ status: 'suspended' });
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        const expiring = async (today: string) =>
          (await service.expiringWithin(90, today)).map((row) => row.id);
        expect(await expiring('2026-10-03')).toEqual([id]);

        expect(
          await service.revoke(id, {
            effectiveOn: '2026-10-03',
            reason: 'forged',
          }),
        ).toMatchObject({ status: 'revoked' });
        expect(await on('2026-10-02')).toEqual({
          ok: true,
          heldQualificationId: id,
          expiresOn: '2026-12-15',
        });
        for (const date of ['2026-10-03', '2026-12-01', '2026-12-15'])
          expect(await on(date)).toEqual({ ok: false, reason: 'revoked' });
        expect(await expiring('2026-10-02')).toEqual([id]);
        expect(await expiring('2026-10-03')).toEqual([]);
        expect(await service.holders(qualificationId, '2026-10-03')).toEqual(
          [],
        );
        expect(
          (await service.listForProfile(profileId, '2026-12-01')).map(
            (entry) => entry.status,
          ),
        ).toEqual(['revoked']);

        // Revoked from 10-03: a second revocation on or after it, and a
        // suspension or reinstatement on a revoked date, are refused.
        const transition = code('HR_STATUS_TRANSITION');
        for (const effectiveOn of ['2026-10-03', '2026-11-01'])
          await expect(
            service.revoke(id, { effectiveOn, reason: 'again' }),
          ).rejects.toMatchObject(transition);
        await expect(
          service.suspend(id, { effectiveOn: '2026-12-02', reason: 'late' }),
        ).rejects.toMatchObject(transition);
        await expect(
          service.reinstate(id, { effectiveOn: '2026-12-05' }),
        ).rejects.toMatchObject(transition);
        expect(await historyOf(id)).toEqual([
          ['granted', '2026-01-10', ''],
          ['revoked', '2026-10-03', 'forged'],
          ['suspended', '2026-12-01', 'booked audit'],
        ]);
      });

      it('suspends, reinstates and revokes a lapsed ticket the sweep stored as expired', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const held = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2025-01-01',
          expiresOn: '2025-12-31',
        });
        const id = held.id as string;
        expect(
          (await service.sweepExpired('2026-02-01')).map((row) => row.status),
        ).toEqual(['expired']);
        expect(
          await service.suspend(id, {
            effectiveOn: '2026-03-01',
            reason: 'under review',
          }),
        ).toMatchObject({ status: 'suspended' });
        expect(
          await service.check(profileId, qualificationId, '2026-03-01'),
        ).toEqual({ ok: false, reason: 'suspended' });
        // Lifting the suspension leaves the lapse as the sweep stored it.
        expect(
          await service.reinstate(id, { effectiveOn: '2026-03-05' }),
        ).toMatchObject({ status: 'expired' });
        expect(await service.sweepExpired('2026-04-01')).toEqual([]);
        expect(
          await service.check(profileId, qualificationId, '2026-03-05'),
        ).toEqual({ ok: false, reason: 'expired' });
        expect(
          await service.revoke(id, {
            effectiveOn: '2026-03-10',
            reason: 'forged',
          }),
        ).toMatchObject({ status: 'revoked' });
        expect(
          await service.check(profileId, qualificationId, '2026-03-10'),
        ).toEqual({ ok: false, reason: 'revoked' });
      });

      it('renews a ticket that lapses during the notice period, and the renewal ends with the employment', async () => {
        const pass = await service.define({
          key: 'site-pass',
          name: 'Site pass',
          kind: 'authorization',
          expires: true,
        });
        const qualificationId = pass.id as string;
        const profileId = uuid();
        const employmentId = await hire(profileId, '2026-01-01');
        const lapsing = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
          expiresOn: '2026-11-15',
        });
        await endEmployment(employmentId, '2026-12-31');
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        expect(await on('2026-11-16')).toEqual({
          ok: false,
          reason: 'expired',
        });
        // A fresh grant is not the way out, and the refusal says what is.
        await expect(
          service.grant({
            qualificationId,
            profileId,
            issuedOn: '2026-11-16',
            expiresOn: '2027-11-15',
          }),
        ).rejects.toMatchObject({
          code: 'HR_ALREADY_HELD',
          message: expect.stringContaining('renew the existing one'),
        });
        events.length = 0;
        const renewal = await service.renew(lapsing.id as string, {
          issuedOn: '2026-11-16',
          expiresOn: '2027-11-15',
        });
        expect(renewal).toMatchObject({
          renewalOfId: lapsing.id,
          employmentId,
          status: 'revoked',
        });
        expect(events.map((event) => [event.type, event.effectiveOn])).toEqual([
          ['held-qualification.renewed', '2026-11-16'],
          ['held-qualification.revoked', '2027-01-01'],
        ]);
        expect(await historyOf(renewal.id)).toEqual([
          ['renewed', '2026-11-16', ''],
          ['revoked', '2027-01-01', EMPLOYMENT_ENDED_REASON],
        ]);
        // Past dates answer as before; the gap is closed to the last day.
        expect(await on('2026-06-01')).toEqual({
          ok: true,
          heldQualificationId: lapsing.id,
          expiresOn: '2026-11-15',
        });
        for (const date of ['2026-11-16', '2026-12-31'])
          expect(await on(date)).toEqual({
            ok: true,
            heldQualificationId: renewal.id,
            expiresOn: '2027-11-15',
          });
        expect(await on('2027-01-01')).toEqual({
          ok: false,
          reason: 'revoked',
        });
        expect(
          (await service.holders(qualificationId, '2026-12-31')).map(
            (row) => row.id,
          ),
        ).toEqual([renewal.id]);
        expect(await service.holders(qualificationId, '2027-01-01')).toEqual(
          [],
        );
        expect(
          (await service.listForProfile(profileId, '2027-01-01')).map(
            (entry) => [entry.held.id, entry.status],
          ),
        ).toEqual([[renewal.id, 'revoked']]);
      });

      it('renews a ticket whose revocation is scheduled for later and carries the revocation forward', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const lapsing = await service.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
          expiresOn: '2026-06-30',
        });
        await service.revoke(lapsing.id as string, {
          effectiveOn: '2026-12-01',
          reason: 'scheme closes',
        });
        events.length = 0;
        const renewal = await service.renew(lapsing.id as string, {
          issuedOn: '2026-07-01',
          expiresOn: '2027-06-30',
        });
        expect(renewal.status).toBe('revoked');
        expect(events.map((event) => [event.type, event.effectiveOn])).toEqual([
          ['held-qualification.renewed', '2026-07-01'],
          ['held-qualification.revoked', '2026-12-01'],
        ]);
        expect(await historyOf(renewal.id)).toEqual([
          ['renewed', '2026-07-01', ''],
          ['revoked', '2026-12-01', 'scheme closes'],
        ]);
        const on = (date: string) =>
          service.check(profileId, qualificationId, date);
        expect(await on('2026-06-30')).toMatchObject({
          ok: true,
          heldQualificationId: lapsing.id,
        });
        for (const date of ['2026-07-01', '2026-11-30'])
          expect(await on(date)).toMatchObject({
            ok: true,
            heldQualificationId: renewal.id,
          });
        expect(await on('2026-12-01')).toEqual({
          ok: false,
          reason: 'revoked',
        });
        expect(
          (await service.expiringWithin(400, '2026-11-30')).map(
            (row) => row.id,
          ),
        ).toEqual([renewal.id]);
        expect(await service.expiringWithin(400, '2026-12-01')).toEqual([]);
        // Revoked on or before the renewal date is still final.
        for (const issuedOn of ['2026-12-01', '2027-01-01'])
          await expect(
            service.renew(renewal.id as string, { issuedOn }),
          ).rejects.toMatchObject(code('HR_INVALID'));
      });

      it('decides the employment-end cutoff per renewal chain, not per row', async () => {
        const pass = await service.define({
          key: 'site-pass',
          name: 'Site pass',
          kind: 'authorization',
          expires: true,
        });
        const qualificationId = pass.id as string;
        /** A pass through 2026, renewed in February through January 2027. */
        const chainFor = async () => {
          const profileId = uuid();
          const employmentId = await hire(profileId, '2026-01-01');
          const first = await service.grant({
            qualificationId,
            profileId,
            issuedOn: '2026-01-01',
            expiresOn: '2026-12-31',
          });
          const latest = await service.renew(first.id as string, {
            issuedOn: '2026-02-01',
            expiresOn: '2027-01-31',
          });
          return { profileId, employmentId, first, latest };
        };
        const summary = (delivered: HrEvent[]) =>
          delivered.map((event) => [
            event.type,
            event.effectiveOn,
            'heldQualification' in event ? event.heldQualification.id : null,
          ]);

        // A chain already revoked before the cutoff gets nothing, on any row.
        const withdrawn = await chainFor();
        await service.revoke(withdrawn.latest.id as string, {
          effectiveOn: '2026-03-01',
          reason: 'withdrawn',
        });
        expect(
          summary(await endEmployment(withdrawn.employmentId, '2026-06-30')),
        ).toEqual([['employment.ended', '2026-06-30', null]]);
        expect(await historyOf(withdrawn.first.id)).toEqual([
          ['granted', '2026-01-01', ''],
        ]);
        expect(await historyOf(withdrawn.latest.id)).toEqual([
          ['renewed', '2026-02-01', ''],
          ['revoked', '2026-03-01', 'withdrawn'],
        ]);

        // A chain in force gets one revocation and one event, on its latest
        // row; the row it renewed is cut off through the chain.
        const inForce = await chainFor();
        expect(
          summary(await endEmployment(inForce.employmentId, '2026-06-30')),
        ).toEqual([
          ['held-qualification.revoked', '2026-07-01', inForce.latest.id],
          ['employment.ended', '2026-06-30', null],
        ]);
        expect(await historyOf(inForce.first.id)).toEqual([
          ['granted', '2026-01-01', ''],
        ]);
        expect(await historyOf(inForce.latest.id)).toEqual([
          ['renewed', '2026-02-01', ''],
          ['revoked', '2026-07-01', EMPLOYMENT_ENDED_REASON],
        ]);
        const on = (date: string) =>
          service.check(inForce.profileId, qualificationId, date);
        expect(await on('2026-01-15')).toMatchObject({
          ok: true,
          heldQualificationId: inForce.first.id,
        });
        expect(await on('2026-06-30')).toMatchObject({
          ok: true,
          heldQualificationId: inForce.latest.id,
        });
        // The first row has not expired, yet it does not pass either.
        for (const date of ['2026-07-01', '2026-12-31'])
          expect(await on(date)).toEqual({ ok: false, reason: 'revoked' });
        expect(await service.holders(qualificationId, '2026-07-01')).toEqual(
          [],
        );
        expect(
          (await service.listForProfile(inForce.profileId, '2026-07-01')).map(
            (entry) => [entry.held.id, entry.status],
          ),
        ).toEqual([[inForce.latest.id, 'revoked']]);
      });

      it('refuses a mutation through a beginTransaction handle', async () => {
        if (!db.beginTransaction)
          throw new Error('The test database must support transactions.');
        const tx = await db.beginTransaction();
        const delivered: HrEvent[] = [];
        let refused: unknown;
        try {
          refused = await new QualificationService(tx, actor, {
            onEvent: (event) => void delivered.push(event),
          })
            .define({ key: 'in-handle', name: 'In handle', kind: 'training' })
            .catch((error: unknown) => error);
        } finally {
          await tx.rollback();
        }
        expect(refused).toMatchObject(code('HR_TRANSACTION_UNSUPPORTED'));
        expect(delivered).toEqual([]);
        expect(await service.findByKey('in-handle')).toBeNull();
      });

      it('refuses a mutation through a handle that is already inside a transaction', async () => {
        if (!db.transaction)
          throw new Error('The test database must support transactions.');
        const delivered: HrEvent[] = [];
        let refused: unknown;
        await expect(
          db.transaction(async (tx) => {
            const inside = new QualificationService(tx, actor, {
              onEvent: (event) => void delivered.push(event),
            });
            refused = await inside
              .define({ key: 'in-tx', name: 'In tx', kind: 'training' })
              .catch((error: unknown) => error);
            throw new Error('outer work failed');
          }),
        ).rejects.toThrow('outer work failed');
        expect(refused).toMatchObject(code('HR_TRANSACTION_UNSUPPORTED'));
        expect(delivered).toEqual([]);
        expect(await service.findByKey('in-tx')).toBeNull();
      });
    });

    describe('verifying a document', () => {
      it('records the actor and the time on an existing qualification without changing its status or history', async () => {
        const training = await orientation();
        const held = await service.grant({
          qualificationId: training.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        expect(held.verifiedByProfileId).toBeNull();
        events.length = 0;
        const before = Date.now();
        const documentAssetId = uuid();
        const verified = await service.verify(held.id as string, {
          documentAssetId,
        });
        expect(verified).toMatchObject({
          id: held.id,
          status: 'valid',
          verifiedByProfileId: actor.profileId,
          documentAssetId,
        });
        const at = new Date(verified.verifiedAt as Date).getTime();
        expect(at).toBeGreaterThanOrEqual(before - 1000);
        expect(at).toBeLessThanOrEqual(Date.now() + 1000);
        expect(events).toEqual([]);
        expect(
          (await service.history(held.id as string)).map((c) => c.kind),
        ).toEqual(['granted']);

        // Someone else re-verifies: the document stays unless one is given.
        const second = { tenantId: actor.tenantId, profileId: uuid() };
        const again = await new QualificationService(db, second).verify(
          held.id as string,
        );
        expect(again).toMatchObject({
          verifiedByProfileId: second.profileId,
          documentAssetId,
        });
        const replacement = uuid();
        expect(
          (
            await service.verify(held.id as string, {
              documentAssetId: replacement,
            })
          ).documentAssetId,
        ).toBe(replacement);
        expect(
          (await service.verify(held.id as string, { documentAssetId: null }))
            .documentAssetId,
        ).toBeNull();
      });

      it('verifies a suspended or revoked qualification but never an unknown or foreign one', async () => {
        const training = await orientation();
        const held = await service.grant({
          qualificationId: training.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        const id = held.id as string;
        await service.suspend(id, {
          effectiveOn: '2026-02-01',
          reason: 'review',
        });
        expect(await service.verify(id)).toMatchObject({
          status: 'suspended',
          verifiedByProfileId: actor.profileId,
        });
        const other = new QualificationService(db, {
          tenantId: uuid(),
          profileId: uuid(),
        });
        await expect(other.verify(id)).rejects.toMatchObject(
          code('HR_NOT_FOUND'),
        );
        await expect(service.verify(uuid())).rejects.toMatchObject(
          code('HR_NOT_FOUND'),
        );
        await expect(service.verify(' ')).rejects.toMatchObject(
          code('HR_INVALID'),
        );
        await expect(
          service.verify(id, { documentAssetId: ' ' }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        // Verification is not a status: a row stored `revoked` (which may
        // still be in force until the revocation takes effect) is verified
        // like any other, and nothing else about it changes.
        await service.revoke(id, { effectiveOn: '2026-03-01', reason: 'done' });
        events.length = 0;
        const documentAssetId = uuid();
        const verifier = { tenantId: actor.tenantId, profileId: uuid() };
        expect(
          await new QualificationService(db, verifier).verify(id, {
            documentAssetId,
          }),
        ).toMatchObject({
          status: 'revoked',
          verifiedByProfileId: verifier.profileId,
          documentAssetId,
        });
        expect(events).toEqual([]);
        expect((await service.history(id)).map((c) => c.kind)).toEqual([
          'granted',
          'suspended',
          'revoked',
        ]);
      });

      it('saves only the verification fields of a revoked row, and only under the write capability', async () => {
        const training = await orientation();
        const held = await service.grant({
          qualificationId: training.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
          certificateNumber: 'C-1',
        });
        const id = held.id as string;
        await service.revoke(id, { effectiveOn: '2027-01-01', reason: 'done' });
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const rows = await HeldQualificationCollection.create({ db });
          const load = async () =>
            (await rows.list({ where: { tenantId: actor.tenantId, id } }))[0];
          const immutable = code('HR_HISTORY_IMMUTABLE');
          const renumbered = await load();
          renumbered.certificateNumber = 'C-2';
          renumbered.verifiedAt = new Date();
          await expect(persistHr(renumbered)).rejects.toMatchObject(immutable);
          const restored = await load();
          restored.status = 'valid';
          await expect(persistHr(restored)).rejects.toMatchObject(immutable);
          const extended = await load();
          extended.expiresOn = '2030-01-01';
          await expect(persistHr(extended)).rejects.toMatchObject(immutable);
          const outside = await load();
          outside.verifiedAt = new Date();
          await expect(outside.save()).rejects.toMatchObject(
            code('HR_WRITE_FORBIDDEN'),
          );
          const verified = await load();
          verified.verifiedByProfileId = actor.profileId;
          verified.verifiedAt = new Date();
          verified.documentAssetId = uuid();
          await persistHr(verified);
          expect(await load()).toMatchObject({
            status: 'revoked',
            certificateNumber: 'C-1',
            expiresOn: null,
            verifiedByProfileId: actor.profileId,
            documentAssetId: verified.documentAssetId,
          });
        });
      });
    });

    describe('id inputs', () => {
      it('rejects a blank or missing id with HR_INVALID instead of a database error', async () => {
        const training = await orientation();
        const qualificationId = training.id as string;
        const held = await service.grant({
          qualificationId,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        const missing = undefined as unknown as string;
        const change = { effectiveOn: '2026-02-01', reason: 'x' };
        const attempts: [string, () => Promise<unknown>][] = [
          ['get blank', () => service.get(' ')],
          ['get missing', () => service.get(missing)],
          ['update', () => service.update('', { name: 'X' })],
          [
            'grant without a qualification',
            () =>
              service.grant({
                qualificationId: missing,
                profileId: uuid(),
                issuedOn: '2026-01-01',
              }),
          ],
          [
            'grant without a profile',
            () =>
              service.grant({
                qualificationId,
                profileId: '  ',
                issuedOn: '2026-01-01',
              }),
          ],
          [
            'grant with a blank employment',
            () =>
              service.grant({
                qualificationId,
                profileId: uuid(),
                issuedOn: '2026-01-01',
                employmentId: ' ',
              }),
          ],
          [
            'grant with a blank document',
            () =>
              service.grant({
                qualificationId,
                profileId: uuid(),
                issuedOn: '2026-01-01',
                documentAssetId: '',
              }),
          ],
          [
            'grant without input',
            () => service.grant(undefined as unknown as never),
          ],
          ['renew', () => service.renew(missing, { issuedOn: '2026-02-01' })],
          [
            'renew without input',
            () =>
              service.renew(held.id as string, undefined as unknown as never),
          ],
          ['suspend', () => service.suspend('', change)],
          [
            'suspend without input',
            () =>
              service.suspend(held.id as string, undefined as unknown as never),
          ],
          ['reinstate', () => service.reinstate(missing, change)],
          ['revoke', () => service.revoke(' ', change)],
          ['history', () => service.history(missing)],
          ['holders', () => service.holders('', '2026-02-01')],
          [
            'listForProfile',
            () => service.listForProfile(missing, '2026-02-01'),
          ],
        ];
        for (const [label, attempt] of attempts)
          await expect(attempt(), label).rejects.toMatchObject(
            code('HR_INVALID'),
          );
        expect(await service.findByKey(missing)).toBeNull();
        expect(await service.history(held.id as string)).toHaveLength(1);
      });

      it('answers a check with a blank profile or qualification as not held', async () => {
        const training = await orientation();
        const profileId = uuid();
        await service.grant({
          qualificationId: training.id as string,
          profileId,
          issuedOn: '2026-01-01',
        });
        const notHeld = { ok: false, reason: 'not-held' };
        const missing = undefined as unknown as string;
        expect(
          await service.check(' ', training.id as string, '2026-02-01'),
        ).toEqual(notHeld);
        expect(await service.check(profileId, '', '2026-02-01')).toEqual(
          notHeld,
        );
        expect(await service.check(missing, missing, '2026-02-01')).toEqual(
          notHeld,
        );
        await expect(
          service.check(' ', training.id as string, 'someday'),
        ).rejects.toMatchObject(code('HR_INVALID'));
      });
    });

    describe('finding people and upcoming expiries', () => {
      it('lists one row per person who holds the qualification on the date, optionally only the employed', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const [employed, former, never, lapsed, suspended] = [
          uuid(),
          uuid(),
          uuid(),
          uuid(),
          uuid(),
        ];
        await hire(employed, '2026-01-01');
        const formerEmployment = await hire(former, '2025-01-01');
        await endEmployment(formerEmployment, '2026-03-31');
        const grant = (profileId: string, expiresOn = '2027-01-01') =>
          service.grant({
            qualificationId,
            profileId,
            issuedOn: '2026-01-01',
            expiresOn,
          });
        const first = await grant(employed, '2026-06-30');
        const renewal = await service.renew(first.id as string, {
          issuedOn: '2026-06-01',
          expiresOn: '2027-06-30',
        });
        await grant(former);
        await grant(never);
        await grant(lapsed, '2026-05-31');
        const held = await grant(suspended);
        await service.suspend(held.id as string, {
          effectiveOn: '2026-06-10',
          reason: 'review',
        });

        const all = await service.holders(qualificationId, '2026-06-15');
        expect(all.map((row) => row.profileId).sort()).toEqual(
          [employed, former, never].sort(),
        );
        // One row per person even while the old and the renewed ticket overlap.
        expect(all.find((row) => row.profileId === employed)?.id).toBe(
          renewal.id,
        );
        expect(
          (
            await service.holders(qualificationId, '2026-06-15', {
              employedOnly: true,
            })
          ).map((row) => row.profileId),
        ).toEqual([employed]);
        // The former employee still counted as employed on an earlier date.
        expect(
          (
            await service.holders(qualificationId, '2026-03-31', {
              employedOnly: true,
            })
          )
            .map((row) => row.profileId)
            .sort(),
        ).toEqual([employed, former].sort());
        expect(
          (await service.holders(qualificationId, '2026-05-01'))
            .map((row) => row.profileId)
            .sort(),
        ).toEqual([employed, former, never, lapsed, suspended].sort());
        expect(await service.holders(qualificationId, '2025-12-31')).toEqual(
          [],
        );
      });

      it('lists tickets expiring inside the window, inclusive at both ends, soonest first, without renewed ones', async () => {
        const ticket = await firstAid();
        const training = await orientation();
        const qualificationId = ticket.id as string;
        const grant = (expiresOn: string) =>
          service.grant({
            qualificationId,
            profileId: uuid(),
            issuedOn: '2026-01-01',
            expiresOn,
          });
        await grant('2026-05-31'); // already lapsed
        const today = await grant('2026-06-01');
        const edge = await grant('2026-07-01');
        await grant('2026-07-02'); // one day past the window
        const middle = await grant('2026-06-15');
        const renewedAlready = await grant('2026-06-20');
        await service.renew(renewedAlready.id as string, {
          issuedOn: '2026-05-20',
          expiresOn: '2027-06-20',
        });
        const suspended = await grant('2026-06-10');
        await service.suspend(suspended.id as string, {
          effectiveOn: '2026-05-01',
          reason: 'review',
        });
        await service.grant({
          qualificationId: training.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        expect(
          (await service.expiringWithin(30, '2026-06-01')).map((row) => row.id),
        ).toEqual([today.id, middle.id, edge.id]);
        expect(
          (await service.expiringWithin(0, '2026-06-01')).map((row) => row.id),
        ).toEqual([today.id]);
        await expect(
          service.expiringWithin(-1, '2026-06-01'),
        ).rejects.toMatchObject(code('HR_INVALID'));
      });

      it('lists only the expiring tickets of people employed today when asked', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const [employed, former, starting, never] = [
          uuid(),
          uuid(),
          uuid(),
          uuid(),
        ];
        await hire(employed, '2026-01-01');
        await endEmployment(await hire(former, '2025-01-01'), '2026-05-31');
        await hire(starting, '2026-06-02');
        const grant = (profileId: string, expiresOn: string) =>
          service.grant({
            qualificationId,
            profileId,
            issuedOn: '2026-01-01',
            expiresOn,
          });
        const mine = await grant(employed, '2026-06-10');
        const theirs = await grant(former, '2026-06-05');
        const soon = await grant(starting, '2026-06-20');
        const outside = await grant(never, '2026-06-15');
        expect(
          (await service.expiringWithin(30, '2026-06-01')).map((row) => row.id),
        ).toEqual([theirs.id, mine.id, outside.id, soon.id]);
        expect(
          (
            await service.expiringWithin(30, '2026-06-01', {
              employedOnly: true,
            })
          ).map((row) => row.id),
        ).toEqual([mine.id]);
        // The former employee's last day still counts as employed; the new
        // starter counts from their first day.
        expect(
          (
            await service.expiringWithin(30, '2026-05-31', {
              employedOnly: true,
            })
          ).map((row) => row.id),
        ).toEqual([theirs.id, mine.id]);
        expect(
          (
            await service.expiringWithin(30, '2026-06-02', {
              employedOnly: true,
            })
          ).map((row) => row.id),
        ).toEqual([mine.id, soon.id]);
        expect(
          (
            await service.expiringWithin(30, '2026-06-01', {
              employedOnly: false,
            })
          ).length,
        ).toBe(4);
      });

      it('lists what a person holds with the status worked out for the date', async () => {
        const ticket = await firstAid();
        const training = await orientation();
        const restriction = await service.define({
          key: 'youth-worker',
          name: 'Youth worker',
          kind: 'restriction',
        });
        const profileId = uuid();
        await service.grant({
          qualificationId: ticket.id as string,
          profileId,
          issuedOn: '2026-01-01',
          expiresOn: '2026-06-30',
        });
        const oriented = await service.grant({
          qualificationId: training.id as string,
          profileId,
          issuedOn: '2026-02-01',
        });
        await service.suspend(oriented.id as string, {
          effectiveOn: '2026-08-01',
          reason: 'site rules changed',
        });
        await service.grant({
          qualificationId: restriction.id as string,
          profileId,
          issuedOn: '2026-09-01',
        });
        await service.grant({
          qualificationId: ticket.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        const statuses = async (on: string) =>
          (await service.listForProfile(profileId, on)).map((entry) => [
            entry.qualification.key,
            entry.status,
          ]);
        expect(await statuses('2026-03-01')).toEqual([
          ['first-aid', 'valid'],
          ['site-orientation', 'valid'],
          ['youth-worker', 'not-yet-issued'],
        ]);
        expect(await statuses('2026-09-01')).toEqual([
          ['first-aid', 'expired'],
          ['site-orientation', 'suspended'],
          ['youth-worker', 'valid'],
        ]);
        expect(await service.listForProfile(uuid(), '2026-09-01')).toEqual([]);
      });
    });

    describe('the expiry sweep', () => {
      it('records a lapse during a notice period or a suspension, decided by date and only once', async () => {
        const pass = await service.define({
          key: 'site-pass',
          name: 'Site pass',
          kind: 'authorization',
          expires: true,
        });
        const ticket = await firstAid();
        const worker = uuid();
        const employmentId = await hire(worker, '2026-01-01');
        // In force until its last day, with the employment end recorded ahead.
        const onNotice = await service.grant({
          qualificationId: pass.id as string,
          profileId: worker,
          issuedOn: '2026-01-01',
          expiresOn: '2026-11-15',
        });
        await endEmployment(employmentId, '2026-12-31');
        // Runs out while a suspension is in force.
        const suspended = await service.grant({
          qualificationId: ticket.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
          expiresOn: '2026-10-31',
        });
        await service.suspend(suspended.id as string, {
          effectiveOn: '2026-09-01',
          reason: 'under review',
        });
        // Revoked before its last day: it never lapsed.
        const revokedFirst = await service.grant({
          qualificationId: ticket.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
          expiresOn: '2026-10-31',
        });
        await service.revoke(revokedFirst.id as string, {
          effectiveOn: '2026-06-01',
          reason: 'withdrawn',
        });

        events.length = 0;
        const swept = await service.sweepExpired('2026-11-20');
        expect(swept.map((row) => row.id).sort()).toEqual(
          [onNotice.id, suspended.id].sort(),
        );
        expect(
          events
            .map((event) => [event.type, event.effectiveOn])
            .sort((a, b) => a[1].localeCompare(b[1])),
        ).toEqual([
          ['held-qualification.expired', '2026-11-01'],
          ['held-qualification.expired', '2026-11-16'],
        ]);
        // The stored status is left alone unless it was `valid`.
        expect(
          (await service.listForProfile(worker, '2026-11-20'))[0],
        ).toMatchObject({
          held: { id: onNotice.id, status: 'revoked' },
          status: 'expired',
        });
        expect(await historyOf(onNotice.id)).toContainEqual([
          'expired',
          '2026-11-16',
          '',
        ]);
        expect(await historyOf(revokedFirst.id)).toEqual([
          ['granted', '2026-01-01', ''],
          ['revoked', '2026-06-01', 'withdrawn'],
        ]);

        // `since` bounds a run to rows whose last day is on or after it.
        const older = await service.grant({
          qualificationId: ticket.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
          expiresOn: '2026-03-31',
        });
        expect(
          await service.sweepExpired('2026-11-20', { since: '2026-04-01' }),
        ).toEqual([]);
        expect(
          (
            await service.sweepExpired('2026-11-20', { since: '2026-03-31' })
          ).map((row) => row.id),
        ).toEqual([older.id]);
        await expect(
          service.sweepExpired('2026-11-20', { since: 'last week' }),
        ).rejects.toMatchObject({ code: 'HR_INVALID' });

        // Idempotent, and a later reinstatement of the lapsed row stores `expired`.
        events.length = 0;
        expect(await service.sweepExpired('2026-12-01')).toEqual([]);
        expect(events).toEqual([]);
        const reinstated = await service.reinstate(suspended.id as string, {
          effectiveOn: '2026-12-01',
        });
        expect(reinstated.status).toBe('expired');
        expect(await service.sweepExpired('2026-12-02')).toEqual([]);
      });

      it('stores expired once, dates the change the day after expiry, and only announces tickets nobody renewed', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const grant = (expiresOn: string) =>
          service.grant({
            qualificationId,
            profileId: uuid(),
            issuedOn: '2026-01-01',
            expiresOn,
          });
        const lapsed = await grant('2026-05-31');
        const lastDay = await grant('2026-06-01');
        const renewedAlready = await grant('2026-05-20');
        await service.renew(renewedAlready.id as string, {
          issuedOn: '2026-05-10',
          expiresOn: '2027-05-10',
        });
        events.length = 0;

        const swept = await service.sweepExpired('2026-06-01');
        expect(swept.map((row) => row.id)).toEqual([lapsed.id]);
        expect(swept[0].status).toBe('expired');
        expect(types()).toEqual(['held-qualification.expired']);
        expect(events[0]).toMatchObject({ effectiveOn: '2026-06-01' });
        expect(
          (await service.history(lapsed.id as string)).map((change) => [
            change.kind,
            change.effectiveOn,
          ]),
        ).toEqual([
          ['granted', '2026-01-01'],
          ['expired', '2026-06-01'],
        ]);
        // The renewed ticket is stored as expired too, silently.
        expect(
          (await service.history(renewedAlready.id as string)).map(
            (change) => change.kind,
          ),
        ).toEqual(['granted', 'expired']);

        expect(await service.sweepExpired('2026-06-01')).toEqual([]);
        expect(types()).toEqual(['held-qualification.expired']);
        expect(await service.history(lapsed.id as string)).toHaveLength(2);

        expect(
          (await service.sweepExpired('2026-06-02')).map((row) => row.id),
        ).toEqual([lastDay.id]);
        // An expired ticket can still be revoked, and that is final.
        const revoked = await service.revoke(lapsed.id as string, {
          effectiveOn: '2026-06-05',
          reason: 'audit',
        });
        expect(revoked.status).toBe('revoked');
        expect(
          await service.check(lapsed.profileId, qualificationId, '2026-06-03'),
        ).toEqual({ ok: false, reason: 'expired' });
        expect(
          await service.check(lapsed.profileId, qualificationId, '2026-06-05'),
        ).toEqual({ ok: false, reason: 'revoked' });
      });
    });

    describe('boundaries', () => {
      it('keeps each tenant to its own definitions and held qualifications', async () => {
        const other = new QualificationService(db, {
          tenantId: uuid(),
          profileId: uuid(),
        });
        const ticket = await firstAid();
        const profileId = uuid();
        const held = await service.grant({
          qualificationId: ticket.id as string,
          profileId,
          issuedOn: '2026-01-01',
        });
        const notFound = code('HR_NOT_FOUND');
        expect(await other.list({ includeInactive: true })).toEqual([]);
        expect(await other.findByKey('first-aid')).toBeNull();
        await expect(other.get(ticket.id as string)).rejects.toMatchObject(
          notFound,
        );
        await expect(
          other.update(ticket.id as string, { name: 'Hijacked' }),
        ).rejects.toMatchObject(notFound);
        await expect(
          other.grant({
            qualificationId: ticket.id as string,
            profileId,
            issuedOn: '2026-01-01',
          }),
        ).rejects.toMatchObject(notFound);
        for (const attempt of [
          () => other.renew(held.id as string, { issuedOn: '2026-02-01' }),
          () =>
            other.revoke(held.id as string, {
              effectiveOn: '2026-02-01',
              reason: 'x',
            }),
          () => other.history(held.id as string),
        ])
          await expect(attempt()).rejects.toMatchObject(notFound);
        expect(
          await other.check(profileId, ticket.id as string, '2026-02-01'),
        ).toEqual({ ok: false, reason: 'not-held' });
        expect(await other.holders(ticket.id as string, '2026-02-01')).toEqual(
          [],
        );
        expect(await other.listForProfile(profileId, '2026-02-01')).toEqual([]);
        expect(await other.expiringWithin(4000, '2026-02-01')).toEqual([]);
        expect(await other.sweepExpired('2040-01-01')).toEqual([]);
        expect((await service.get(ticket.id as string)).name).toBe('First aid');
        expect(
          (await service.check(profileId, ticket.id as string, '2030-01-01'))
            .ok,
        ).toBe(false);
        expect(
          (await service.listForProfile(profileId, '2030-01-01'))[0].held
            .status,
        ).toBe('valid');
      });

      it('refuses to run under a different ambient tenant or without an actor', async () => {
        await expect(
          withTenant({ tenantId: uuid() }, () => service.list()),
        ).rejects.toMatchObject(code('HR_TENANT_MISMATCH'));
        expect(
          () =>
            new QualificationService(db, { tenantId: '', profileId: uuid() }),
        ).toThrow(expect.objectContaining(code('HR_ACTOR_INVALID')));
      });

      it('rejects saving or deleting the models outside the service', async () => {
        const ticket = await firstAid();
        const held = await service.grant({
          qualificationId: ticket.id as string,
          profileId: uuid(),
          issuedOn: '2026-01-01',
        });
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const forbidden = code('HR_WRITE_FORBIDDEN');
          const immutable = code('HR_HISTORY_IMMUTABLE');
          const definitions = await QualificationCollection.create({ db });
          const heldRows = await HeldQualificationCollection.create({ db });
          const changes = await HeldQualificationChangeCollection.create({
            db,
          });
          await expect(
            definitions.create({
              tenantId: actor.tenantId,
              key: 'sneaky',
              name: 'Sneaky',
            }),
          ).rejects.toMatchObject(forbidden);
          const [definition] = await definitions.list({
            where: { tenantId: actor.tenantId },
          });
          definition.name = 'Changed';
          await expect(definition.save()).rejects.toMatchObject(forbidden);
          await expect(definition.delete()).rejects.toMatchObject(immutable);
          const [row] = await heldRows.list({
            where: { tenantId: actor.tenantId },
          });
          row.status = 'revoked';
          await expect(row.save()).rejects.toMatchObject(forbidden);
          await expect(row.delete()).rejects.toMatchObject(immutable);
          const [change] = await changes.list({
            where: { tenantId: actor.tenantId },
          });
          await expect(change.save()).rejects.toMatchObject(forbidden);
          await expect(change.delete()).rejects.toMatchObject(immutable);
          // Even with the write capability a definition's key never changes
          // and a change row is never rewritten.
          definition.key = 'renamed';
          await expect(persistHr(definition)).rejects.toMatchObject(immutable);
          await expect(persistHr(change)).rejects.toMatchObject(immutable);
        });
        expect((await service.get(ticket.id as string)).name).toBe('First aid');
        expect(await service.history(held.id as string)).toHaveLength(1);
        expect(
          (await service.listForProfile(held.profileId, '2026-01-01'))[0].held
            .status,
        ).toBe('valid');
      });
    });

    describe('events', () => {
      it('delivers an event only after its change is committed, and none when the change fails', async () => {
        const ticket = await firstAid();
        const qualificationId = ticket.id as string;
        const profileId = uuid();
        const seen: unknown[] = [];
        const observed = new QualificationService(db, actor, {
          onEvent: async (event) => {
            // A handler can already read the committed change.
            seen.push([
              event.type,
              (await service.check(profileId, qualificationId, '2026-01-01'))
                .ok,
            ]);
          },
        });
        await observed.grant({
          qualificationId,
          profileId,
          issuedOn: '2026-01-01',
        });
        expect(seen).toEqual([['held-qualification.granted', true]]);
        await expect(
          observed.grant({
            qualificationId,
            profileId,
            issuedOn: '2026-02-01',
          }),
        ).rejects.toMatchObject(code('HR_ALREADY_HELD'));
        await expect(
          observed.grant({
            qualificationId,
            profileId: uuid(),
            issuedOn: '2026-01-02',
            expiresOn: '2026-01-01',
          }),
        ).rejects.toMatchObject(code('HR_INVALID'));
        expect(seen).toHaveLength(1);
      });

      it('keeps the change when the event handler throws', async () => {
        const failing = new QualificationService(db, actor, {
          onEvent: () => {
            throw new Error('reminder service is down');
          },
        });
        const training = await orientation();
        const profileId = uuid();
        const held = await failing.grant({
          qualificationId: training.id as string,
          profileId,
          issuedOn: '2026-01-01',
        });
        await failing.suspend(held.id as string, {
          effectiveOn: '2026-02-01',
          reason: 'review',
        });
        expect(
          await service.check(profileId, training.id as string, '2026-02-01'),
        ).toEqual({ ok: false, reason: 'suspended' });
        expect(await service.history(held.id as string)).toHaveLength(2);
      });
    });

    it('runs the README example: define, grant, check, renew', async () => {
      const workerProfileId = uuid();
      // --- README snippet start ---
      const qualifications = new QualificationService(db, actor, {
        onEvent: (event) => void events.push(event), // after commit; a throwing handler never rolls back
      });
      const firstAidTicket = await qualifications.define({
        key: 'first-aid',
        name: 'First aid',
        kind: 'certification',
        expires: true,
        validityMonths: 36,
      });
      const held = await qualifications.grant({
        qualificationId: firstAidTicket.id as string,
        profileId: workerProfileId,
        issuedOn: '2026-03-01', // expiresOn defaults to 2029-03-01
        certificateNumber: 'FA-20931',
        verified: true,
      });
      const gate = await qualifications.check(
        workerProfileId,
        firstAidTicket.id as string,
        '2029-03-02',
      ); // { ok: false, reason: 'expired' }
      const renewal = await qualifications.renew(held.id as string, {
        issuedOn: '2029-02-15',
      }); // a new row; `held` still answers for 2026-03-01..2029-03-01
      const after = await qualifications.check(
        workerProfileId,
        firstAidTicket.id as string,
        '2029-03-02',
      ); // { ok: true, heldQualificationId: renewal.id, expiresOn: '2032-02-15' }
      // --- README snippet end ---
      expect(held.expiresOn).toBe('2029-03-01');
      expect(gate).toEqual({ ok: false, reason: 'expired' });
      expect(after).toEqual({
        ok: true,
        heldQualificationId: renewal.id,
        expiresOn: '2032-02-15',
      });
      expect(types()).toEqual([
        'held-qualification.granted',
        'held-qualification.renewed',
      ]);
    });
  });
}
