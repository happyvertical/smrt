/**
 * SupportRoutingService tests (#1929): explainable ranked routing — the
 * project-qualification hard filter with effective dating, workload caps,
 * availability in the specialist's own timezone (weekly windows, on-call
 * spans, time-off exclusions), preference and language scoring, deterministic
 * ordering, auto-assignment rationale, and the permission-gated manual
 * reassignment override with its cross-tenant guard.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupportCase } from '../models/support-case.js';
import type {
  SupportAvailability,
  SupportAvailabilityCollection,
  SupportQualificationCollection,
  SupportSpecialist,
  SupportSpecialistCollection,
} from '../models/support-specialist.js';
import {
  REASSIGN_CASE_PERMISSION,
  supportPrincipalFromPermissions,
} from '../permissions.js';
import { SupportCaseService } from './support-case-service.js';
import {
  ReassignDeniedError,
  SupportRoutingService,
} from './support-routing-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
  'SupportSpecialist',
  'SupportQualification',
  'SupportAvailability',
];

// Monday 2026-01-05 14:00 UTC — 09:00 in America/New_York.
const AT = new Date('2026-01-05T14:00:00Z');

describe('SupportRoutingService', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let service: SupportCaseService;
  let routing: SupportRoutingService;
  let specialists: SupportSpecialistCollection;
  let qualifications: SupportQualificationCollection;
  let availabilities: SupportAvailabilityCollection;
  let specialistSeq = 0;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    service = await SupportCaseService.create({ db: ctx.db });
    routing = await SupportRoutingService.create({
      db: ctx.db,
      caseService: service,
    });
    specialists = routing.specialists;
    qualifications = routing.qualifications;
    availabilities = routing.availabilities;
    specialistSeq = 0;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function makeSpecialist(
    overrides: Partial<Record<string, unknown>> = {},
  ): Promise<SupportSpecialist> {
    specialistSeq += 1;
    return specialists.create({
      profileId: `profile-${specialistSeq}`,
      displayName: `Specialist ${specialistSeq}`,
      status: 'active',
      timezone: 'UTC',
      maxConcurrentCases: 5,
      languages: '["en"]',
      ...overrides,
    });
  }

  async function allDayWeekly(
    specialist: SupportSpecialist,
  ): Promise<SupportAvailability> {
    return availabilities.create({
      specialistId: specialist.id,
      kind: 'weekly',
      weekday: 1, // AT is a Monday
      startMinute: 0,
      endMinute: 1440,
    });
  }

  async function openCase(
    input: Record<string, unknown> = {},
  ): Promise<SupportCase> {
    return service.openCase({ subject: 'Broken widget', ...input });
  }

  function entryFor(
    ranking: Awaited<ReturnType<SupportRoutingService['rankSpecialists']>>,
    specialist: SupportSpecialist,
  ) {
    const entry = ranking.find(
      (candidate) => candidate.specialistId === specialist.id,
    );
    if (!entry) throw new Error(`specialist missing from ranking`);
    return entry;
  }

  describe('rankSpecialists', () => {
    it('hard-filters specialists from another tenant with the factor visible', async () => {
      const foreign = await makeSpecialist({ tenantId: 'tenant-x' });
      const local = await makeSpecialist({ tenantId: 'tenant-b' });
      await allDayWeekly(foreign);
      await allDayWeekly(local);
      const supportCase = await openCase({ tenantId: 'tenant-b' });

      const ranked = await routing.rankSpecialists(supportCase, { at: AT });
      const foreignRank = ranked.find(
        (item) => item.specialistId === foreign.id,
      );
      const localRank = ranked.find((item) => item.specialistId === local.id);
      expect(foreignRank?.eligible).toBe(false);
      expect(foreignRank?.factors.tenantMismatch).toBe(true);
      expect(localRank?.eligible).toBe(true);
    });

    it('hard-filters on an effective project qualification, keeping the failing factor visible', async () => {
      const qualified = await makeSpecialist();
      const unqualified = await makeSpecialist();
      const expired = await makeSpecialist();
      for (const specialist of [qualified, unqualified, expired]) {
        await allDayWeekly(specialist);
      }
      await qualifications.create({
        specialistId: qualified.id,
        projectId: 'proj-1',
        level: 'qualified',
      });
      await qualifications.create({
        specialistId: expired.id,
        projectId: 'proj-1',
        level: 'expert',
        effectiveTo: new Date('2025-12-31T00:00:00Z'),
      });

      const supportCase = await openCase({ projectId: 'proj-1' });
      const ranking = await routing.rankSpecialists(supportCase, { at: AT });

      const winner = entryFor(ranking, qualified);
      expect(winner.eligible).toBe(true);
      expect(winner.factors.projectQualification).toBe('qualified');

      const missing = entryFor(ranking, unqualified);
      expect(missing.eligible).toBe(false);
      expect(missing.factors.projectQualification).toBe('none');

      const lapsed = entryFor(ranking, expired);
      expect(lapsed.eligible).toBe(false);
      expect(lapsed.factors.projectQualification).toBe('expired');
    });

    it('excludes specialists at their workload cap, with the open-case factor', async () => {
      const busy = await makeSpecialist({ maxConcurrentCases: 1 });
      const free = await makeSpecialist();
      await allDayWeekly(busy);
      await allDayWeekly(free);
      const otherCase = await openCase();
      await service.assign(otherCase, {
        actorKind: 'system',
        specialistId: busy.id ?? '',
      });

      const ranking = await routing.rankSpecialists(await openCase(), {
        at: AT,
      });

      const overloaded = entryFor(ranking, busy);
      expect(overloaded.eligible).toBe(false);
      expect(overloaded.factors.workloadExceeded).toBe(true);
      expect(overloaded.factors.openCases).toBe(1);
      expect(entryFor(ranking, free).eligible).toBe(true);
    });

    it('evaluates weekly windows in the specialist timezone', async () => {
      const newYorker = await makeSpecialist({ timezone: 'America/New_York' });
      await availabilities.create({
        specialistId: newYorker.id,
        kind: 'weekly',
        weekday: 1,
        startMinute: 9 * 60,
        endMinute: 17 * 60,
      });
      const supportCase = await openCase();

      // 14:00 UTC = 09:00 New York — inside the window.
      const inside = await routing.rankSpecialists(supportCase, { at: AT });
      expect(entryFor(inside, newYorker).eligible).toBe(true);
      expect(entryFor(inside, newYorker).factors.weeklyAvailable).toBe(true);

      // 13:00 UTC = 08:00 New York — before the window opens.
      const outside = await routing.rankSpecialists(supportCase, {
        at: new Date('2026-01-05T13:00:00Z'),
      });
      expect(entryFor(outside, newYorker).eligible).toBe(false);
      expect(entryFor(outside, newYorker).factors.weeklyAvailable).toBe(false);
    });

    it('includes active on-call spans and excludes time-off spans', async () => {
      const onCall = await makeSpecialist();
      await availabilities.create({
        specialistId: onCall.id,
        kind: 'on_call',
        startsAt: new Date('2026-01-05T00:00:00Z'),
        endsAt: new Date('2026-01-06T00:00:00Z'),
      });
      const away = await makeSpecialist();
      await allDayWeekly(away);
      await availabilities.create({
        specialistId: away.id,
        kind: 'time_off',
        startsAt: new Date('2026-01-04T00:00:00Z'),
        endsAt: new Date('2026-01-07T00:00:00Z'),
      });

      const ranking = await routing.rankSpecialists(await openCase(), {
        at: AT,
      });

      const reachable = entryFor(ranking, onCall);
      expect(reachable.eligible).toBe(true);
      expect(reachable.factors.onCall).toBe(true);

      const excluded = entryFor(ranking, away);
      expect(excluded.eligible).toBe(false);
      expect(excluded.factors.timeOff).toBe(true);
    });

    it('marks inactive specialists ineligible with the status factor', async () => {
      const inactive = await makeSpecialist({ status: 'inactive' });
      await allDayWeekly(inactive);

      const ranking = await routing.rankSpecialists(await openCase(), {
        at: AT,
      });
      const entry = entryFor(ranking, inactive);
      expect(entry.eligible).toBe(false);
      expect(entry.factors.status).toBe('inactive');
    });

    it('ranks the preferred specialist above a better-qualified alternative', async () => {
      const preferred = await makeSpecialist();
      const expert = await makeSpecialist();
      await allDayWeekly(preferred);
      await allDayWeekly(expert);
      await qualifications.create({
        specialistId: preferred.id,
        projectId: 'proj-1',
        level: 'trainee',
      });
      await qualifications.create({
        specialistId: expert.id,
        projectId: 'proj-1',
        level: 'expert',
      });

      const supportCase = await openCase({
        projectId: 'proj-1',
        preferredSpecialistId: preferred.id,
      });
      const ranking = await routing.rankSpecialists(supportCase, { at: AT });

      expect(ranking[0]?.specialistId).toBe(preferred.id);
      expect(ranking[0]?.factors.preferred).toBe(true);
      expect(ranking[0]?.score).toBeGreaterThan(
        entryFor(ranking, expert).score,
      );
    });

    it('applies the language bonus from case metadata', async () => {
      const francophone = await makeSpecialist({
        languages: '["en","fr"]',
      });
      const anglophone = await makeSpecialist();
      await allDayWeekly(francophone);
      await allDayWeekly(anglophone);

      const supportCase = await openCase({ metadata: { language: 'fr' } });
      const ranking = await routing.rankSpecialists(supportCase, { at: AT });

      const bonus = entryFor(ranking, francophone);
      expect(bonus.factors.languageMatch).toBe(true);
      expect(bonus.score).toBe(entryFor(ranking, anglophone).score + 10);
      expect(ranking[0]?.specialistId).toBe(francophone.id);
    });

    it('orders deterministically: score, then display name', async () => {
      const bravo = await makeSpecialist({ displayName: 'Bravo' });
      const alpha = await makeSpecialist({ displayName: 'Alpha' });
      await allDayWeekly(bravo);
      await allDayWeekly(alpha);

      const ranking = await routing.rankSpecialists(await openCase(), {
        at: AT,
      });
      expect(ranking.map((entry) => entry.displayName)).toEqual([
        'Alpha',
        'Bravo',
      ]);
    });
  });

  describe('autoAssign', () => {
    it('assigns the top eligible specialist with an explainable rationale', async () => {
      const winner = await makeSpecialist({ onCallPriority: 2 });
      const runnerUp = await makeSpecialist();
      await allDayWeekly(winner);
      await allDayWeekly(runnerUp);

      const supportCase = await openCase();
      const result = await routing.autoAssign(supportCase, { at: AT });

      expect(result.assigned).toBe(true);
      expect(result.specialistId).toBe(winner.id);

      const reloaded = await service.getCase(supportCase.id ?? '');
      expect(reloaded.assignedSpecialistId).toBe(winner.id);
      expect(reloaded.status).toBe('assigned');

      const events = await service.events.forCase(supportCase.id ?? '', {
        eventType: 'assignment',
      });
      expect(events).toHaveLength(1);
      const payload = events[0]?.getPayload() as {
        specialistId?: string;
        rationale?: {
          factors?: Record<string, unknown>;
          ranking?: Array<{ specialistId: string }>;
        };
      };
      expect(payload.specialistId).toBe(winner.id);
      expect(payload.rationale?.factors?.weeklyAvailable).toBe(true);
      expect(payload.rationale?.ranking?.length).toBeLessThanOrEqual(3);
      expect(payload.rationale?.ranking?.[0]?.specialistId).toBe(winner.id);
    });

    it('records an unrouted note and returns assigned:false when nobody is eligible', async () => {
      const unavailable = await makeSpecialist(); // no availability windows

      const supportCase = await openCase();
      const result = await routing.autoAssign(supportCase, { at: AT });

      expect(result.assigned).toBe(false);
      expect(result.specialistId).toBeUndefined();
      expect(
        result.ranking.some((e) => e.specialistId === unavailable.id),
      ).toBe(true);

      const reloaded = await service.getCase(supportCase.id ?? '');
      expect(reloaded.assignedSpecialistId).toBeNull();

      const notes = await service.events.forCase(supportCase.id ?? '', {
        eventType: 'note',
      });
      expect(notes).toHaveLength(1);
      const payload = notes[0]?.getPayload() as {
        unrouted?: boolean;
        ranking?: unknown[];
      };
      expect(payload.unrouted).toBe(true);
      expect(Array.isArray(payload.ranking)).toBe(true);
    });
  });

  describe('reassign', () => {
    it('denies principals without the reassign permission', async () => {
      const specialist = await makeSpecialist();
      const supportCase = await openCase();
      await expect(
        routing.reassign(supportCase, {
          specialistId: specialist.id ?? '',
          principal: supportPrincipalFromPermissions([]),
        }),
      ).rejects.toThrow(ReassignDeniedError);
    });

    it('denies cross-tenant reassignment even with the permission', async () => {
      const specialist = await makeSpecialist();
      const supportCase = await openCase({ tenantId: 'tenant-b' });
      await expect(
        routing.reassign(supportCase, {
          specialistId: specialist.id ?? '',
          principal: supportPrincipalFromPermissions(
            [REASSIGN_CASE_PERMISSION],
            { id: 'profile-lead', tenantId: 'tenant-a' },
          ),
        }),
      ).rejects.toThrow(/tenant/);
    });

    it('refuses a specialist from another tenant and unknown specialist ids', async () => {
      const foreign = await makeSpecialist({ tenantId: 'tenant-x' });
      const supportCase = await openCase({ tenantId: 'tenant-b' });
      const principal = supportPrincipalFromPermissions(
        [REASSIGN_CASE_PERMISSION],
        { id: 'profile-lead', tenantId: 'tenant-b' },
      );

      // An authorized in-tenant caller must not be able to assign (and
      // audit) a foreign tenant's specialist (codex review, PR #1943).
      await expect(
        routing.reassign(supportCase, {
          specialistId: foreign.id ?? '',
          principal,
        }),
      ).rejects.toThrow(/specialist tenant does not match/);

      await expect(
        routing.reassign(supportCase, {
          specialistId: 'no-such-specialist',
          principal,
        }),
      ).rejects.toThrow(/unknown specialist/);
    });

    it('reassigns with a manual rationale when authorized', async () => {
      const specialist = await makeSpecialist();
      const supportCase = await openCase();

      const updated = await routing.reassign(supportCase, {
        specialistId: specialist.id ?? '',
        principal: supportPrincipalFromPermissions([REASSIGN_CASE_PERMISSION], {
          id: 'profile-lead',
        }),
        note: 'Client asked for their usual contact.',
      });

      expect(updated.assignedSpecialistId).toBe(specialist.id);
      const events = await service.events.forCase(supportCase.id ?? '', {
        eventType: 'assignment',
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.actorKind).toBe('specialist');
      expect(events[0]?.actorProfileId).toBe('profile-lead');
      const payload = events[0]?.getPayload() as {
        rationale?: { manual?: boolean; note?: string };
      };
      expect(payload.rationale?.manual).toBe(true);
      expect(payload.rationale?.note).toBe(
        'Client asked for their usual contact.',
      );
    });
  });
});
