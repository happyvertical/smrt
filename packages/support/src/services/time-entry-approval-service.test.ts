/**
 * TimeEntryApprovalService tests — the heart of issue #1930's acceptance
 * criteria: the four approval paths gated by `support.approve-time-entry`,
 * charge derivation from the Managed Support Plan (included time first, then
 * metered overage) vs compensation derivation from the effective-dated
 * Support Compensation Plan, immutable approved snapshots, explicit
 * corrections, plan-edit isolation via the case's `planSnapshot`, and the
 * tenant guard.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceTimeEntry } from '../models/service-time-entry.js';
import type { SupportCase } from '../models/support-case.js';
import type { SupportPlan } from '../models/support-plan.js';
import {
  APPROVE_TIME_ENTRY_PERMISSION,
  supportPrincipalFromPermissions,
} from '../permissions.js';
import type { TimeApprovalPolicy } from '../types.js';
import { ServiceTimeEntryService } from './service-time-entry-service.js';
import { SupportCaseService } from './support-case-service.js';
import {
  TimeEntryApprovalDeniedError,
  TimeEntryApprovalService,
} from './time-entry-approval-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
  'SupportSpecialist',
  'SupportCompensationPlan',
  'ServiceTimeEntry',
  'SupportCharge',
  'SupportCompensation',
];

const APPROVE_AT = new Date('2026-07-01T12:00:00.000Z');
const WORK_ENDED_AT = new Date('2026-07-01T11:00:00.000Z');

const operator = (extra: { id?: string; tenantId?: string } = {}) =>
  supportPrincipalFromPermissions([APPROVE_TIME_ENTRY_PERMISSION], {
    id: 'operator-1',
    ...extra,
  });

describe('TimeEntryApprovalService', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let caseService: SupportCaseService;
  let entryService: ServiceTimeEntryService;
  let approvalService: TimeEntryApprovalService;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    caseService = await SupportCaseService.create({ db: ctx.db });
    entryService = await ServiceTimeEntryService.create({
      db: ctx.db,
      caseService,
    });
    approvalService = await TimeEntryApprovalService.create({
      db: ctx.db,
      caseService,
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function planWith(
    policy: TimeApprovalPolicy,
    fields: Record<string, unknown> = {},
  ): Promise<SupportPlan> {
    return caseService.plans.create({
      planKey: 'managed',
      name: 'Managed',
      timeApprovalPolicy: JSON.stringify(policy),
      ...fields,
    });
  }

  async function caseUnder(
    plan: SupportPlan | null,
    fields: Record<string, unknown> = {},
  ): Promise<SupportCase> {
    return caseService.openCase({
      subject: 'time-approval case',
      planId: plan?.id ?? null,
      ...fields,
    });
  }

  async function submittedEntry(
    caseId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<ServiceTimeEntry> {
    const entry = await entryService.record({
      caseId,
      participantKind: 'human',
      participantProfileId: 'profile-worker-1',
      source: 'manual',
      description: 'debugging',
      durationSeconds: 3600,
      endedAt: WORK_ENDED_AT,
      ...overrides,
    });
    return entryService.submit(entry, { byProfileId: 'profile-worker-1' });
  }

  describe('approval paths (FR-36)', () => {
    it('approves under-threshold entries automatically, with no principal', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { overageHourlyRate: 100.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '', {
        durationSeconds: 1800,
      });

      const result = await approvalService.approve(entry, { at: APPROVE_AT });

      expect(result.path).toBe('automatic');
      expect(result.entry.status).toBe('approved');
      expect(result.entry.approvedAt).toEqual(APPROVE_AT);
      expect(result.entry.approvedByProfileId).toBeNull();
      expect(result.entry.approvalPath).toBe('automatic');
    });

    it('escalates over-threshold automatic entries to an operator', async () => {
      const plan = await planWith(
        { mode: 'automatic', thresholdMinutes: 60 },
        { overageHourlyRate: 100.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '', {
        durationSeconds: 7200,
      });

      await expect(
        approvalService.approve(entry.id ?? '', { at: APPROVE_AT }),
      ).rejects.toThrow(TimeEntryApprovalDeniedError);

      const result = await approvalService.approve(entry.id ?? '', {
        principal: operator(),
        at: APPROVE_AT,
      });
      expect(result.path).toBe('threshold');
      expect(result.entry.approvedByProfileId).toBe('operator-1');
    });

    it('gates the operator path on the approve-time-entry split', async () => {
      const plan = await planWith({ mode: 'operator' });
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '');

      await expect(
        approvalService.approve(entry.id ?? '', { at: APPROVE_AT }),
      ).rejects.toThrow(TimeEntryApprovalDeniedError);
      await expect(
        approvalService.approve(entry.id ?? '', {
          principal: supportPrincipalFromPermissions([], { id: 'nobody' }),
          at: APPROVE_AT,
        }),
      ).rejects.toThrow(/operator approval requires/);

      const result = await approvalService.approve(entry.id ?? '', {
        principal: operator(),
        at: APPROVE_AT,
      });
      expect(result.path).toBe('operator');
    });

    it('lets the case client approve under client mode, with the operator split as override', async () => {
      const plan = await planWith({ mode: 'client' });
      const supportCase = await caseUnder(plan, {
        clientProfileId: 'client-1',
      });

      const first = await submittedEntry(supportCase.id ?? '');
      const asClient = await approvalService.approve(first.id ?? '', {
        principal: supportPrincipalFromPermissions([], { id: 'client-1' }),
        at: APPROVE_AT,
      });
      expect(asClient.path).toBe('client');

      const second = await submittedEntry(supportCase.id ?? '');
      await expect(
        approvalService.approve(second.id ?? '', {
          principal: supportPrincipalFromPermissions([], { id: 'stranger' }),
          at: APPROVE_AT,
        }),
      ).rejects.toThrow(TimeEntryApprovalDeniedError);

      const asOperator = await approvalService.approve(second.id ?? '', {
        principal: operator(),
        at: APPROVE_AT,
      });
      expect(asOperator.path).toBe('client');
    });
  });

  describe('charge derivation (Managed Support Plan side)', () => {
    it('consumes included time first, then meters the overage per case', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { includedMinutes: 60, overageHourlyRate: 120.0 },
      );
      const supportCase = await caseUnder(plan);

      // 90 minutes: 60 included + 30 metered → 0.5h × 120 = 60.00
      const first = await submittedEntry(supportCase.id ?? '', {
        durationSeconds: 5400,
      });
      const firstResult = await approvalService.approve(first.id ?? '', {
        at: APPROVE_AT,
      });
      expect(firstResult.charge.amount).toBeCloseTo(60.0, 2);
      expect(firstResult.charge.includedSecondsApplied).toBe(3600);
      expect(firstResult.charge.billableSeconds).toBe(5400);
      expect(firstResult.charge.status).toBe('final');
      expect(firstResult.charge.finalizedAt).toEqual(APPROVE_AT);
      expect(firstResult.charge.getRateSnapshot()).toMatchObject({
        hourlyRate: 120,
        rateSource: 'overage',
        planKey: 'managed',
        includedMinutes: 60,
        includedSecondsBefore: 3600,
        includedSecondsApplied: 3600,
        derivedAt: APPROVE_AT.toISOString(),
      });

      // Second 60-minute entry on the SAME case: nothing left included.
      const second = await submittedEntry(supportCase.id ?? '', {
        durationSeconds: 3600,
      });
      const secondResult = await approvalService.approve(second.id ?? '', {
        at: APPROVE_AT,
      });
      expect(secondResult.charge.amount).toBeCloseTo(120.0, 2);
      expect(secondResult.charge.includedSecondsApplied).toBe(0);
      expect(secondResult.charge.getRateSnapshot()).toMatchObject({
        includedSecondsBefore: 0,
        includedSecondsApplied: 0,
      });
    });

    it('prices a zero-rate plan at 0 with rateSource none', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { includedMinutes: 0, overageHourlyRate: 0.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '');

      const { charge } = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      expect(charge.amount).toBe(0);
      expect(charge.getRateSnapshot()).toMatchObject({ rateSource: 'none' });
    });

    it('uses the on-call rate for entries flagged onCall', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { overageHourlyRate: 120.0, onCallHourlyRate: 200.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '', {
        metadata: { onCall: true },
      });

      const { charge } = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      expect(charge.amount).toBeCloseTo(200.0, 2);
      expect(charge.getRateSnapshot()).toMatchObject({
        hourlyRate: 200,
        rateSource: 'on_call',
      });
    });
  });

  describe('compensation derivation (Support Compensation Plan side)', () => {
    it('prefers the specialist-specific plan over the tenant default', async () => {
      await approvalService.compensationPlans.create({
        specialistId: 'spec-1',
        name: 'Specific',
        hourlyRate: 45.0,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      await approvalService.compensationPlans.create({
        specialistId: null,
        name: 'Default',
        hourlyRate: 30.0,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      });

      const plan = await planWith(
        { mode: 'automatic' },
        { overageHourlyRate: 120.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '', {
        specialistId: 'spec-1',
        durationSeconds: 7200,
      });

      const { charge, compensation } = await approvalService.approve(
        entry.id ?? '',
        { at: APPROVE_AT },
      );
      expect(compensation.amount).toBeCloseTo(90.0, 2);
      expect(compensation.payableSeconds).toBe(7200);
      expect(compensation.status).toBe('final');
      expect(compensation.getRateSnapshot()).toMatchObject({
        hourlyRate: 45,
        derivedAt: APPROVE_AT.toISOString(),
      });

      // Margin stays computable by readers and is NEVER stored — the two
      // sides live in separate tables with no margin column anywhere.
      expect(charge.amount - compensation.amount).toBeCloseTo(150.0, 2);
      expect(charge.tableName).toBe('support_charges');
      expect(compensation.tableName).toBe('support_compensations');
      expect(charge.tableName).not.toBe(compensation.tableName);
      expect(Object.keys(charge.toJSON())).not.toContain('margin');
      expect(Object.keys(compensation.toJSON())).not.toContain('margin');
      expect(charge.getRateSnapshot()).not.toHaveProperty('margin');
      expect(compensation.getRateSnapshot()).not.toHaveProperty('margin');
    });

    it("never prices work with another tenant's default plan", async () => {
      // A foreign tenant's default plan exists and is newer/richer.
      await approvalService.compensationPlans.create({
        tenantId: 'tenant-other',
        specialistId: null,
        name: 'Foreign default',
        hourlyRate: 500.0,
        effectiveFrom: new Date('2026-01-02T00:00:00.000Z'),
      });
      await approvalService.compensationPlans.create({
        tenantId: 'tenant-1',
        specialistId: null,
        name: 'Own default',
        hourlyRate: 30.0,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      });

      const plan = await planWith(
        { mode: 'automatic' },
        { overageHourlyRate: 120.0 },
      );
      const supportCase = await caseUnder(plan, { tenantId: 'tenant-1' });
      const entry = await submittedEntry(supportCase.id ?? '', {
        specialistId: 'spec-1',
        durationSeconds: 3600,
      });

      const { compensation } = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      // Resolution is scoped to the entry's tenant (codex review, PR
      // #1943): the foreign default never applies.
      expect(compensation.amount).toBeCloseTo(30.0, 2);
      expect(compensation.getRateSnapshot()).toMatchObject({ hourlyRate: 30 });
    });

    it('falls back to the tenant default when the specific plan has expired', async () => {
      await approvalService.compensationPlans.create({
        specialistId: 'spec-1',
        name: 'Expired specific',
        hourlyRate: 45.0,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
      });
      await approvalService.compensationPlans.create({
        specialistId: null,
        name: 'Default',
        hourlyRate: 30.0,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      });

      const plan = await planWith({ mode: 'automatic' });
      const supportCase = await caseUnder(plan);
      // Work instant (endedAt 2026-07-01) is past the specific plan's window.
      const entry = await submittedEntry(supportCase.id ?? '', {
        specialistId: 'spec-1',
        durationSeconds: 7200,
      });

      const { compensation } = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      expect(compensation.amount).toBeCloseTo(60.0, 2);
      expect(compensation.getRateSnapshot()).toMatchObject({ hourlyRate: 30 });
    });

    it('settles a zero compensation when no specialist delivered the work', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { overageHourlyRate: 120.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '');

      const { compensation } = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      expect(compensation.amount).toBe(0);
      expect(compensation.compensationPlanId).toBeNull();
      expect(compensation.getRateSnapshot()).toMatchObject({
        rateSource: 'none',
      });
    });
  });

  describe('immutability of approved entries', () => {
    it('freezes the work-defining fields and refuses a second approval', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { overageHourlyRate: 100.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '');
      await approvalService.approve(entry.id ?? '', { at: APPROVE_AT });

      const approved = await approvalService.getEntry(entry.id ?? '');
      approved.durationSeconds = 999_999;
      await expect(approved.save()).rejects.toThrow(/immutable/);

      const evidenceTamper = await approvalService.getEntry(entry.id ?? '');
      evidenceTamper.setEvidence([{ kind: 'note', ref: 'fabricated' }]);
      await expect(evidenceTamper.save()).rejects.toThrow(/immutable/);

      await expect(
        approvalService.approve(entry.id ?? '', {
          principal: operator(),
          at: APPROVE_AT,
        }),
      ).rejects.toThrow(/only 'submitted' entries can be approved/);
    });
  });

  describe('approval retryability (partial-failure recovery)', () => {
    it('re-approving after a partial settlement write refreshes the same rows without double-counting', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { includedMinutes: 60, overageHourlyRate: 120.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '', {
        durationSeconds: 5400, // 60 included + 30 metered
      });

      // Simulate the failure mode codex flagged (P1, PR #1943): a prior
      // approval attempt wrote the settlement rows but died before the
      // entry flipped to 'approved' — the entry is still 'submitted' with a
      // stale charge row present.
      await approvalService.charges.create({
        tenantId: entry.tenantId,
        timeEntryId: entry.id ?? '',
        caseId: entry.caseId,
        planId: plan.id,
        amount: 999,
        currency: 'USD',
        billableSeconds: 5400,
        includedSecondsApplied: 3600,
        rateSnapshot: JSON.stringify({ stale: true }),
        status: 'final',
        finalizedAt: APPROVE_AT,
      });

      const result = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      expect(result.entry.status).toBe('approved');
      // The retry refreshed the SAME row: correct amount, no self
      // double-count of the included allowance, and still exactly one
      // charge + one compensation for the entry.
      expect(result.charge.amount).toBeCloseTo(60.0, 2);
      expect(result.charge.includedSecondsApplied).toBe(3600);
      expect(result.charge.getRateSnapshot()).toMatchObject({
        includedSecondsBefore: 3600,
      });
      const charges = await approvalService.charges.forCase(
        supportCase.id ?? '',
      );
      expect(charges).toHaveLength(1);
      const compensation = await approvalService.compensations.forTimeEntry(
        entry.id ?? '',
      );
      expect(compensation).not.toBeNull();
    });
  });

  describe('corrections', () => {
    it('releases the corrected charge’s included time back to the case', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { includedMinutes: 60, overageHourlyRate: 120.0 },
      );
      const supportCase = await caseUnder(plan);

      // A 60-minute entry consumes the whole included allowance.
      const entry = await submittedEntry(supportCase.id ?? '', {
        durationSeconds: 3600,
      });
      const approved = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      expect(approved.charge.amount).toBeCloseTo(0, 2);
      expect(approved.charge.includedSecondsApplied).toBe(3600);

      // Correcting it down to 30 minutes releases the allowance — the
      // replacement must consume included time again, not bill overage
      // (codex P1, PR #1943).
      const { correction } = await approvalService.correct(entry.id ?? '', {
        principal: operator(),
        patch: { durationSeconds: 1800 },
        note: 'over-recorded',
      });
      await entryService.submit(correction, {
        byProfileId: 'profile-worker-1',
      });
      const reApproved = await approvalService.approve(correction.id ?? '', {
        at: APPROVE_AT,
      });
      expect(reApproved.charge.includedSecondsApplied).toBe(1800);
      expect(reApproved.charge.amount).toBeCloseTo(0, 2);
      expect(reApproved.charge.getRateSnapshot()).toMatchObject({
        includedSecondsBefore: 3600,
      });
    });

    it('supersedes the original and re-derives fresh snapshots from the patch', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { includedMinutes: 0, overageHourlyRate: 100.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '', {
        durationSeconds: 3600,
      });
      const approvedResult = await approvalService.approve(entry.id ?? '', {
        at: APPROVE_AT,
      });
      expect(approvedResult.charge.amount).toBeCloseTo(100.0, 2);
      const originalChargeSnapshot = approvedResult.charge.getRateSnapshot();

      const { original, correction } = await approvalService.correct(
        entry.id ?? '',
        {
          principal: operator(),
          patch: { durationSeconds: 5400 },
          note: 'client disputed the hour count',
        },
      );

      // The original flipped to corrected with its frozen fields intact.
      expect(original.status).toBe('corrected');
      const reloadedOriginal = await approvalService.getEntry(entry.id ?? '');
      expect(reloadedOriginal.status).toBe('corrected');
      expect(reloadedOriginal.durationSeconds).toBe(3600);
      expect(reloadedOriginal.approvedAt).toEqual(APPROVE_AT);

      // And it stays frozen: editing its duration still refuses to save.
      reloadedOriginal.durationSeconds = 4000;
      await expect(reloadedOriginal.save()).rejects.toThrow(/immutable/);

      // Its settlement rows are marked corrected, snapshots untouched.
      const originalCharge = await approvalService.charges.forTimeEntry(
        entry.id ?? '',
      );
      const originalCompensation =
        await approvalService.compensations.forTimeEntry(entry.id ?? '');
      expect(originalCharge?.status).toBe('corrected');
      expect(originalCompensation?.status).toBe('corrected');
      expect(originalCharge?.amount).toBeCloseTo(100.0, 2);
      expect(originalCharge?.getRateSnapshot()).toEqual(originalChargeSnapshot);

      // The correction is a linked draft carrying the patch.
      expect(correction.status).toBe('draft');
      expect(correction.correctionOfId).toBe(entry.id);
      expect(correction.durationSeconds).toBe(5400);
      expect(correction.caseId).toBe(supportCase.id);
      expect(correction.getMetadata()).toMatchObject({
        correctionNote: 'client disputed the hour count',
      });

      // It flows submit → approve normally into fresh final snapshots.
      await entryService.submit(correction, {
        byProfileId: 'profile-worker-1',
      });
      const CORRECT_AT = new Date('2026-07-02T09:00:00.000Z');
      const corrected = await approvalService.approve(correction.id ?? '', {
        at: CORRECT_AT,
      });
      expect(corrected.charge.amount).toBeCloseTo(150.0, 2);
      expect(corrected.charge.status).toBe('final');
      expect(corrected.charge.getRateSnapshot().derivedAt).toBe(
        CORRECT_AT.toISOString(),
      );

      // The original's snapshot never moved.
      const originalChargeAfter = await approvalService.charges.forTimeEntry(
        entry.id ?? '',
      );
      expect(originalChargeAfter?.amount).toBeCloseTo(100.0, 2);
      expect(originalChargeAfter?.getRateSnapshot()).toEqual(
        originalChargeSnapshot,
      );
    });

    it('requires the operator split and an approved original', async () => {
      const plan = await planWith(
        { mode: 'automatic' },
        { overageHourlyRate: 100.0 },
      );
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '');

      await expect(
        approvalService.correct(entry.id ?? '', {
          principal: operator(),
          patch: { durationSeconds: 1200 },
        }),
      ).rejects.toThrow(/only 'approved' entries can be corrected/);

      await approvalService.approve(entry.id ?? '', { at: APPROVE_AT });
      await expect(
        approvalService.correct(entry.id ?? '', {
          principal: supportPrincipalFromPermissions([], { id: 'nobody' }),
          patch: { durationSeconds: 1200 },
        }),
      ).rejects.toThrow(TimeEntryApprovalDeniedError);
    });
  });

  it('derives from the case planSnapshot even after the live plan is edited', async () => {
    const plan = await planWith(
      { mode: 'automatic' },
      { includedMinutes: 0, overageHourlyRate: 100.0 },
    );
    const supportCase = await caseUnder(plan);

    const first = await submittedEntry(supportCase.id ?? '');
    const firstResult = await approvalService.approve(first.id ?? '', {
      at: APPROVE_AT,
    });
    expect(firstResult.charge.amount).toBeCloseTo(100.0, 2);

    // Edit the live plan AFTER the case captured its snapshot.
    plan.overageHourlyRate = 500.0;
    await plan.save();

    const second = await submittedEntry(supportCase.id ?? '');
    const secondResult = await approvalService.approve(second.id ?? '', {
      at: APPROVE_AT,
    });
    // History never rewritten: still the snapshot's 100/h, not the live 500/h.
    expect(secondResult.charge.amount).toBeCloseTo(100.0, 2);
    expect(secondResult.charge.getRateSnapshot()).toMatchObject({
      hourlyRate: 100,
    });
  });

  it('denies a principal from another tenant', async () => {
    const plan = await planWith({ mode: 'operator' });
    const supportCase = await caseUnder(plan, { tenantId: 'tenant-1' });
    const entry = await submittedEntry(supportCase.id ?? '');
    expect(entry.tenantId).toBe('tenant-1');

    await expect(
      approvalService.approve(entry.id ?? '', {
        principal: operator({ tenantId: 'tenant-2' }),
        at: APPROVE_AT,
      }),
    ).rejects.toThrow(/does not match the entry's tenant/);

    const result = await approvalService.approve(entry.id ?? '', {
      principal: operator({ tenantId: 'tenant-1' }),
      at: APPROVE_AT,
    });
    expect(result.path).toBe('operator');
  });

  describe('reject', () => {
    it('rejects a submitted entry with a reason under the operator split', async () => {
      const plan = await planWith({ mode: 'operator' });
      const supportCase = await caseUnder(plan);
      const entry = await submittedEntry(supportCase.id ?? '');

      await expect(
        approvalService.reject(entry.id ?? '', {
          principal: supportPrincipalFromPermissions([], { id: 'nobody' }),
          reason: 'not billable',
        }),
      ).rejects.toThrow(TimeEntryApprovalDeniedError);

      const rejected = await approvalService.reject(entry.id ?? '', {
        principal: operator(),
        reason: 'duplicate of an earlier entry',
      });
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectedAt).toBeInstanceOf(Date);
      expect(rejected.rejectedByProfileId).toBe('operator-1');
      expect(rejected.rejectionReason).toBe('duplicate of an earlier entry');
    });
  });

  it('records a case event carrying the charge amount and never the compensation', async () => {
    await approvalService.compensationPlans.create({
      specialistId: 'spec-1',
      name: 'Comp',
      hourlyRate: 45.0,
    });
    const plan = await planWith(
      { mode: 'automatic' },
      { overageHourlyRate: 120.0 },
    );
    const supportCase = await caseUnder(plan);
    const entry = await submittedEntry(supportCase.id ?? '', {
      specialistId: 'spec-1',
    });

    const { charge, compensation, path } = await approvalService.approve(
      entry.id ?? '',
      { at: APPROVE_AT },
    );
    expect(compensation.amount).toBeCloseTo(45.0, 2);

    const events = await caseService.events.forCase(supportCase.id ?? '', {
      eventType: 'time_recorded',
    });
    const approvalEvent = events.find(
      (event) => (event.getPayload() as { approved?: boolean }).approved,
    );
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent?.getPayload()).toEqual({
      approved: true,
      path,
      timeEntryId: entry.id,
      chargeAmount: charge.amount,
    });
    expect(JSON.stringify(approvalEvent?.getPayload())).not.toContain(
      'compensation',
    );
  });
});
