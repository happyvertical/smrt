import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import {
  GenerationSnapshotStaleError,
  IngestionService,
  ProposalsNotConfiguredError,
} from '@happyvertical/smrt-ingestion/server';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import { GradeCollection, SubmissionCollection } from '../collections.js';
import {
  captureEducationIntake,
  educationIntakeHandlers,
  educationIntakeTargetResolver,
  preserveWorkbookIntakeAnalysis,
} from '../ingestion.js';
import { LearnerService } from '../learner-service.js';
import { SubmissionService } from '../submission-service.js';
import {
  validateWorkbookAssessment,
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
} from '../workbook-contracts.js';
import { WorkbookAssessmentRevisionCollection } from '../workbook-models.js';
import { WorkbookService } from '../workbook-service.js';
import { ingestionClasses } from './ingestion-workflows.js';
import { learnerFixture } from './learner-workflows.js';

export const workbookClasses = [
  ...ingestionClasses,
  // Public receipt expiry uses normal Asset cascades into these incoming joins.
  'AssetTag',
  'ProfileAsset',
  'Tag',
  'Workbook',
  'WorkbookActivity',
  'WorkbookWorkFiling',
  'WorkbookPhotoIntake',
  'WorkbookPhotoAsset',
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
  it.each([
    true,
    false,
  ])('keeps workbook authority private across base APIs and rejects legacy forks (review gate %s)', async (reviewRequired) => {
    const f = await fixture();
    try {
      let target = f.attempt;
      let capture = f.capture;
      if (!reviewRequired) {
        await f.as(f.parent, () =>
          f.service.setWorkbookFeedbackPolicy({
            ...f.parent,
            activityId: f.activity.id,
            expectedPolicyVersion: 1,
            reviewRequired: false,
          }),
        );
        capture = {
          ...f.capture,
          requestKey: 'direct-correction',
          intakeItemId: 'direct-intake',
          pages: [{ ...f.capture.pages[0], data: Buffer.from('direct-work') }],
        };
        target = await f.as(f.own, () =>
          f.service.captureWorkbookWork({
            ...capture,
            previousSubmissionId: f.attempt.submissionId,
          }),
        );
      }
      const req = { ...f.request, submissionId: target.submissionId };
      const [source] = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(req),
      );
      const assessment = {
        ...f.assessment,
        questions: f.assessment.questions.map((q) => ({
          ...q,
          anchors: [
            {
              ...source,
              page: 1,
              rect: [0, 0, 1, 1] as [number, number, number, number],
            },
          ],
        })),
      };
      const ai = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...req,
          ...f.own,
          requestKey: 'privacy-ai',
          assessment,
        }),
      );
      const decision = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...req,
          revisionId: ai.id,
          expectedHeadId: null,
          requestKey: 'privacy-review',
          assessment: { ...assessment, feedback: 'Unreleased guardian detail' },
        }),
      );
      const authorize = ({
        own,
        relationshipTypeId,
      }: Parameters<import('../learner-service.js').LearnerAuthorizer>[0]) =>
        own || relationshipTypeId === f.guardianType.id;
      const plain = new SubmissionService(f.db, authorize, () => true, {
        storage: f.storage,
      });
      const learnerOnly = new LearnerService(f.db, authorize, () => true);
      const scope = { ...f.own, enrollmentId: f.activity.enrollmentId };
      const beforeSubmissions = await f.as(f.own, async () =>
        (await SubmissionCollection.create({ db: f.db })).list({
          where: {
            tenantId: f.own.tenantId,
            progressId: target.submission.progressId,
          },
        }),
      );
      const beforeGrades = await f.as(f.parent, async () =>
        (await GradeCollection.create({ db: f.db })).list({
          where: {
            tenantId: f.parent.tenantId,
            submissionId: target.submissionId,
          },
        }),
      );
      for (const service of [plain, f.service]) {
        const ownView = await f.as(f.own, () =>
          service.getSubmission({
            ...scope,
            submissionId: target.submissionId,
          }),
        );
        expect(ownView.grade).toBeNull();
        expect(ownView.status).toBe('captured');
        expect(
          (
            await f.as(f.parent, () =>
              service.getSubmission({
                ...scope,
                ...f.parent,
                submissionId: target.submissionId,
              }),
            )
          ).grade?.feedback,
        ).toBe('Unreleased guardian detail');
        await expect(
          f.as(f.own, () =>
            service.captureSubmission({
              ...scope,
              lessonId: f.activity.lessonId,
              requestKey: capture.requestKey,
              pages: capture.pages,
              intake: {
                intakeItemId: capture.intakeItemId,
                kind: 'completed_work',
                ...(target.submission.previousSubmissionId
                  ? {
                      previousSubmissionId:
                        target.submission.previousSubmissionId,
                    }
                  : {}),
              },
            }),
          ),
        ).rejects.toThrow('Workbook workflow required');
        await expect(
          f.as(f.own, () =>
            service.resubmitSubmission({
              ...scope,
              lessonId: f.activity.lessonId,
              requestKey: 'legacy-fork',
              pages: capture.pages,
              intakeItemId: 'legacy-fork',
              previousSubmissionId: target.submissionId,
            }),
          ),
        ).rejects.toThrow('Workbook workflow required');
        await expect(
          f.as(f.own, () =>
            service.assertNonWorkbookSubmissionScope({
              ...scope,
              lessonId: f.activity.lessonId,
              previousSubmissionId: target.submissionId,
            }),
          ),
        ).rejects.toThrow('Workbook workflow required');
      }
      for (const service of [learnerOnly, plain, f.service]) {
        const progress = (
          await f.as(f.own, () => service.listProgress(scope))
        ).find((row) => row.lessonId === f.activity.lessonId)!;
        expect(progress).toMatchObject({
          bestScore: null,
          status: 'submitted',
          completedAt: null,
        });
        const assignment = (
          await f.as(f.own, () => service.assignmentLessons(scope))
        ).find((row) => row.lesson.id === f.activity.lessonId)!;
        expect(assignment.progress).toMatchObject({
          bestScore: null,
          status: 'submitted',
          completedAt: null,
        });
        expect(
          await f.as(f.own, () =>
            service.startLesson({ ...scope, lessonId: f.activity.lessonId }),
          ),
        ).toMatchObject({
          bestScore: null,
          status: 'submitted',
          completedAt: null,
        });
        expect(
          (await f.as(f.own, () => service.nextLessons(scope)))[0].progress,
        ).toMatchObject({
          bestScore: null,
          status: 'submitted',
          completedAt: null,
        });
        expect(
          (
            await f.as(f.parent, () =>
              service.listProgress({ ...scope, ...f.parent }),
            )
          )[0],
        ).toMatchObject({ bestScore: 0, status: 'complete' });
      }
      const retry = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...capture,
          ...(target.submission.previousSubmissionId
            ? { previousSubmissionId: target.submission.previousSubmissionId }
            : {}),
        }),
      );
      expect(retry.id).toBe(target.id);
      expect(retry.submission.grade).toBeNull();
      expect(retry.submission.status).toBe('captured');
      const afterSubmissions = await f.as(f.own, async () =>
        (await SubmissionCollection.create({ db: f.db })).list({
          where: {
            tenantId: f.own.tenantId,
            progressId: target.submission.progressId,
          },
        }),
      );
      const afterGrades = await f.as(f.parent, async () =>
        (await GradeCollection.create({ db: f.db })).list({
          where: {
            tenantId: f.parent.tenantId,
            submissionId: target.submissionId,
          },
        }),
      );
      expect(afterSubmissions.map((row) => row.id)).toEqual(
        beforeSubmissions.map((row) => row.id),
      );
      expect(afterGrades.map((row) => row.id)).toEqual(
        beforeGrades.map((row) => row.id),
      );
      expect(
        (
          await f.as(f.own, () =>
            f.service.getWorkbookTimeline({
              ...f.own,
              activityId: f.activity.id,
            }),
          )
        ).attempts
          .find((attempt) => attempt.id === target.id)!
          .revisions.some((revision) => revision.id === decision.id),
      ).toBe(false);
      const corrected = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          requestKey: 'proper-correction',
          intakeItemId: 'proper-correction',
          pages: [
            { ...f.capture.pages[0], data: Buffer.from('proper-correction') },
          ],
          previousSubmissionId: target.submissionId,
        }),
      );
      expect(corrected.episodeId).toBe(target.episodeId);
    } finally {
      await f.close();
    }
  });

  it('preserves ordinary non-workbook submission and progress projections', async () => {
    const f = await fixture();
    try {
      const service = new SubmissionService(
        f.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === f.guardianType.id,
        () => true,
        { storage: f.storage },
      );
      const scope = {
        ...f.own,
        enrollmentId: f.enrollment.id,
        lessonId: String(f.lesson.id),
        requestKey: 'ordinary',
        pages: f.capture.pages,
      };
      const submission = await f.as(f.own, () =>
        service.captureSubmission(scope),
      );
      await f.as(f.parent, () =>
        service.reviewSubmission({
          ...f.parent,
          enrollmentId: f.enrollment.id,
          submissionId: submission.id,
          score: 0.5,
          feedback: 'Ordinary visible feedback',
        }),
      );
      expect(
        (await f.as(f.own, () => service.captureSubmission(scope))).grade,
      ).toMatchObject({ score: 0.5, feedback: 'Ordinary visible feedback' });
      expect(
        (
          await f.as(f.own, () =>
            service.listProgress({ ...f.own, enrollmentId: f.enrollment.id }),
          )
        )[0],
      ).toMatchObject({ bestScore: 0.5, status: 'complete' });
    } finally {
      await f.close();
    }
  });

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
  it('retains objective correctness without point weights and refuses the real mixed-null marking shape', async () => {
    const f = await fixture();
    try {
      const assessment: WorkbookAssessment = {
        ...f.assessment,
        questions: [
          { prompt: '2 + 3', answer: '5', result: 'correct' as const },
          { prompt: '3 + 4', answer: '7', result: 'correct' as const },
          { prompt: '4 + 5', answer: '8', result: 'incorrect' as const },
          { prompt: '5 + 6', answer: '10', result: 'incorrect' as const },
        ].map((question, index) => ({
          ...f.assessment.questions[0],
          ...question,
          id: `p7:q${index + 1}`,
          points: null,
          possiblePoints: null,
          markingCertainty: 'clear',
        })),
      };
      const malformed = structuredClone(assessment);
      // Actual provider output: incorrect0 paired with unknown possible points.
      malformed.questions[2].points = 0;
      await expect(
        f.as(f.own, () =>
          f.service.recordWorkbookAnalysis({
            ...f.request,
            ...f.own,
            requestKey: 'mixed-null-provider-shape',
            assessment: malformed,
          }),
        ),
      ).rejects.toThrow('Invalid question points');
      expect(
        await f.as(f.own, async () =>
          (
            await WorkbookAssessmentRevisionCollection.create({ db: f.db })
          ).list({
            where: { tenantId: f.own.tenantId, learnerId: f.own.learnerId },
          }),
        ),
      ).toHaveLength(0);
      const revision = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'unscored-correctness',
          assessment,
        }),
      );
      expect(revision.assessment.aggregate).toMatchObject({
        correct: 2,
        incorrect: 2,
        unassessed: 0,
        points: null,
        possiblePoints: null,
        score: null,
      });
      expect(
        revision.assessment.questions.every(
          (question) =>
            question.points === null && question.possiblePoints === null,
        ),
      ).toBe(true);
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
      expect(
        (
          await f.as(f.own, () =>
            f.service.getWorkbookSourceAnchors({ ...f.request, ...f.own }),
          )
        ).map((source) => source.sha256),
      ).toEqual(assessment.questions[0].anchors.map((source) => source.sha256));
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
      ).toEqual([{ id: 'p7:q1' }]);
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
  it('assesses unnumbered visible tasks without weakening stable correction identities', async () => {
    const f = await fixture();
    try {
      const offered = async (submissionId: string) => {
        const handler = educationIntakeHandlers({
          submissions: f.service,
          request: { ...f.own, enrollmentId: f.activity.enrollmentId },
          submissionId,
          workbookActivityId: f.activity.id,
        }).find((h) => h.id.endsWith('review-submission'));
        if (!handler?.discovery?.candidates)
          throw new Error('No review discovery');
        const candidates = await f.as(f.own, () =>
          handler.discovery!.candidates!(
            '',
            {
              db: f.db,
              scope: { tenantId: f.own.tenantId, actorId: f.own.actorUserId },
              policy: { requireReview: true },
            } as unknown as Parameters<
              NonNullable<NonNullable<typeof handler.discovery>['candidates']>
            >[1],
            { limit: 100 },
          ),
        );
        return { handler, label: JSON.stringify(candidates.items[0].context) };
      };
      const initial = await offered(f.attempt.submissionId);
      expect(initial.label).toContain('identity_only');
      expect(initial.label).toContain('"questions":[]');
      expect(initial.handler.description.toLowerCase()).toContain('unnumbered');
      expect(initial.handler.description).toContain('output-array position');
      const base = f.assessment.questions[0];
      const assessment: WorkbookAssessment = {
        ...structuredClone(f.assessment),
        provenance: {
          ...f.assessment.provenance,
          analysisId: 'unnumbered-visible',
        },
        questions: [
          { ...base, id: 'q1', points: null, possiblePoints: null },
          {
            ...base,
            id: 'u:match-seventy-five-cents:1',
            prompt: 'Match seventy-five cents',
            answer: 'Visible line reaches145c',
            result: 'incorrect',
            reason: 'none',
            points: null,
            possiblePoints: null,
            conceptIds: [],
            feedback:
              'The observed connection does not match the printed amount.',
          },
          {
            ...base,
            id: 'u:match-one-dollar-forty-five:1',
            prompt: 'Match one dollar forty-five',
            answer: '',
            result: 'unassessed',
            reason: 'illegible',
            points: null,
            possiblePoints: null,
            conceptIds: [],
            feedback: 'The visible endpoint is unreadable.',
            markingCertainty: 'uncertain',
            evidenceLimitations: ['Connection endpoint is not visible.'],
          },
        ],
      };
      const record = (
        body: WorkbookAssessment,
        key: string,
        submissionId = f.attempt.submissionId,
      ) =>
        f.as(f.own, () =>
          f.service.recordWorkbookAnalysis({
            ...f.request,
            ...f.own,
            submissionId,
            requestKey: key,
            assessment: body,
          }),
        );
      const first = await record(assessment, 'unnumbered-first');
      expect(first.assessment.aggregate).toMatchObject({
        incorrect: 2,
        unassessed: 1,
        score: null,
      });
      expect((await record(assessment, 'unnumbered-first')).id).toBe(first.id);
      for (const questions of [
        assessment.questions.map((q, index) =>
          index === 1 ? { ...q, id: '' } : q,
        ),
        assessment.questions.map((q, index) =>
          index === 1 ? { ...q, id: undefined as unknown as string } : q,
        ),
        assessment.questions.map((q, index) =>
          index === 1 ? { ...q, id: 'q1' } : q,
        ),
        assessment.questions.map((q, index) =>
          index === 1 ? { ...q, id: 'u:different-task:1' } : q,
        ),
        assessment.questions.map((q, index) =>
          index === 1 ? { ...q, prompt: 'A different task' } : q,
        ),
      ])
        await expect(
          record({ ...assessment, questions }, 'invalid-identity'),
        ).rejects.toThrow();
      const reordered = {
        ...assessment,
        provenance: {
          ...assessment.provenance,
          analysisId: 'unnumbered-reordered',
        },
        questions: [...assessment.questions].reverse(),
      };
      const second = await record(reordered, 'unnumbered-reordered');
      expect(second.assessment.questions.map((q) => q.id)).toEqual(
        reordered.questions.map((q) => q.id),
      );
      const correction = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          requestKey: 'unnumbered-correction',
          intakeItemId: 'unnumbered-correction',
          previousSubmissionId: f.attempt.submissionId,
          pages: [
            {
              ...f.capture.pages[0],
              data: Buffer.from('new visible responses'),
            },
          ],
        }),
      );
      expect(correction.episodeId).toBe(f.attempt.episodeId);
      const known = await offered(correction.submissionId);
      expect(known.label).toContain('u:match-seventy-five-cents:1');
      expect(known.label).toContain('identity_only');
      expect(known.label).not.toContain('Visible line reaches145c');
      expect(known.label).not.toContain('8+7');
      const [source] = await f.as(f.own, () =>
        f.service.getWorkbookSourceAnchors({
          ...f.request,
          ...f.own,
          submissionId: correction.submissionId,
        }),
      );
      const corrected: WorkbookAssessment = {
        ...assessment,
        provenance: {
          ...assessment.provenance,
          analysisId: 'unnumbered-corrected',
          inputHash: source.sha256,
        },
        questions: assessment.questions.map((q) => ({
          ...q,
          anchors: [{ ...source, page: 1, rect: [0, 0, 1, 1] }],
          ...(q.id === 'q1'
            ? {
                answer: '15',
                result: 'correct' as const,
                feedback: 'Current response is correct.',
              }
            : q.id === 'u:match-seventy-five-cents:1'
              ? {
                  answer: 'Visible line reaches75c',
                  result: 'correct' as const,
                  feedback: 'Current visible connection matches.',
                }
              : {
                  answer: '',
                  result: 'unassessed' as const,
                  reason: 'not_present' as const,
                  feedback:
                    'Current capture does not establish this task correspondence.',
                }),
        })),
      };
      const result = await record(
        corrected,
        'unnumbered-current-answers',
        correction.submissionId,
      );
      expect(result.assessment.aggregate).toMatchObject({
        correct: 2,
        unassessed: 1,
        score: null,
      });
      expect(result.assessment.questions.map((q) => q.id)).toEqual(
        assessment.questions.map((q) => q.id),
      );
      expect(
        result.assessment.questions.find(
          (q) => q.id === 'u:match-seventy-five-cents:1',
        )?.answer,
      ).toBe('Visible line reaches75c');
      await expect(
        record(
          { ...corrected, questions: corrected.questions.slice(1) },
          'missing-known-id',
          correction.submissionId,
        ),
      ).rejects.toThrow('question identity');
      const timeline = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({ ...f.request }),
      );
      expect(timeline.attempts).toHaveLength(2);
      expect(timeline.attempts[0].previousAttemptId).toBe(f.attempt.id);
      expect(timeline.attempts[1].revisions.map((r) => r.id)).toContain(
        first.id,
      );
    } finally {
      await f.close();
    }
  });
  it('uses current correction text without carrying historical equation or prose answers into generation', async () => {
    const f = await fixture();
    try {
      const original = structuredClone(f.assessment);
      original.questions[0].prompt = '7 - 4 = 2';
      original.questions[0].answer = '2';
      original.questions.push({
        ...original.questions[0],
        id: 'p7:q2',
        prompt: 'Name the shape. The learner wrote: circle',
        answer: 'circle',
      });
      const first = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          ...f.own,
          requestKey: 'original-answers',
          assessment: original,
        }),
      );
      const reread = await f.as(f.own, () =>
        f.service.getWorkbookQuestionContext({ ...f.request, ...f.own }),
      );
      expect(reread).toEqual({
        kind: 'same_capture',
        questions: original.questions.map(({ id, prompt }) => ({ id, prompt })),
      });
      for (const override of [
        { learnerId: String(f.sibling.id) },
        { tenantId: String(f.foreign.tenantId) },
      ])
        await f.as(f.own, () =>
          expect(
            f.service.getWorkbookQuestionContext({
              ...f.request,
              ...f.own,
              ...override,
            }),
          ).rejects.toThrow(),
        );
      const correction = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          intakeItemId: 'new-answers',
          requestKey: 'new-answers',
          previousSubmissionId: f.attempt.submissionId,
          pages: [
            { ...f.capture.pages[0], data: Buffer.from('corrected-photo') },
          ],
        }),
      );
      const request = { ...f.request, submissionId: correction.submissionId };
      const ids = await f.as(f.own, () =>
        f.service.getWorkbookQuestionIdentity({ ...request, ...f.own }),
      );
      expect(ids).toEqual([{ id: 'p7:q1' }, { id: 'p7:q2' }]);
      expect(
        await f.as(f.own, () =>
          f.service.getWorkbookQuestionContext({ ...request, ...f.own }),
        ),
      ).toEqual({ kind: 'identity_only', questions: ids });
      const handler = educationIntakeHandlers({
        submissions: f.service,
        request: { ...f.own, enrollmentId: f.activity.enrollmentId },
        submissionId: correction.submissionId,
        workbookActivityId: f.activity.id,
      }).find((h) => h.id.endsWith('review-submission'))!;
      const candidates = await f.as(f.own, () =>
        handler.discovery!.candidates!(
          '',
          {
            db: f.db,
            scope: { tenantId: f.own.tenantId, actorId: f.own.actorUserId },
            policy: { requireReview: true },
          } as unknown as Parameters<
            NonNullable<NonNullable<typeof handler.discovery>['candidates']>
          >[1],
          { limit: 100 },
        ),
      );
      const label = JSON.stringify(candidates.items[0].context);
      expect(label).toContain('p7:q1');
      expect(label).not.toContain('7 - 4');
      expect(label).not.toContain('circle');
      expect(handler.description).toContain('current captured evidence');
      const rereadHandler = educationIntakeHandlers({
        submissions: f.service,
        request: { ...f.own, enrollmentId: f.activity.enrollmentId },
        submissionId: f.attempt.submissionId,
        workbookActivityId: f.activity.id,
      }).find((h) => h.id.endsWith('review-submission'))!;
      const sameCaptureCandidates = await f.as(f.own, () =>
        rereadHandler.discovery!.candidates!(
          '',
          {
            db: f.db,
            scope: { tenantId: f.own.tenantId, actorId: f.own.actorUserId },
            policy: { requireReview: true },
          } as unknown as Parameters<
            NonNullable<
              NonNullable<typeof rereadHandler.discovery>['candidates']
            >
          >[1],
          { limit: 100 },
        ),
      );
      expect(sameCaptureCandidates.items[0].context).toEqual(reread);
      expect(JSON.stringify(rereadHandler.argsSchema)).toContain(
        'preserve exact canonical IDs and prompt strings verbatim',
      );
      expect(JSON.stringify(rereadHandler.argsSchema)).toContain(
        'never derive positions',
      );
      const sources = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(request),
      );
      const corrected = structuredClone(original);
      corrected.provenance.analysisId = 'corrected-analysis';
      corrected.questions = corrected.questions.map((q, index) => ({
        ...q,
        prompt:
          index === 0
            ? '7 - 4 ='
            : 'Name the shape. The learner wrote: triangle',
        answer: index === 0 ? '3' : 'triangle',
        result: 'correct',
        points: 1,
        feedback: 'Correct on the current capture.',
        anchors: [{ ...sources[0], page: 1, rect: [0, 0, 1, 1] }],
      }));
      const record = (assessment: WorkbookAssessment, requestKey: string) =>
        f.as(f.own, () =>
          f.service.recordWorkbookAnalysis({
            ...request,
            ...f.own,
            requestKey,
            assessment,
          }),
        );
      for (const questions of [
        corrected.questions.slice(1),
        [...corrected.questions, { ...corrected.questions[0], id: 'invented' }],
        corrected.questions.map((q, index) =>
          index ? q : { ...q, id: 'foreign-page:q1' },
        ),
      ])
        await expect(
          record({ ...corrected, questions }, 'bad-identities'),
        ).rejects.toThrow('question identity');
      await expect(
        record(
          {
            ...corrected,
            questions: [corrected.questions[0], corrected.questions[0]],
          },
          'duplicate-ids',
        ),
      ).rejects.toThrow('Duplicate or empty question id');
      // Printed IDs, not array position, establish correspondence.
      corrected.questions.reverse();
      const retained = await record(corrected, 'current-answers');
      expect(retained.assessment.questions.map((q) => q.answer)).toEqual([
        'triangle',
        '3',
      ]);
      expect((await record(corrected, 'current-answers')).id).toBe(retained.id);
      expect(
        await f.as(f.own, () =>
          f.service.getWorkbookQuestionContext({ ...request, ...f.own }),
        ),
      ).toEqual({
        kind: 'same_capture',
        questions: corrected.questions.map(({ id, prompt }) => ({
          id,
          prompt,
        })),
      });
      await expect(
        record(
          {
            ...corrected,
            provenance: {
              ...corrected.provenance,
              analysisId: 'retargeted-analysis',
            },
            questions: corrected.questions.map((q, index) =>
              index ? q : { ...q, prompt: '9 - 1 =' },
            ),
          },
          'retargeted',
        ),
      ).rejects.toThrow('question identity');
      const ambiguous = await record(
        {
          ...corrected,
          provenance: {
            ...corrected.provenance,
            analysisId: 'ambiguous-analysis',
          },
          questions: corrected.questions.map((q) => ({
            ...q,
            answer: '',
            result: 'unassessed',
            reason: 'not_present',
            points: null,
            possiblePoints: null,
            feedback: 'Cannot establish correspondence on this capture.',
            evidenceLimitations: ['Printed question identity is ambiguous.'],
          })),
        },
        'ambiguous',
      );
      expect(ambiguous.assessment.aggregate?.score).toBeNull();
      const timeline = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({
          ...f.parent,
          activityId: f.activity.id,
        }),
      );
      expect(
        timeline.attempts
          .flatMap((a) => a.revisions)
          .map((r) => r.id)
          .sort(),
      ).toEqual([first.id, retained.id, ambiguous.id].sort());
      expect(
        timeline.attempts.find((a) => a.id === f.attempt.id)!.revisions[0]
          .assessment,
      ).toEqual(first.assessment);
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
      expect(await f.db.tableExists('workbook_photo_assets')).toBe(true);
      const uncertainAssessment = structuredClone(f.assessment);
      uncertainAssessment.questions[0] = {
        ...uncertainAssessment.questions[0],
        result: 'correct',
        points: 1,
        possiblePoints: 1,
        markingCertainty: 'uncertain',
      };
      expect(() => validateWorkbookAssessment(uncertainAssessment)).toThrow(
        'Uncertain marking must remain unassessed',
      );
      const honestUnassessed = structuredClone(uncertainAssessment);
      honestUnassessed.questions[0] = {
        ...honestUnassessed.questions[0],
        result: 'unassessed',
        reason: 'illegible',
        points: null,
        possiblePoints: null,
      };
      expect(() => validateWorkbookAssessment(honestUnassessed)).not.toThrow();

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
              generate: async (input) => {
                const offered = input.offered.find(
                  (entry) => entry.handler.id === handlerId,
                );
                const offeredProperties = offered?.handler.argsSchema
                  .properties as Record<string, unknown> | undefined;
                const questions = offeredProperties?.questions as unknown as {
                  items: {
                    oneOf: Array<{
                      properties: {
                        result: { enum?: string[] };
                        markingCertainty?: { enum: string[] };
                      };
                    }>;
                  };
                };
                const assessed = questions.items.oneOf.find((branch) =>
                  branch.properties.result.enum?.includes('correct'),
                );
                expect(assessed?.properties.markingCertainty?.enum).toEqual([
                  'clear',
                  'unknown',
                ]);
                return {
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
                };
              },
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
            layout: {
              version: 1,
              provenance: 'observed',
              sections: [
                {
                  id: 'wire-section',
                  label: 'Observed part',
                  columns: 2,
                  readingOrder: 'rows',
                  source: { evidenceId: evidence.id, page: 1 },
                },
              ],
              placements: [
                {
                  questionId: 'q1',
                  sectionId: 'wire-section',
                  row: 0,
                  column: 1,
                },
              ],
            },
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
        const wireActionId = await ingestion.createAction(
          receipt.itemId,
          'wire',
          { purpose: 'wire-schema-validation' },
        );
        let wireRevision = 0;
        const preview = async (key: string, payload: typeof args) => {
          const result = await ingestion.previewProposal({
            itemId: receipt.itemId,
            attemptId: lease.attemptId,
            actionId: wireActionId,
            expectedRevision: wireRevision,
            requestId: key,
            handlerId,
            handlerVersion: '1',
            args: payload,
          });
          wireRevision = result.revision;
          return result;
        };
        expect((await preview('evidence-only', args)).revision).toBeGreaterThan(
          0,
        );
        const invalidReason = structuredClone(args);
        invalidReason.questions[0].reason = 'unsupported';
        await expect(
          preview('invalid-reason', invalidReason),
        ).rejects.toThrow();
        const uncertainCorrect = structuredClone(args);
        uncertainCorrect.questions[0].markingCertainty = 'uncertain';
        await expect(
          preview('uncertain-cannot-be-correct', uncertainCorrect),
        ).rejects.toThrow();
        const uncertainUnassessed = structuredClone(uncertainCorrect);
        uncertainUnassessed.questions[0].result = 'unassessed';
        uncertainUnassessed.questions[0].reason = 'illegible';
        uncertainUnassessed.questions[0].points = null;
        uncertainUnassessed.questions[0].possiblePoints = null;
        expect(
          (await preview('uncertain-unassessed', uncertainUnassessed)).revision,
        ).toBeGreaterThan(0);
        const unknownCertainty = structuredClone(args);
        unknownCertainty.questions[0].markingCertainty = 'unknown';
        expect(
          (await preview('unknown-certainty-assessed', unknownCertainty))
            .revision,
        ).toBeGreaterThan(0);
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
        const importedHistory = await f.service.getWorkbookTimeline({
          ...request,
          activityId: activity.id,
        });
        const importedBody = importedHistory.attempts[0].revisions.find(
          (r) => r.id === imported.revisionId,
        )?.assessment;
        expect(importedBody?.layout).toMatchObject({
          version: 1,
          provenance: 'observed',
          sections: [
            {
              id: 'wire-section',
              source: { assetId: submission.pages[0].assetId, page: 1 },
            },
          ],
          placements: [{ questionId: 'q1', row: 0, column: 1 }],
        });
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
        expect(reviewed.assessment.layout).toEqual(importedBody?.layout);
        // Legacy same-capture prompts are authoritative only for transcription;
        // a new interpretation appends without changing the old assessment.
        expect(
          await f.service.getWorkbookQuestionContext({
            ...request,
            activityId: activity.id,
            submissionId: submission.id,
          }),
        ).toEqual({
          kind: 'same_capture',
          questions: [{ id: 'q1', prompt: '2 + 3' }],
        });
        // Invalid advisory layout must not cause generic schema rejection or lose marks.
        args.layout = 'malformed optional layout';
        await generate();
        const malformedLayoutImport =
          await preserveWorkbookIntakeAnalysis(preservation);
        expect(malformedLayoutImport.kind).toBe('preserved');
        if (malformedLayoutImport.kind !== 'preserved')
          throw new Error('Answers were discarded for layout');
        const layoutHistory = await f.service.getWorkbookTimeline({
          ...request,
          activityId: activity.id,
        });
        const fallback = layoutHistory.attempts[0].revisions.find(
          (r) => r.id === malformedLayoutImport.revisionId,
        )?.assessment;
        expect(fallback?.questions).toHaveLength(1);
        expect(fallback?.questions[0].result).toBe('correct');
        expect(fallback?.layout).toBeUndefined();
        expect(fallback?.layoutOmission).toBe('invalid');
        expect(
          layoutHistory.attempts[0].revisions.find((r) => r.id === reviewed.id)
            ?.assessment.layout,
        ).toEqual(importedBody?.layout);
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
      let mode: 'stale' | 'unavailable' | 'config' | 'db' = 'stale';
      let currentRevision = 2;
      const ingestion = {
        getItem: async () => ({ analysisRevision: currentRevision }),
        getCompletedAnalysis: async () => {
          if (mode === 'stale') throw new GenerationSnapshotStaleError();
          if (mode === 'config') throw new ProposalsNotConfiguredError();
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
      mode = 'config';
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
      mode = 'config';
      expect(
        (await f.as(f.own, () => preserveWorkbookIntakeAnalysis(input))).kind,
      ).toBe('unavailable');

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
