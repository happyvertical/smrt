import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import {
  educationIntakeHandlers,
  preserveWorkbookIntakeAnalysis,
} from '../ingestion.js';
import {
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
} from '../workbook-contracts.js';
import { WorkbookAssessmentRevisionCollection } from '../workbook-models.js';
import { WorkbookService } from '../workbook-service.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

export const workbookClasses = [
  ...submissionClasses,
  'Workbook',
  'WorkbookActivity',
  'WorkbookAttempt',
  'WorkbookAssessmentRevision',
  'WorkbookFeedbackRelease',
  'WorkbookFeedbackDelivery',
];
async function workbookFixture(
  db: DatabaseInterface,
  cleanup: () => Promise<void>,
) {
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'workbook-'));
  const service = new WorkbookService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
    { storage },
  );
  const create = {
    ...f.parent,
    workbookKey: 'synthetic-copy-v1',
    title: 'Synthetic workbook',
    edition: 'v1',
    pageKey: 'section-a:p7',
    pageLabel: 'Page 7',
  };
  const activity = await f.as(f.parent, () =>
    service.resolveWorkbookActivity(create),
  );
  const capture = {
    ...f.own,
    activityId: activity.id,
    requestKey: 'capture-1',
    intakeItemId: 'synthetic-intake',
    pages: [
      {
        name: 'p.png',
        mimeType: 'image/png' as const,
        data: Buffer.from('synthetic-page'),
      },
    ],
    assistance: 'independent' as const,
  };
  const attempt = await f.as(f.own, () => service.captureWorkbookWork(capture));
  const request = {
    ...f.parent,
    activityId: activity.id,
    submissionId: attempt.submissionId,
  };
  const sources = await f.as(f.parent, () =>
    service.getWorkbookSourceAnchors(request),
  );
  const assessment: WorkbookAssessment = {
    version: 1,
    feedback: 'Try adding again',
    provenance: {
      provider: 'synthetic',
      model: 'test',
      configurationVersion: 'v1',
      rubricVersion: 'v1',
      inputHash: sources[0].sha256,
      analysisId: 'test-analysis',
    },
    vocabulary: structuredClone(WORKBOOK_MATH_VOCABULARY),
    questions: [
      {
        id: 'p7:q1',
        prompt: '8+7',
        answer: '14',
        result: 'incorrect',
        reason: 'none',
        feedback: 'Count again',
        points: 0,
        possiblePoints: 1,
        anchors: [{ ...sources[0], page: 1, rect: [0, 0, 1, 1] }],
        conceptIds: ['math.addition'],
      },
    ],
  };
  return {
    ...f,
    service,
    create,
    activity,
    capture,
    attempt,
    request,
    assessment,
    close: async () => {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
export function workbookContractTests(
  createDb: () => Promise<{
    db: DatabaseInterface;
    cleanup: () => Promise<void>;
  }>,
) {
  const fixture = async () => {
    const environment = await createDb();
    return workbookFixture(environment.db, environment.cleanup);
  };
  it('resolves explicit identity, denies sibling/foreign/learner planning, deduplicates capture and rolls back failed units', async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.as(f.parent, () =>
            f.service.resolveWorkbookActivity(f.create),
          )
        ).id,
      ).toBe(f.activity.id);
      await expect(
        f.as(f.parent, () =>
          f.service.resolveWorkbookActivity({ ...f.create, edition: 'v2' }),
        ),
      ).rejects.toThrow('edition');
      await expect(
        f.as(f.own, () =>
          f.service.resolveWorkbookActivity({ ...f.create, ...f.own }),
        ),
      ).rejects.toThrow('authorized');
      expect(
        (await f.as(f.own, () => f.service.captureWorkbookWork(f.capture))).id,
      ).toBe(f.attempt.id);
      await expect(
        f.as(f.own, () =>
          f.service.captureWorkbookWork({
            ...f.capture,
            pages: [{ ...f.capture.pages[0], data: Buffer.from('changed') }],
          }),
        ),
      ).rejects.toThrow('changed');
      await expect(
        f.as(f.own, () =>
          f.service.getWorkbookTimeline({
            ...f.own,
            activityId: f.activity.id,
            learnerId: String(f.sibling.id),
          }),
        ),
      ).rejects.toThrow('authorized');
      await expect(
        f.as(f.own, () =>
          f.service.getWorkbookTimeline({
            ...f.own,
            activityId: f.activity.id,
            tenantId: String(f.foreign.tenantId),
          }),
        ),
      ).rejects.toThrow('authorized');
      await expect(
        f.as(f.parent, () =>
          f.service.withTransaction(async (s) => {
            await s.resolveWorkbookActivity({
              ...f.create,
              pageKey: 'rollback',
              pageLabel: 'Rollback',
            });
            throw new Error('abort');
          }),
        ),
      ).rejects.toThrow('abort');
      expect(
        await f.as(f.parent, () => f.service.listWorkbookActivities(f.parent)),
      ).toHaveLength(1);
      const page2 = await f.as(f.parent, () =>
        f.service.resolveWorkbookActivity({
          ...f.create,
          pageKey: 'section-b:p7',
        }),
      );
      expect(page2.id).not.toBe(f.activity.id);
      expect(page2.enrollmentId).toBe(f.activity.enrollmentId);
      const edition2 = await f.as(f.parent, () =>
        f.service.resolveWorkbookActivity({
          ...f.create,
          workbookKey: 'edition2-copy',
          edition: 'v2',
        }),
      );
      expect(edition2.enrollmentId).not.toBe(f.activity.enrollmentId);
    } finally {
      await f.close();
    }
  });
  it('preserves immutable AI/review/release history, rejects stale review and withholds grade on alternate read', async () => {
    const f = await fixture();
    try {
      const proposal = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'analysis-1',
          assessment: f.assessment,
        }),
      );
      expect(
        (
          await f.as(f.own, () =>
            f.service.getWorkbookTimeline({
              ...f.own,
              activityId: f.activity.id,
            }),
          )
        ).attempts[0].revisions,
      ).toHaveLength(0);
      await expect(
        f.as(f.own, () =>
          f.service.acknowledgeWorkbookFeedbackDelivery({
            ...f.request,
            ...f.own,
            revisionId: proposal.id,
            requestKey: 'withheld',
          }),
        ),
      ).rejects.toThrow('authorized');
      const review = {
        ...f.request,
        revisionId: proposal.id,
        expectedHeadId: null,
        requestKey: 'review-1',
      };
      const approved = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment(review),
      );
      expect(
        (await f.as(f.parent, () => f.service.reviewWorkbookAssessment(review)))
          .id,
      ).toBe(approved.id);
      await expect(
        f.as(f.parent, () =>
          f.service.reviewWorkbookAssessment({
            ...review,
            requestKey: 'stale',
          }),
        ),
      ).rejects.toThrow('head changed');
      await expect(
        f.as(f.own, () =>
          f.service.reviewWorkbookAssessment({ ...review, ...f.own }),
        ),
      ).rejects.toThrow('authorized');
      const row = await f.as(f.parent, async () =>
        (await WorkbookAssessmentRevisionCollection.create({ db: f.db })).get(
          approved.id,
        ),
      );
      await expect(f.as(f.parent, () => row!.save())).rejects.toThrow(
        'immutable',
      );
      const reload = new WorkbookService(
        f.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === f.guardianType.id,
        () => true,
        { storage: 'unused' },
      );
      const history = await f.as(f.parent, () =>
        reload.getWorkbookTimeline({ ...f.parent, activityId: f.activity.id }),
      );
      expect(history.attempts[0].revisions).toHaveLength(2);
      expect(
        (
          await f.as(f.own, () =>
            f.service.getSubmission({
              ...f.own,
              enrollmentId: f.activity.enrollmentId,
              submissionId: f.attempt.submissionId,
            }),
          )
        ).grade,
      ).toBeNull();
      await f.as(f.parent, () =>
        f.service.releaseWorkbookFeedback({
          ...f.request,
          revisionId: approved.id,
          expectedHeadId: approved.id,
          requestKey: 'release-1',
        }),
      );
      const ack = {
        ...f.request,
        ...f.own,
        revisionId: approved.id,
        requestKey: 'displayed',
      };
      const delivered = await f.as(f.own, () =>
        f.service.acknowledgeWorkbookFeedbackDelivery(ack),
      );
      expect(
        (
          await f.as(f.own, () =>
            f.service.acknowledgeWorkbookFeedbackDelivery({
              ...ack,
              requestKey: 'rerender',
            }),
          )
        ).id,
      ).toBe(delivered.id);
      await expect(
        f.as(f.parent, () =>
          f.service.acknowledgeWorkbookFeedbackDelivery({
            ...ack,
            ...f.parent,
          }),
        ),
      ).rejects.toThrow('authorized');
      const child = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(child.attempts[0].revisions.map((r) => r.id)).toEqual([
        approved.id,
      ]);
      expect(child.attempts[0].headId).toBeNull();
      expect(child.attempts[0].deliveries).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('direct policy is provisional, snapshots capture, and corrections never inflate independent evidence', async () => {
    const f = await fixture();
    try {
      await f.as(f.parent, () =>
        f.service.setWorkbookFeedbackPolicy({
          ...f.parent,
          activityId: f.activity.id,
          expectedPolicyVersion: 1,
          reviewRequired: false,
        }),
      );
      const p1 = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'a1',
          assessment: f.assessment,
        }),
      );
      expect(
        (
          await f.as(f.own, () =>
            f.service.getWorkbookTimeline({
              ...f.own,
              activityId: f.activity.id,
            }),
          )
        ).attempts[0].revisions,
      ).toHaveLength(0);
      await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: p1.id,
          expectedHeadId: null,
          requestKey: 'r1',
        }),
      );
      const correction = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          requestKey: 'capture-2',
          intakeItemId: 'synthetic-correction',
          previousSubmissionId: f.attempt.submissionId,
          assistance: 'assisted',
          pages: [
            { ...f.capture.pages[0], data: Buffer.from('corrected-page') },
          ],
        }),
      );
      expect(correction.episodeId).toBe(f.attempt.episodeId);
      expect(correction.policyVersion).toBe(2);
      expect(f.attempt.policyVersion).toBe(1);
      const req = { ...f.request, submissionId: correction.submissionId };
      const anchors = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(req),
      );
      const assessment = {
        ...f.assessment,
        questions: [
          {
            ...f.assessment.questions[0],
            answer: '15',
            result: 'correct' as const,
            points: 1,
            anchors: [
              {
                ...anchors[0],
                page: 1,
                rect: [0, 0, 1, 1] as [number, number, number, number],
              },
            ],
          },
        ],
      };
      const p2 = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...req,
          ...f.own,
          requestKey: 'a2',
          assessment,
        }),
      );
      const timeline = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(
        timeline.attempts.find((a) => a.id === correction.id)!.revisions[0]
          .kind,
      ).toBe('ai');
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getSubmission({
              ...f.parent,
              enrollmentId: f.activity.enrollmentId,
              submissionId: correction.submissionId,
            }),
          )
        ).grade,
      ).toBeNull();
      await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...req,
          revisionId: p2.id,
          expectedHeadId: null,
          requestKey: 'r2',
        }),
      );
      const summary = await f.as(f.parent, () =>
        f.service.getConceptEvidenceSummary({
          ...f.parent,
          activityId: f.activity.id,
        }),
      );
      expect(summary.concepts[0].confirmed).toMatchObject({
        independent: 1,
        assisted: 1,
        needsCorrection: 1,
        correct: 1,
      });
      expect(summary.concepts[0].episodes).toHaveLength(1);
      expect(
        summary.concepts[0].observations.map((o) => [o.assistance, o.result]),
      ).toEqual([
        ['independent', 'incorrect'],
        ['assisted', 'correct'],
      ]);
      expect(summary.concepts[0].cues).toContain('improving on this item');
      const next = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.parent,
          activityId: f.activity.id,
          limit: 1,
        }),
      );
      const evidence = summary.concepts[0].observations.find(
        (o) => !o.isCorrection,
      )!;
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getWorkbookTimeline({
              ...f.parent,
              activityId: f.activity.id,
              revisionId: evidence.revisionId,
              limit: 1,
            }),
          )
        ).attempts[0].submissionId,
      ).toBe(evidence.submissionId);
      expect(next.nextCursor).not.toBeNull();
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getWorkbookTimeline({
              ...f.parent,
              activityId: f.activity.id,
              limit: 1,
              cursor: next.nextCursor!,
            }),
          )
        ).attempts,
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('rejects fabricated anchors, malformed results, unknown concepts, and unknown-as-zero', async () => {
    const f = await fixture();
    try {
      for (const q of [
        {
          ...f.assessment.questions[0],
          result: 'unassessed',
          reason: 'illegible',
        },
        {
          ...f.assessment.questions[0],
          result: 'incorrect',
          reason: 'unanswered',
        },
        { ...f.assessment.questions[0], result: 'invented' },
        { ...f.assessment.questions[0], conceptIds: ['free-text'] },
        {
          ...f.assessment.questions[0],
          anchors: [{ ...f.assessment.questions[0].anchors[0], page: 2 }],
        },
        {
          ...f.assessment.questions[0],
          anchors: [
            { ...f.assessment.questions[0].anchors[0], assetId: 'foreign' },
          ],
        },
      ]) {
        await expect(
          f.as(f.own, () =>
            f.service.recordWorkbookAnalysis({
              ...f.request,
              ...f.own,
              requestKey: 'invalid',
              assessment: {
                ...f.assessment,
                questions: [q],
              } as WorkbookAssessment,
            }),
          ),
        ).rejects.toThrow();
      }
      const assessment = {
        ...f.assessment,
        questions: [
          {
            ...f.assessment.questions[0],
            result: 'unassessed' as const,
            reason: 'illegible' as const,
            points: null,
            possiblePoints: null,
          },
        ],
      };
      const revision = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'unreadable',
          assessment,
        }),
      );
      await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: revision.id,
          expectedHeadId: null,
          requestKey: 'unreadable-reviewed',
        }),
      );
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getConceptEvidenceSummary({
              ...f.parent,
              activityId: f.activity.id,
            }),
          )
        ).concepts[0].confirmed,
      ).toMatchObject({ unassessed: 1, needsCorrection: 0, independent: 0 });
    } finally {
      await f.close();
    }
  });
  it('serializes same-transaction decisions and poisons swallowed workbook failures', async () => {
    const f = await fixture();
    try {
      const p = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'a',
          assessment: f.assessment,
        }),
      );
      const review = {
        ...f.request,
        revisionId: p.id,
        expectedHeadId: null,
        requestKey: 'review-a',
      };
      await expect(
        f.as(f.parent, () =>
          f.service.withTransaction(async (s) => {
            const settled = await Promise.allSettled([
              s.reviewWorkbookAssessment(review),
              s.reviewWorkbookAssessment({ ...review, requestKey: 'review-b' }),
            ]);
            expect(
              settled.filter((r) => r.status === 'fulfilled'),
            ).toHaveLength(1);
            expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(
              1,
            );
          }),
        ),
      ).rejects.toThrow('head changed');
      let timeline = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.parent,
          activityId: f.activity.id,
        }),
      );
      expect(timeline.attempts[0].revisions).toHaveLength(1);
      await expect(
        f.as(f.parent, () =>
          f.service.withTransaction(async (s) => {
            await s.reviewWorkbookAssessment(review);
            try {
              await s.setWorkbookFeedbackPolicy({
                ...f.parent,
                activityId: f.activity.id,
                expectedPolicyVersion: 999,
                reviewRequired: false,
              });
            } catch {
              /* intentionally swallowed */
            }
          }),
        ),
      ).rejects.toThrow('policy changed');
      timeline = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.parent,
          activityId: f.activity.id,
        }),
      );
      expect(timeline.attempts[0].revisions).toHaveLength(1);
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getSubmission({
              ...f.parent,
              enrollmentId: f.activity.enrollmentId,
              submissionId: f.attempt.submissionId,
            }),
          )
        ).grade,
      ).toBeNull();
      const approved = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment(review),
      );
      expect(approved.sourceRevisionId).toBe(p.id);
      expect(approved.actorUserId).toBe(f.parent.actorUserId);
      await expect(
        f.as(f.parent, () =>
          f.service.releaseWorkbookFeedback({
            ...f.request,
            revisionId: p.id,
            expectedHeadId: null,
            requestKey: 'stale-release',
          }),
        ),
      ).rejects.toThrow('head changed');
      const release = {
        ...f.request,
        revisionId: approved.id,
        expectedHeadId: approved.id,
        requestKey: 'release',
      };
      const first = await f.as(f.parent, () =>
        f.service.releaseWorkbookFeedback(release),
      );
      expect(
        (await f.as(f.parent, () => f.service.releaseWorkbookFeedback(release)))
          .id,
      ).toBe(first.id);
      const revisions = await f.as(f.parent, () =>
        WorkbookAssessmentRevisionCollection.create({ db: f.db }),
      );
      await expect(
        f.as(f.parent, () => revisions.delete(approved.id)),
      ).rejects.toThrow('immutable');
    } finally {
      await f.close();
    }
  });
  it('rejects changed correction identities before guardian review and preserves historical decisions without grading successor', async () => {
    const f = await fixture();
    try {
      const p = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'initial',
          assessment: f.assessment,
        }),
      );
      const correction = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          intakeItemId: 'corrected',
          requestKey: 'correction',
          previousSubmissionId: f.attempt.submissionId,
          assistance: 'unknown',
          pages: [{ ...f.capture.pages[0], data: Buffer.from('new-photo') }],
        }),
      );
      const request = { ...f.request, submissionId: correction.submissionId };
      expect(
        await f.as(f.own, () =>
          f.service.getWorkbookQuestionIdentity({ ...request, ...f.own }),
        ),
      ).toEqual([{ id: 'p7:q1', prompt: '8+7' }]);
      const sources = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(request),
      );
      const assessment = {
        ...f.assessment,
        questions: [
          {
            ...f.assessment.questions[0],
            id: 'another-page:q1',
            anchors: [
              {
                ...sources[0],
                page: 1,
                rect: [0, 0, 1, 1] as [number, number, number, number],
              },
            ],
          },
        ],
      };
      await expect(
        f.as(f.own, () =>
          f.service.recordWorkbookAnalysis({
            ...request,
            ...f.own,
            requestKey: 'wrong-page',
            assessment,
          }),
        ),
      ).rejects.toThrow('question identity');
      await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: p.id,
          expectedHeadId: null,
          requestKey: 'historical',
        }),
      );
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getSubmission({
              ...f.parent,
              enrollmentId: f.activity.enrollmentId,
              submissionId: correction.submissionId,
            }),
          )
        ).grade,
      ).toBeNull();
    } finally {
      await f.close();
    }
  });
  it('preserves validated real-provider-shaped question DTOs idempotently with retained source hashes', async () => {
    const f = await fixture();
    try {
      const handlers = educationIntakeHandlers({
        submissions: f.service,
        request: { ...f.own, enrollmentId: f.activity.enrollmentId },
        submissionId: f.attempt.submissionId,
        workbookActivityId: f.activity.id,
      });
      const handler = handlers.find((h) => h.id.endsWith('review-submission'))!;
      expect(handler.argsSchema.required).toContain('questions');
      const sources = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(f.request),
      );
      const args = {
        submissionId: f.attempt.submissionId,
        score: 0,
        feedback: f.assessment.feedback,
        questions: f.assessment.questions.map((q) => ({
          ...q,
          anchors: [
            { evidenceId: 'original-evidence', page: 1, rect: [0, 0, 1, 1] },
          ],
        })),
      };
      let attemptId = 'generation-one';
      const snapshot = () => ({
        attemptId,
        inputDigest: 'a'.repeat(64),
        configuration: { stage: 'interpret' },
        evidence: [
          {
            id: 'original-evidence',
            parentEvidenceId: null,
            partId: 'one',
            contentHash: sources[0].sha256,
          },
        ],
        result: {
          status: 'completed',
          output: {
            proposals: {
              version: 1,
              outcome: 'proposals',
              suggestions: [{ handlerId: handler.id, args, missingFields: [] }],
              offered: [{ handler }],
              provenance: {
                generative: {
                  provider: 'configured-provider',
                  model: 'configured-model',
                },
                configurationVersion: 'v1',
                promptVersion: 'rubric-v1',
              },
            },
          },
        },
      });
      let state: 'completed' | 'pending' | 'failed' = 'pending';
      const ingestion = {
        getCompletedAnalysis: async () => {
          if (state === 'pending') throw new Error('Analysis unavailable');
          const value = snapshot();
          if (state === 'failed') value.result.status = 'failed';
          return value;
        },
      } as unknown as Parameters<
        typeof preserveWorkbookIntakeAnalysis
      >[0]['ingestion'];
      const input = {
        ingestion,
        workbooks: f.service,
        request: { ...f.own, enrollmentId: f.activity.enrollmentId },
        activityId: f.activity.id,
        submissionId: f.attempt.submissionId,
      };
      await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input));
      state = 'failed';
      await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input));
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getWorkbookTimeline({
              ...f.parent,
              activityId: f.activity.id,
            }),
          )
        ).attempts[0].revisions,
      ).toHaveLength(0);
      state = 'completed';
      args.questions[0].result = 'unassessed';
      args.questions[0].reason = 'illegible';
      await expect(
        f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).rejects.toThrow('not zero');
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getWorkbookTimeline({
              ...f.parent,
              activityId: f.activity.id,
            }),
          )
        ).attempts[0].revisions,
      ).toHaveLength(0);
      args.questions[0].result = 'incorrect';
      args.questions[0].reason = 'none';
      await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input));
      await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input));
      attemptId = 'generation-two';
      await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input));
      const timeline = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.parent,
          activityId: f.activity.id,
        }),
      );
      expect(timeline.attempts).toHaveLength(1);
      expect(timeline.attempts[0].revisions).toHaveLength(2);
      expect(
        timeline.attempts[0].revisions[0].assessment.questions[0].anchors[0]
          .assetId,
      ).toBe(sources[0].assetId);
      expect(
        timeline.attempts[0].revisions[0].assessment.provenance.provider,
      ).toBe('configured-provider');
      args.questions[0].anchors[0].evidenceId = 'foreign-evidence';
      attemptId = 'generation-three';
      await expect(
        f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).rejects.toThrow('captured original');
    } finally {
      await f.close();
    }
  });
  it('denies sibling and foreign activity operations and preserves executor affinity', async () => {
    const f = await fixture();
    try {
      const sibling = {
        ...f.own,
        actorUserId: String(f.bob.user.id),
        learnerId: String(f.sibling.id),
      };
      const foreign = {
        tenantId: String(f.foreign.tenantId),
        actorUserId: String(f.stranger.user.id),
        learnerId: String(f.foreign.id),
      };
      for (const actor of [sibling, foreign]) {
        await expect(
          f.as(actor, () =>
            f.service.getWorkbookTimeline({
              ...actor,
              activityId: f.activity.id,
            }),
          ),
        ).rejects.toThrow('authorized');
        await expect(
          f.as(actor, () =>
            f.service.captureWorkbookWork({
              ...f.capture,
              ...actor,
              requestKey: 'denied',
            }),
          ),
        ).rejects.toThrow('authorized');
        await expect(
          f.as(actor, () =>
            f.service.releaseWorkbookFeedback({
              ...f.request,
              ...actor,
              revisionId: 'foreign',
              expectedHeadId: null,
              requestKey: 'denied',
            }),
          ),
        ).rejects.toThrow('authorized');
        await expect(
          f.as(actor, () =>
            f.service.getConceptEvidenceSummary({
              ...actor,
              activityId: f.activity.id,
            }),
          ),
        ).rejects.toThrow('authorized');
        await expect(
          f.as(actor, () =>
            f.service.acknowledgeWorkbookFeedbackDelivery({
              ...f.request,
              ...actor,
              revisionId: 'foreign',
              requestKey: 'denied',
            }),
          ),
        ).rejects.toThrow('authorized');
      }
      const executors = new Set<DatabaseInterface>();
      const service = new WorkbookService(
        f.db,
        ({ executor, own, relationshipTypeId }) => {
          executors.add(executor);
          return own || relationshipTypeId === f.guardianType.id;
        },
        () => true,
        { storage: 'unused' },
      );
      await f.as(f.parent, () =>
        service.withExecutor(f.db, (s) =>
          s.getWorkbookTimeline({ ...f.parent, activityId: f.activity.id }),
        ),
      );
      expect([...executors]).toEqual([f.db]);
    } finally {
      await f.close();
    }
  });
}
