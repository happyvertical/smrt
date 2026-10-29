import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it, vi } from 'vitest';
import { SubmissionService } from '../submission-service.js';
import { WorkbookService } from '../workbook-service.js';
import { workbookFixture } from './workbook-workflows.js';

type Fixture = Awaited<ReturnType<typeof workbookFixture>>;
function confirmation(f: Fixture) {
  return {
    ...f.request,
    expectedAttemptId: f.attempt.id,
    expectedHeadId: null as string | null,
    requestKey: 'completion-1',
  };
}

export function workbookCompletionContractTests(
  createDb: () => Promise<{
    db: DatabaseInterface;
    cleanup: () => Promise<void>;
  }>,
) {
  const fixture = async () => {
    const { db, cleanup } = await createDb();
    return workbookFixture(db, cleanup);
  };

  it('requires a parent decision, keeps its historical retry and protects own-learner context', async () => {
    const f = await fixture();
    try {
      const permissive = new WorkbookService(
        f.db,
        () => true,
        () => true,
        { storage: f.storage },
      );
      const request = confirmation(f);
      await expect(
        f.as(f.own, () =>
          permissive.completeWorkbookActivity({ ...request, ...f.own }),
        ),
      ).rejects.toThrow();
      await expect(
        f.as(f.parent, () =>
          f.service.completeWorkbookActivity({
            ...request,
            tenantId: String(f.foreign.tenantId),
          }),
        ),
      ).rejects.toThrow();
      const completed = await f.as(f.parent, () =>
        f.service.completeWorkbookActivity(request),
      );
      expect(completed).toMatchObject({
        attemptId: f.attempt.id,
        submissionId: f.attempt.submissionId,
        feedbackHeadId: null,
        actorUserId: f.parent.actorUserId,
      });
      expect(completed.completedAt).toBeInstanceOf(Date);
      expect(
        await f.as(f.parent, () => f.service.completeWorkbookActivity(request)),
      ).toEqual(completed);
      await expect(
        f.as(f.parent, () =>
          f.service.completeWorkbookActivity({
            ...request,
            expectedHeadId: f.attempt.id,
          }),
        ),
      ).rejects.toMatchObject({ code: 'changed_retry' });
      await expect(
        f.as(f.parent, () =>
          f.service.completeWorkbookActivity({
            ...request,
            requestKey: 'another-completion',
          }),
        ),
      ).rejects.toMatchObject({ code: 'already_complete' });
      const own = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(own.completion).toEqual({
        status: 'complete',
        completedAt: completed.completedAt,
      });
      expect(own.completionContext).toBeNull();
      expect(own.attempts[0].completionDecision).toBeNull();
      expect(own.attempts[0].headId).toBeNull();
      expect(own.attempts[0].revisions).toEqual([]);
      const next = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          requestKey: 'correction-2',
          intakeItemId: 'correction-intake',
          previousSubmissionId: f.attempt.submissionId,
        }),
      );
      const current = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({ ...f.request, limit: 1 }),
      );
      expect(current.completion).toEqual({
        status: 'doing',
        completedAt: null,
      });
      expect(current.currentAttemptId).toBe(next.id);
      expect(current.latestSubmissionId).toBe(next.submissionId);
      const historical = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.request,
          limit: 1,
          cursor: next.id,
        }),
      );
      expect(historical.attempts[0].id).toBe(f.attempt.id);
      expect(historical.attempts[0].completionDecision).toEqual(completed);
      expect(historical.currentAttemptId).toBe(next.id);
      expect(historical.latestSubmissionId).toBe(next.submissionId);
      expect(historical.completion.status).toBe('doing');
      expect(
        await f.as(f.parent, () => f.service.completeWorkbookActivity(request)),
      ).toEqual(completed);
      await expect(
        f.as(f.parent, () =>
          f.service.completeWorkbookActivity({
            ...request,
            requestKey: 'stale-first',
          }),
        ),
      ).rejects.toMatchObject({ code: 'stale_attempt' });
      expect(
        (await f.as(f.parent, () => f.service.getWorkbookTimeline(f.request)))
          .completion.status,
      ).toBe('doing');
    } finally {
      await f.close();
    }
  });

  it('checks the effective feedback head while keeping same-attempt completion through AI and guardian changes', async () => {
    const f = await fixture();
    try {
      const request = confirmation(f);
      const ai = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'ai-before-complete',
          assessment: f.assessment,
        }),
      );
      await expect(
        f.as(f.parent, () => f.service.completeWorkbookActivity(request)),
      ).rejects.toMatchObject({ code: 'stale_head' });
      const completed = await f.as(f.parent, () =>
        f.service.completeWorkbookActivity({
          ...request,
          expectedHeadId: ai.id,
        }),
      );
      const guardian = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          requestKey: 'guardian-after-complete',
          revisionId: ai.id,
          expectedHeadId: null,
          assessment: {
            ...f.assessment,
            feedback: 'Private guardian revision',
          },
        }),
      );
      await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'ai-after-guardian',
          assessment: {
            ...f.assessment,
            provenance: {
              ...f.assessment.provenance,
              analysisId: 'later-analysis',
            },
          },
        }),
      );
      const parent = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline(f.request),
      );
      expect(parent.completionContext?.expectedHeadId).toBe(guardian.id);
      expect(parent.completion).toEqual({
        status: 'complete',
        completedAt: completed.completedAt,
      });
      expect(parent.attempts[0].completionDecision).toEqual(completed);
      const own = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(own.completion).toEqual(parent.completion);
      expect(own.completionContext).toBeNull();
      expect(own.attempts[0].completionDecision).toBeNull();
      expect(own.attempts[0].headId).toBeNull();
      expect(own.attempts[0].revisions).toEqual([]);
      expect(own.attempts[0].submission.grade).toBeNull();
      expect(
        await f.as(f.parent, () =>
          f.service.completeWorkbookActivity({
            ...request,
            expectedHeadId: ai.id,
          }),
        ),
      ).toEqual(completed);
    } finally {
      await f.close();
    }
  });

  it('keeps legacy workbook grading unfinished and preserves a fresh independent practice episode', async () => {
    const f = await fixture();
    try {
      const plain = new SubmissionService(
        f.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === f.guardianType.id,
        () => true,
        { storage: f.storage },
      );
      await f.as(f.parent, () =>
        plain.reviewSubmission({
          ...f.parent,
          enrollmentId: f.activity.enrollmentId,
          submissionId: f.attempt.submissionId,
          score: 0.5,
          feedback: 'Legacy grade',
        }),
      );
      expect(
        (await f.as(f.parent, () => f.service.getWorkbookTimeline(f.request)))
          .completion.status,
      ).toBe('doing');
      const progress = await f.as(f.parent, () =>
        f.service.listProgress({
          ...f.parent,
          enrollmentId: f.activity.enrollmentId,
        }),
      );
      expect(progress[0]).toMatchObject({
        status: 'in_progress',
        completedAt: null,
      });
      const original = await f.db.get('workbook_attempts', {
        id: f.attempt.id,
      });
      const firstCapturedAt = new Date(String(original?.captured_at)).getTime();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(firstCapturedAt);
      let next: Fixture['attempt'];
      try {
        next = await f.as(f.own, () =>
          f.service.captureWorkbookWork({
            ...f.capture,
            requestKey: 'independent-practice',
            intakeItemId: 'fresh-practice-intake',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
      const persistedNext = await f.db.get('workbook_attempts', {
        id: next.id,
      });
      expect(
        new Date(String(persistedNext?.captured_at)).getTime(),
      ).toBeGreaterThan(firstCapturedAt);
      expect(next.previousAttemptId).toBeNull();
      expect(next.episodeId).not.toBe(f.attempt.episodeId);
      const timeline = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline(f.request),
      );
      expect(timeline.currentAttemptId).toBe(next.id);
      expect(timeline.completion.status).toBe('doing');
      expect(
        timeline.attempts.find((a) => a.id === f.attempt.id)
          ?.completionDecision,
      ).toBeNull();
      const completed = await f.as(f.parent, () =>
        f.service.completeWorkbookActivity({
          ...confirmation(f),
          expectedAttemptId: next.id,
          submissionId: next.submissionId,
        }),
      );
      expect(completed.attemptId).toBe(next.id);
      expect(
        (
          await f.as(f.parent, () =>
            plain.getSubmission({
              ...f.parent,
              enrollmentId: f.activity.enrollmentId,
              submissionId: f.attempt.submissionId,
            }),
          )
        ).grade,
      ).toMatchObject({ score: 0.5 });
    } finally {
      await f.close();
    }
  });

  it('rechecks session, membership and guardian relation before replaying a decision', async () => {
    const f = await fixture();
    try {
      let allowed = true;
      const service = new WorkbookService(
        f.db,
        (input) => allowed && input.relationshipTypeId === f.guardianType.id,
        () => true,
        { storage: f.storage },
      );
      const request = confirmation(f);
      await expect(service.completeWorkbookActivity(request)).rejects.toThrow();
      const completed = await f.as(f.parent, () =>
        service.completeWorkbookActivity(request),
      );
      await expect(
        f.as(f.own, () => service.completeWorkbookActivity(request)),
      ).rejects.toThrow();
      for (const learnerId of [String(f.sibling.id), String(f.foreign.id)])
        await expect(
          f.as(f.parent, () =>
            service.completeWorkbookActivity({ ...request, learnerId }),
          ),
        ).rejects.toThrow();
      allowed = false;
      await expect(
        f.as(f.parent, () => service.completeWorkbookActivity(request)),
      ).rejects.toThrow();
      allowed = true;
      for (const actorUserId of [f.parent.actorUserId, f.own.actorUserId]) {
        await f.db.update(
          'memberships',
          { tenant_id: f.parent.tenantId, user_id: actorUserId },
          { status: 'inactive' },
        );
        await expect(
          f.as(f.parent, () => service.completeWorkbookActivity(request)),
        ).rejects.toThrow();
        await f.db.update(
          'memberships',
          { tenant_id: f.parent.tenantId, user_id: actorUserId },
          { status: 'active' },
        );
      }
      expect(
        await f.as(f.parent, () => service.completeWorkbookActivity(request)),
      ).toEqual(completed);
      await f.db.delete('profile_relationships', { id: f.relationship.id });
      await expect(
        f.as(f.parent, () => service.completeWorkbookActivity(request)),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it('serializes independent completion and correction transactions without completing a successor', async () => {
    const f = await fixture();
    try {
      const request = confirmation(f);
      const [capture, completion] = await f.as(f.parent, () =>
        Promise.allSettled([
          f.service.captureWorkbookWork({
            ...f.capture,
            ...f.parent,
            requestKey: 'racing-correction',
            intakeItemId: 'racing-correction',
            previousSubmissionId: f.attempt.submissionId,
          }),
          f.service.completeWorkbookActivity(request),
        ]),
      );
      expect(capture.status).toBe('fulfilled');
      if (capture.status !== 'fulfilled') throw capture.reason;
      if (completion.status === 'rejected')
        expect(completion.reason).toMatchObject({ code: 'stale_attempt' });
      const after = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline(f.request),
      );
      expect(after.currentAttemptId).toBe(capture.value.id);
      expect(after.latestSubmissionId).toBe(capture.value.submissionId);
      expect(after.completion).toEqual({ status: 'doing', completedAt: null });
      expect(
        after.attempts.find((row) => row.id === f.attempt.id)
          ?.completionDecision === null,
      ).toBe(completion.status === 'rejected');
      const current = {
        ...request,
        submissionId: capture.value.submissionId,
        expectedAttemptId: capture.value.id,
        requestKey: 'parallel-retry',
      };
      const same = await f.as(f.parent, () =>
        Promise.all([
          f.service.completeWorkbookActivity(current),
          f.service.completeWorkbookActivity(current),
        ]),
      );
      expect(same[0]).toEqual(same[1]);
      const next = await f.as(f.parent, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          ...f.parent,
          requestKey: 'next-racing-correction',
          intakeItemId: 'next-racing-correction',
          previousSubmissionId: capture.value.submissionId,
        }),
      );
      const competing = await f.as(f.parent, () =>
        Promise.allSettled([
          f.service.completeWorkbookActivity({
            ...current,
            expectedAttemptId: next.id,
            submissionId: next.submissionId,
            requestKey: 'decision-a',
          }),
          f.service.completeWorkbookActivity({
            ...current,
            expectedAttemptId: next.id,
            submissionId: next.submissionId,
            requestKey: 'decision-b',
          }),
        ]),
      );
      expect(
        competing.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = competing.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
        code: 'already_complete',
      });
      expect(
        (await f.as(f.parent, () => f.service.getWorkbookTimeline(f.request)))
          .completion.status,
      ).toBe('complete');
    } finally {
      await f.close();
    }
  });

  it('rolls back completion and swallowed competing mutation failures with their transaction', async () => {
    const f = await fixture();
    try {
      const request = confirmation(f);
      await expect(
        f.as(f.parent, () =>
          f.service.withTransaction(async (service) => {
            await service.completeWorkbookActivity(request);
            throw new Error('rollback-completion');
          }),
        ),
      ).rejects.toThrow('rollback-completion');
      const rolledBack = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline(f.request),
      );
      expect(rolledBack.completion.status).toBe('doing');
      expect(rolledBack.attempts[0].completionDecision).toBeNull();
      await expect(
        f.as(f.parent, () =>
          f.service.withTransaction((service) =>
            Promise.allSettled([
              service.completeWorkbookActivity(request),
              service.completeWorkbookActivity({
                ...request,
                requestKey: 'competing-request',
              }),
            ]),
          ),
        ),
      ).rejects.toMatchObject({ code: 'already_complete' });
      const afterConflict = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline(f.request),
      );
      expect(afterConflict.completion.status).toBe('doing');
      expect(afterConflict.attempts[0].completionDecision).toBeNull();
      expect(
        (
          await f.as(f.parent, () =>
            f.service.completeWorkbookActivity(request),
          )
        ).attemptId,
      ).toBe(f.attempt.id);
    } finally {
      await f.close();
    }
  });
}
