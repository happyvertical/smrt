import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import {
  GenerationSnapshotStaleError,
  IngestionService,
} from '@happyvertical/smrt-ingestion/server';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import {
  captureEducationIntake,
  educationIntakeHandlers,
  educationIntakeTargetResolver,
  preserveWorkbookIntakeAnalysis,
} from '../ingestion.js';
import {
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
} from '../workbook-contracts.js';
import { WorkbookAssessmentRevisionCollection } from '../workbook-models.js';
import { WorkbookService } from '../workbook-service.js';
import { ingestionClasses } from './ingestion-workflows.js';
import { learnerFixture } from './learner-workflows.js';

export const workbookClasses = [
  ...ingestionClasses,
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
    storage,
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
        { ...f.assessment.questions[0], result: 'correct', points: 0 },
        {
          ...f.assessment.questions[0],
          result: 'incorrect',
          reason: 'unsupported',
        },
        {
          ...f.assessment.questions[0],
          result: 'partially_correct',
          points: 1,
        },
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
      await expect(
        f.as(f.own, () =>
          f.service.recordWorkbookAnalysis({
            ...f.request,
            ...f.own,
            requestKey: 'overflow',
            assessment: {
              ...f.assessment,
              questions: ['q1', 'q2'].map((id) => ({
                ...f.assessment.questions[0],
                id,
                result: 'correct',
                points: 1e308,
                possiblePoints: 1e308,
              })),
            },
          }),
        ),
      ).rejects.toThrow('finite range');
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
      const processingRevision = () =>
        attemptId === 'generation-one'
          ? 2
          : attemptId === 'generation-two'
            ? 4
            : 6;
      const snapshot = () => ({
        attemptId,
        revision: processingRevision(),
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
        getItem: async () => ({ analysisRevision: processingRevision() }),
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
      expect(
        await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).toEqual({ kind: 'needs_review', reason: 'invalid_assessment' });
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
      expect(
        await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).toEqual({ kind: 'needs_review', reason: 'ungrounded_source' });
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
            f.service.getWorkbookPreservationState({ ...f.request, ...actor }),
          ),
        ).rejects.toThrow('authorized');
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
  it('rejects actual bad provider-shaped marks, derives exact totals, and discards invented geometry', async () => {
    const f = await fixture();
    try {
      const handler = educationIntakeHandlers({
        submissions: f.service,
        request: { ...f.own, enrollmentId: f.activity.enrollmentId },
        submissionId: f.attempt.submissionId,
        workbookActivityId: f.activity.id,
      }).find((h) => h.id.endsWith('review-submission'))!;
      const properties = handler.argsSchema.properties as Record<
        string,
        unknown
      >;
      expect(properties.score).toBeUndefined();
      expect(properties.feedback).toBeUndefined();
      const questionSchema = properties.questions as {
        items: {
          oneOf: unknown[];
          properties: {
            anchors: { items: { properties: Record<string, unknown> } };
          };
        };
      };
      expect(questionSchema.items.oneOf).toHaveLength(2);
      expect(
        questionSchema.items.properties.anchors.items.properties.rect,
      ).toBeUndefined();
      const sources = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(f.request),
      );
      const rawQuestions = [
        {
          id: 'q1',
          prompt: '2 + 3',
          answer: '5',
          result: 'correct',
          reason: 'none',
          points: 1,
        },
        {
          id: 'q2',
          prompt: '7 - 4',
          answer: '2',
          result: 'incorrect',
          reason: 'unsupported',
          points: 0,
        },
        {
          id: 'q3',
          prompt: '3 x 4',
          answer: '12',
          result: 'correct',
          reason: 'none',
          points: 1,
        },
        {
          id: 'q4',
          prompt: '12 / 3',
          answer: '5',
          result: 'incorrect',
          reason: 'unsupported',
          points: 0,
        },
      ].map((q, index) => ({
        ...q,
        possiblePoints: 1,
        feedback: 'Question-specific explanation',
        conceptIds: [],
        markingCertainty: 'clear',
        mappingCertainty: 'unknown',
        evidenceLimitations: [],
        anchors: [
          {
            evidenceId: 'original',
            page: 1,
            rect: [0, index / 10, 1, (index + 1) / 10],
          },
        ],
      }));
      const args = {
        submissionId: f.attempt.submissionId,
        questions: rawQuestions,
        score: 0.75,
        feedback: 'Three answers are correct; 0.5 rounded to 0.75.',
      };
      let mediaType = 'image/png';
      let id = 'bad-generation';
      const currentRevision = () =>
        id === 'bad-generation' ? 2 : id === 'valid-generation' ? 4 : 6;
      const ingestion = {
        getItem: async () => ({ analysisRevision: currentRevision() }),
        getCompletedAnalysis: async () => ({
          attemptId: id,
          revision: currentRevision(),
          inputDigest: 'b'.repeat(64),
          configuration: {
            stage: 'interpret',
            educationEvidenceGrounding: {
              version: 1,
              extractionAttemptId: 'extract',
              sources: [
                {
                  evidenceId: 'original',
                  sha256: sources[0].sha256,
                  pages: [],
                },
              ],
            },
          },
          evidence: [
            {
              id: 'original',
              partId: 'one',
              parentEvidenceId: null,
              contentHash: sources[0].sha256,
              mediaType,
            },
          ],
          result: {
            status: 'completed',
            output: {
              proposals: {
                version: 1,
                outcome: 'proposals',
                source: {
                  attemptId: 'extract',
                  revision: 1,
                  inputDigest: 'c'.repeat(64),
                  outputDigest: 'd'.repeat(64),
                  evidenceDigest: 'e'.repeat(64),
                },
                suggestions: [
                  { handlerId: handler.id, args, missingFields: [] },
                ],
                offered: [{ handler }],
                provenance: {
                  generative: {
                    provider: 'provider',
                    model: 'model',
                    version: '1',
                  },
                  configurationVersion: '1',
                  promptVersion: '1',
                },
              },
            },
          },
        }),
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
      expect(
        await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).toEqual({ kind: 'needs_review', reason: 'invalid_assessment' });
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
      rawQuestions[1].reason = 'none';
      rawQuestions[3].reason = 'none';
      id = 'valid-generation';
      const result = await f.as(f.own, () =>
        preserveWorkbookIntakeAnalysis(input),
      );
      expect(result.kind).toBe('preserved');
      const timeline = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.parent,
          activityId: f.activity.id,
        }),
      );
      const assessment = timeline.attempts[0].revisions[0].assessment;
      expect(assessment.aggregate).toMatchObject({
        correct: 2,
        incorrect: 2,
        points: 2,
        possiblePoints: 4,
        score: 0.5,
      });
      expect(assessment.feedback).toBe(
        '2 correct; 2 incorrect; 0 partially correct; 0 unassessed.',
      );
      for (const q of assessment.questions) {
        expect(q.anchors[0]).toMatchObject({
          page: 1,
          grounding: 'source',
          rect: [0, 0, 1, 1],
        });
        expect(q.evidenceLimitations?.join(' ')).toContain('Source-level');
      }
      const parentFeedback = 'Please practise subtraction with me after lunch.';
      const reviewed = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: timeline.attempts[0].revisions[0].id,
          expectedHeadId: null,
          requestKey: 'review-exact',
          assessment: { ...assessment, feedback: parentFeedback },
        }),
      );
      expect(reviewed.assessment.feedback).toBe(parentFeedback);
      expect(reviewed.assessment.aggregate?.score).toBe(0.5);

      expect(
        (
          await f.as(f.parent, () =>
            f.service.getSubmission({
              ...f.parent,
              enrollmentId: f.activity.enrollmentId,
              submissionId: f.attempt.submissionId,
            }),
          )
        ).grade?.score,
      ).toBe(0.5);
      mediaType = 'application/pdf';
      id = 'pdf-source-only';
      expect(
        (await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input))).kind,
      ).toBe('preserved');
      const pdf = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.parent,
          activityId: f.activity.id,
        }),
      );
      expect(
        pdf.attempts[0].revisions[0].assessment.questions[0].anchors[0],
      ).toMatchObject({ page: null, grounding: 'source', rect: [0, 0, 1, 1] });
    } finally {
      await f.close();
    }
  });
  it('validates evidence-only wire JSON and keeps public ingestion workbook history after review and expiry', async () => {
    const f = await fixture();
    try {
      await f.as(f.parent, async () => {
        const activity = await f.service.resolveWorkbookActivity({
          ...f.create,
          pageKey: 'wire:p1',
          pageLabel: 'Wire page',
        });
        const scope = {
          tenantId: f.parent.tenantId,
          actorId: f.parent.actorUserId,
          confidentialScopeId: activity.enrollmentId,
        };
        const assets = await createAssetRuntime({
          db: f.db,
          storage: f.storage,
        });
        const handlerId = '@happyvertical/smrt-education:review-submission';
        const operation = '@happyvertical/smrt-education:Grade:create@1';
        const principalId = '22222222-2222-4222-8222-222222222222';
        const options = {
          db: f.db,
          assets,
          scope,
          authorize: async () => true,
          jobTarget: { objectType: 'unused-worker', method: 'process' },
          purgeDerived: async () => {},
        };
        const uploader = new IngestionService(options);
        const receipt = await uploader.receive({
          sourceId: 'wire',
          sourceVersion: '1',
          deliveryKey: 'evidence-only',
          deliveredAt: new Date(),
          parts: [
            {
              partId: 'page',
              mediaType: 'image/png',
              bytes: Buffer.from('synthetic wire page'),
            },
          ],
          capturedCeiling: {
            execution: {
              principalId,
              permissions: ['grades.create'],
              handlers: [handlerId],
              operations: [operation],
            },
          },
          retention: {
            version: '1',
            expiresAt: new Date(Date.now() + 3600000),
            replayUntil: new Date(Date.now() + 7200000),
            acceptAfter: new Date(Date.now() - 3600000),
          },
          limits: {
            maxBytes: 100000,
            maxParts: 10,
            maxAttempts: 3,
            leaseMs: 10000,
            maxOutputBytes: 100000,
          },
        });
        if (!('itemId' in receipt)) throw new Error('Missing receipt');
        const request = {
          ...f.parent,
          enrollmentId: activity.enrollmentId,
          lessonId: activity.lessonId,
        };
        const submission = await captureEducationIntake({
          ingestion: uploader,
          scope,
          submissions: f.service,
          request: {
            ...request,
            workbookActivityId: activity.id,
            itemId: receipt.itemId,
            kind: 'completed_work',
          },
        });
        const handlers = educationIntakeHandlers({
          submissions: f.service,
          request,
          submissionId: submission.id,
          workbookActivityId: activity.id,
        });
        const ingestion = new IngestionService({
          ...options,
          proposals: {
            version: 'retention-test',
            promptVersion: 'retention-test',
            generator: {
              identity: { provider: 'fixture', model: 'fixture', version: '1' },
              generate: async (input) => ({
                completion: 'complete',
                output: {
                  outcome: 'proposals',
                  suggestions: [
                    {
                      handlerId,
                      handlerVersion: '1',
                      args: {
                        ...args,
                        submissionId: input.offered.find(
                          (entry) => entry.handler.id === handlerId,
                        )?.candidates[0].id,
                      },
                      evidence: [
                        {
                          evidenceId: input.evidence[0].evidenceId,
                          location: { kind: 'source' },
                        },
                      ],
                      alternatives: [],
                      missingFields: [],
                      explanation: 'Synthetic evidence',
                    },
                  ],
                  splits: [],
                },
              }),
            },
            limits: {
              maxHandlers: 10,
              maxCandidates: 10,
              maxSuggestions: 10,
              maxInputBytes: 100000,
              maxOutputBytes: 100000,
              maxQueryLength: 1000,
              timeoutMs: 10000,
            },
          },
          execution: {
            handlers,
            authorize: async () => ({
              allowed: true,
              reviewer: true,
              principalId,
              permissions: ['grades.create'],
              mutationBoundary: 'serialized' as const,
              policy: [
                {
                  version: 'app',
                  providers: ['fixture'],
                  handlers: [handlerId],
                  operations: [operation],
                  reviewers: [f.parent.actorUserId],
                  access: [activity.enrollmentId],
                  requireReview: true,
                },
                { version: 'tenant' },
                { version: 'source' },
              ],
            }),
            assertTarget: educationIntakeTargetResolver({
              submissions: f.service,
              request,
              submissionId: submission.id,
            }),
          },
        });
        const analysis = await ingestion.analyze(
          receipt.itemId,
          { version: 'wire' },
          'wire-analysis',
        );
        const lease = await ingestion.claimAnalysis(
          receipt.itemId,
          analysis.revision,
          'test-worker',
        );
        if (!lease) throw new Error('Missing lease');
        await ingestion.completeAnalysis(lease, {
          status: 'completed',
          provider: 'fixture',
          model: 'fixture',
          version: '1',
          output: {},
          usage: {},
        });
        const evidence = (await ingestion.getEvidence(receipt.itemId))[0];
        const args = JSON.parse(
          JSON.stringify({
            submissionId: submission.id,
            questions: [
              {
                id: 'q1',
                prompt: '2 + 3',
                answer: '5',
                result: 'correct',
                reason: 'none',
                feedback: 'Correct',
                points: 1,
                possiblePoints: 1,
                anchors: [{ evidenceId: evidence.id }],
                conceptIds: [],
                markingCertainty: 'clear',
                mappingCertainty: 'unknown',
                evidenceLimitations: [],
              },
            ],
          }),
        );
        const preview = async (key: string, payload: typeof args) => {
          const actionId = await ingestion.createAction(
            receipt.itemId,
            'wire',
            { key },
          );
          return ingestion.previewProposal({
            itemId: receipt.itemId,
            attemptId: lease.attemptId,
            actionId,
            expectedRevision: 0,
            requestId: key,
            handlerId,
            handlerVersion: '1',
            args: payload,
          });
        };
        expect((await preview('evidence-only', args)).revision).toBeGreaterThan(
          0,
        );
        const invalidReason = structuredClone(args);
        invalidReason.questions[0].reason = 'unsupported';
        await expect(
          preview('invalid-reason', invalidReason),
        ).rejects.toThrow();
        const extraPage = structuredClone(args);
        extraPage.questions[0].anchors[0].page = 0;
        await expect(preview('no-page-selector', extraPage)).rejects.toThrow();
        let generationNumber = 0;
        const generate = async () => {
          generationNumber++;
          const extraction = await ingestion.analyze(
            receipt.itemId,
            { stage: 'extract', extraction: { configurationRevision: '1' } },
            `retention-extraction-${generationNumber}`,
          );
          const extractionLease = await ingestion.claimAnalysis(
            receipt.itemId,
            extraction.revision,
            'worker',
          );
          if (!extractionLease) throw new Error('Missing extraction lease');
          await ingestion.completeAnalysis(extractionLease, {
            status: 'completed',
            provider: 'smrt-ingestion-extraction',
            model: 'none',
            version: '1',
            usage: {},
            output: {
              configurationRevision: '1',
              results: [
                {
                  evidence,
                  configurationRevision: '1',
                  status: 'complete',
                  segments: [
                    {
                      text: '2 + 3 = 5',
                      location: { kind: 'source' },
                      boxes: null,
                    },
                  ],
                  capabilities: [{ location: 'source', boxes: false }],
                },
              ],
            },
          });
          const generationConfig = await ingestion.prepareGeneration(
            receipt.itemId,
            extractionLease.attemptId,
          );
          const generation = await ingestion.analyze(
            receipt.itemId,
            generationConfig,
            `retention-generation-${generationNumber}`,
          );
          const generationLease = await ingestion.claimAnalysis(
            receipt.itemId,
            generation.revision,
            'worker',
          );
          if (!generationLease) throw new Error('Missing generation lease');
          await ingestion.generateProposals(generationLease);
          return {
            revision: generation.revision,
            attemptId: generationLease.attemptId,
          };
        };
        const generation = await generate();
        const preservation = {
          ingestion,
          workbooks: f.service,
          request,
          activityId: activity.id,
          submissionId: submission.id,
        };
        const imported = await preserveWorkbookIntakeAnalysis(preservation);
        expect(imported.kind).toBe('preserved');
        if (imported.kind !== 'preserved')
          throw new Error('Expected preserved analysis');
        const saved = await f.service.getWorkbookPreservationState({
          ...request,
          activityId: activity.id,
          submissionId: submission.id,
        });
        expect(saved.retainedAnalyses[0]).toMatchObject({
          analysisRevision: generation.revision,
          analysisAttemptId: generation.attemptId,
        });
        const reviewed = await f.service.reviewWorkbookAssessment({
          ...request,
          activityId: activity.id,
          submissionId: submission.id,
          revisionId: imported.revisionId,
          expectedHeadId: null,
          requestKey: 'retention-review',
        });
        await expect(
          ingestion.getCompletedAnalysis(receipt.itemId),
        ).rejects.toBeInstanceOf(GenerationSnapshotStaleError);
        expect((await preserveWorkbookIntakeAnalysis(preservation)).kind).toBe(
          'retained',
        );
        const withheld = await f.as(f.own, () =>
          f.service.getWorkbookTimeline({ ...f.own, activityId: activity.id }),
        );
        expect(withheld.attempts[0].revisions).toHaveLength(0);
        await f.service.releaseWorkbookFeedback({
          ...request,
          activityId: activity.id,
          submissionId: submission.id,
          revisionId: reviewed.id,
          expectedHeadId: reviewed.id,
          requestKey: 'retention-release',
        });
        // A genuinely new interpretation is still imported as provisional.
        await generate();
        expect((await preserveWorkbookIntakeAnalysis(preservation)).kind).toBe(
          'preserved',
        );
        await f.service.captureWorkbookWork({
          ...request,
          activityId: activity.id,
          requestKey: 'retention-correction',
          previousSubmissionId: submission.id,
          pages: [
            {
              name: 'correction.png',
              mimeType: 'image/png',
              data: Buffer.from('correction'),
            },
          ],
        });
        expect((await preserveWorkbookIntakeAnalysis(preservation)).kind).toBe(
          'retained',
        );
        await ingestion.expire(receipt.itemId);
        expect((await preserveWorkbookIntakeAnalysis(preservation)).kind).toBe(
          'retained',
        );
        const durable = await f.service.getWorkbookTimeline({
          ...request,
          activityId: activity.id,
        });
        expect(durable.attempts).toHaveLength(2);
        const child = await f.as(f.own, () =>
          f.service.getWorkbookTimeline({ ...f.own, activityId: activity.id }),
        );
        expect(
          child.attempts.flatMap((a) => a.revisions).map((r) => r.id),
        ).toEqual([reviewed.id]);
      });
    } finally {
      await f.close();
    }
  });
  it('keeps nested workbook guardian review and catalog callbacks on the same executor', async () => {
    const f = await fixture();
    try {
      const proposal = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'executor-proposal',
          assessment: f.assessment,
        }),
      );
      const learnerExecutors = new Set<DatabaseInterface>();
      const catalogExecutors = new Set<DatabaseInterface>();
      const service = new WorkbookService(
        f.db,
        ({ executor, own, relationshipTypeId }) => {
          learnerExecutors.add(executor);
          return own || relationshipTypeId === f.guardianType.id;
        },
        ({ executor }) => {
          catalogExecutors.add(executor);
          expect(learnerExecutors.has(executor)).toBe(true);
          return true;
        },
        { storage: f.storage },
      );
      const reviewed = await f.as(f.parent, () =>
        service.withTransaction((scoped) =>
          scoped.reviewWorkbookAssessment({
            ...f.request,
            revisionId: proposal.id,
            expectedHeadId: null,
            requestKey: 'executor-review',
          }),
        ),
      );
      expect(reviewed.kind).toBe('guardian');
      expect(learnerExecutors.size).toBe(1);
      expect(catalogExecutors.size).toBe(1);
      expect([...catalogExecutors]).toEqual([...learnerExecutors]);
    } finally {
      await f.close();
    }
  });
  it('keeps legacy retained history when scratch is stale and rejects novel stale reanalysis', async () => {
    const f = await fixture();
    try {
      const legacy = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'legacy',
          assessment: f.assessment,
        }),
      );
      let mode: 'stale' | 'unavailable' | 'db' = 'stale';
      let currentRevision = 2;
      const ingestion = {
        getItem: async () => ({ analysisRevision: currentRevision }),
        getCompletedAnalysis: async () => {
          if (mode === 'stale') throw new GenerationSnapshotStaleError();
          if (mode === 'unavailable') throw new Error('Intake unavailable');
          throw new Error('database offline');
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
      expect(
        await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).toEqual({ kind: 'retained', revisionId: legacy.id });
      mode = 'unavailable';
      expect(
        (await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input))).kind,
      ).toBe('retained');
      mode = 'db';
      await expect(
        f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).rejects.toThrow('database offline');
      mode = 'stale';
      currentRevision = 4;
      await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'modern',
          assessment: {
            ...f.assessment,
            provenance: {
              ...f.assessment.provenance,
              analysisId: 'modern-attempt',
              analysisRevision: 2,
            },
          },
        }),
      );
      expect(
        await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input)),
      ).toEqual({ kind: 'needs_review', reason: 'stale_analysis' });

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
    } finally {
      await f.close();
    }
  });
}
