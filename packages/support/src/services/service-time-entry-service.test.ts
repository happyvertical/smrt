/**
 * ServiceTimeEntryService tests (#1930): the ONE recording contract shared by
 * timer, manual, imported, and agent entries — duration/participant/context
 * validation, tenant copy from the case, evidence round-trips, the
 * `time_recorded` audit event, and the submit flow.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceTimeEntryService } from './service-time-entry-service.js';
import { SupportCaseService } from './support-case-service.js';

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

const STARTED_AT = new Date('2026-07-01T10:00:00.000Z');
const ENDED_AT = new Date('2026-07-01T11:30:00.000Z');

describe('ServiceTimeEntryService', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let caseService: SupportCaseService;
  let service: ServiceTimeEntryService;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    caseService = await SupportCaseService.create({ db: ctx.db });
    service = await ServiceTimeEntryService.create({
      db: ctx.db,
      caseService,
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe('one contract across all four sources', () => {
    it('timer entries require both bounds and derive the duration', async () => {
      const supportCase = await caseService.openCase({ subject: 'timer' });

      await expect(
        service.record({
          caseId: supportCase.id,
          participantKind: 'human',
          participantProfileId: 'profile-1',
          source: 'timer',
          startedAt: STARTED_AT,
        }),
      ).rejects.toThrow(/'timer' requires both startedAt and endedAt/);

      const entry = await service.record({
        caseId: supportCase.id,
        participantKind: 'human',
        participantProfileId: 'profile-1',
        source: 'timer',
        description: 'debugged the login loop',
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
      });
      expect(entry.status).toBe('draft');
      expect(entry.durationSeconds).toBe(5400);
      expect(entry.source).toBe('timer');
    });

    it('manual entries take an explicit duration without bounds', async () => {
      const supportCase = await caseService.openCase({ subject: 'manual' });
      const entry = await service.record({
        caseId: supportCase.id,
        participantKind: 'human',
        participantProfileId: 'profile-1',
        source: 'manual',
        description: 'pairing session',
        durationSeconds: 1800,
      });
      expect(entry.durationSeconds).toBe(1800);
      expect(entry.startedAt).toBeNull();
    });

    it('imported entries pass the same gate as first-party ones', async () => {
      const supportCase = await caseService.openCase({ subject: 'import' });
      const entry = await service.record({
        caseId: supportCase.id,
        participantKind: 'human',
        participantProfileId: 'profile-1',
        source: 'import',
        description: 'imported from legacy tracker',
        durationSeconds: 900,
      });
      expect(entry.source).toBe('import');

      await expect(
        service.record({
          caseId: supportCase.id,
          participantKind: 'human',
          participantProfileId: 'profile-1',
          source: 'import',
          durationSeconds: 0,
        }),
      ).rejects.toThrow(/durationSeconds must be greater than zero/);
    });

    it('agent entries require an agentRef; humans require a profile', async () => {
      const supportCase = await caseService.openCase({ subject: 'actors' });

      await expect(
        service.record({
          caseId: supportCase.id,
          participantKind: 'agent',
          source: 'agent',
          durationSeconds: 600,
        }),
      ).rejects.toThrow(/'agent' requires agentRef/);

      await expect(
        service.record({
          caseId: supportCase.id,
          participantKind: 'human',
          source: 'manual',
          durationSeconds: 600,
        }),
      ).rejects.toThrow(/'human' requires participantProfileId/);

      const entry = await service.record({
        caseId: supportCase.id,
        participantKind: 'agent',
        agentRef: 'persona:support-triage',
        source: 'agent',
        description: 'automated triage session',
        durationSeconds: 600,
      });
      expect(entry.participantKind).toBe('agent');
      expect(entry.agentRef).toBe('persona:support-triage');
    });
  });

  describe('validation failures', () => {
    it('rejects entries with no duration at all', async () => {
      const supportCase = await caseService.openCase({ subject: 'no dur' });
      await expect(
        service.record({
          caseId: supportCase.id,
          participantKind: 'human',
          participantProfileId: 'profile-1',
          source: 'manual',
        }),
      ).rejects.toThrow(/a duration is required/);
    });

    it('rejects a period that ends before it starts', async () => {
      const supportCase = await caseService.openCase({ subject: 'backwards' });
      await expect(
        service.record({
          caseId: supportCase.id,
          participantKind: 'human',
          participantProfileId: 'profile-1',
          source: 'timer',
          startedAt: ENDED_AT,
          endedAt: STARTED_AT,
        }),
      ).rejects.toThrow(/startedAt must be before endedAt/);
    });

    it('rejects entries with no work context', async () => {
      await expect(
        service.record({
          participantKind: 'human',
          participantProfileId: 'profile-1',
          source: 'manual',
          durationSeconds: 600,
        }),
      ).rejects.toThrow(/a work context is required/);
    });

    it('rejects a half-specified work ref', async () => {
      await expect(
        service.record({
          workRefType: '@happyvertical/smrt-projects:Issue',
          participantKind: 'human',
          participantProfileId: 'profile-1',
          source: 'manual',
          durationSeconds: 600,
        }),
      ).rejects.toThrow(/workRefType and workRefId must be provided together/);
    });

    it('rejects a missing case', async () => {
      await expect(
        service.record({
          caseId: 'no-such-case',
          participantKind: 'human',
          participantProfileId: 'profile-1',
          source: 'manual',
          durationSeconds: 600,
        }),
      ).rejects.toThrow(/SupportCase not found/);
    });
  });

  it('accepts a pure work-ref context without a case (no case event)', async () => {
    const entry = await service.record({
      workRefType: '@happyvertical/smrt-projects:Issue',
      workRefId: 'issue-42',
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'manual',
      description: 'planning session',
      durationSeconds: 1200,
    });
    expect(entry.caseId).toBeNull();
    expect(entry.workRefId).toBe('issue-42');
  });

  it('copies the tenant from the case unless explicitly provided', async () => {
    const supportCase = await caseService.openCase({
      subject: 'tenant copy',
      tenantId: 'tenant-1',
    });
    const copied = await service.record({
      caseId: supportCase.id,
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'manual',
      durationSeconds: 600,
    });
    expect(copied.tenantId).toBe('tenant-1');

    const explicit = await service.record({
      caseId: supportCase.id,
      tenantId: 'tenant-1',
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'manual',
      durationSeconds: 600,
    });
    expect(explicit.tenantId).toBe('tenant-1');

    // A disagreeing explicit tenant would be a cross-tenant reference onto
    // another tenant's case — refused (copilot review, PR #1943).
    await expect(
      service.record({
        caseId: supportCase.id,
        tenantId: 'tenant-other',
        participantKind: 'human',
        participantProfileId: 'profile-1',
        source: 'manual',
        durationSeconds: 600,
      }),
    ).rejects.toThrow(/does not match the case's tenant/);
  });

  it('round-trips work evidence', async () => {
    const supportCase = await caseService.openCase({ subject: 'evidence' });
    const evidence = [
      { kind: 'commit', ref: 'abc123', label: 'fix: login loop' },
      { kind: 'chat_message', ref: 'msg-9' },
    ];
    const entry = await service.record({
      caseId: supportCase.id,
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'manual',
      durationSeconds: 600,
      evidence,
    });

    const reloaded = await service.getEntry(entry.id ?? '');
    expect(reloaded.getEvidence()).toEqual(evidence);
  });

  it('writes a time_recorded case event with the audit payload', async () => {
    const supportCase = await caseService.openCase({ subject: 'audited' });
    const entry = await service.record({
      caseId: supportCase.id,
      participantKind: 'agent',
      agentRef: 'persona:support',
      source: 'agent',
      durationSeconds: 900,
    });

    const events = await caseService.events.forCase(supportCase.id ?? '', {
      eventType: 'time_recorded',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorKind).toBe('agent');
    expect(events[0]?.getPayload()).toMatchObject({
      timeEntryId: entry.id,
      durationSeconds: 900,
      source: 'agent',
      participantKind: 'agent',
    });
  });

  describe('submit', () => {
    it('moves a draft to submitted with submitter stamps', async () => {
      const supportCase = await caseService.openCase({ subject: 'submit' });
      const entry = await service.record({
        caseId: supportCase.id,
        participantKind: 'human',
        participantProfileId: 'profile-1',
        source: 'manual',
        durationSeconds: 600,
      });

      const submitted = await service.submit(entry, {
        byProfileId: 'profile-1',
      });
      expect(submitted.status).toBe('submitted');
      expect(submitted.submittedAt).toBeInstanceOf(Date);
      expect(submitted.submittedByProfileId).toBe('profile-1');
    });

    it('refuses to submit an already-submitted entry', async () => {
      const supportCase = await caseService.openCase({ subject: 'resubmit' });
      const entry = await service.record({
        caseId: supportCase.id,
        participantKind: 'human',
        participantProfileId: 'profile-1',
        source: 'manual',
        durationSeconds: 600,
      });
      await service.submit(entry);

      await expect(service.submit(entry.id ?? '')).rejects.toThrow(
        /only 'draft' or 'rejected' entries can be submitted/,
      );
    });
  });
});
