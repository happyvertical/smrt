import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import {
  isEmbeddedDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import * as intakeModels from '@happyvertical/smrt-ingestion/models';
import { IngestionService } from '@happyvertical/smrt-ingestion/server';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import {
  captureEducationIntake,
  educationIntakeHandlers,
  educationIntakeTargetResolver,
} from '../ingestion.js';
import { SubmissionService } from '../submission-service.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

export const ingestionClasses = [
  ...submissionClasses,
  ...Object.keys(intakeModels),
  'SmrtJob',
  'SmrtJobEvent',
  'SmrtWorker',
];
export async function assertIngestionBridge(db: DatabaseInterface) {
  const storage = await mkdtemp(join(tmpdir(), 'education-ingestion-'));
  try {
    const f = await learnerFixture(db);
    const scope = {
      tenantId: f.parent.tenantId,
      actorId: f.parent.actorUserId,
      confidentialScopeId: String(f.enrollment.id),
    };
    const submissions = new SubmissionService(
      db,
      ({ own, relationshipTypeId }) =>
        own || relationshipTypeId === f.guardianType.id,
      () => true,
      { storage },
    );
    const assets = await createAssetRuntime({ db, storage });
    const ingestion = new IngestionService({
      db,
      assets,
      scope,
      authorize: async () => true,
      jobTarget: { objectType: 'unused-worker', method: 'process' },
      purgeDerived: async () => {},
    });
    const receive = (key: string) =>
      ingestion.receive({
        sourceId: 'paper',
        sourceVersion: '1',
        deliveryKey: key,
        deliveredAt: new Date(),
        parts: [
          { partId: 'page', mediaType: 'image/png', bytes: Buffer.from(key) },
        ],
        capturedCeiling: {},
        retention: {
          version: '1',
          expiresAt: new Date(Date.now() + 3600000),
          replayUntil: new Date(Date.now() + 7200000),
          acceptAfter: new Date(Date.now() - 3600000),
        },
        limits: {
          maxBytes: 4096,
          maxParts: 10,
          maxAttempts: 3,
          leaseMs: 10000,
          maxOutputBytes: 4096,
        },
      });
    await f.as(f.parent, async () => {
      const receipt = await receive('first');
      if (!('itemId' in receipt)) throw new Error(JSON.stringify(receipt));
      const request = {
        ...f.parent,
        enrollmentId: String(f.enrollment.id),
        lessonId: String(f.lesson.id),
        itemId: receipt.itemId,
        kind: 'completed_work' as const,
      };
      const capture = () =>
        captureEducationIntake({ ingestion, scope, submissions, request });
      const first = await capture();
      expect((await capture()).id).toBe(first.id);
      await expect(
        captureEducationIntake({
          ingestion,
          scope,
          submissions,
          request: { ...request, notes: 'changed retry' },
        }),
      ).rejects.toThrow('content');
      await expect(
        captureEducationIntake({
          ingestion,
          scope,
          submissions,
          request: { ...request, lessonId: String(f.secondLesson.id) },
        }),
      ).rejects.toThrow();
      const handler = educationIntakeHandlers({
        submissions,
        request,
        submissionId: first.id,
      })[1];
      if (handler.execution.kind !== 'database')
        throw new Error('Expected database');
      const apply = handler.execution.apply;
      const resolver = educationIntakeTargetResolver({
        submissions,
        request,
        submissionId: first.id,
      });
      const context = {
        scope,
        itemId: receipt.itemId,
        policy: { requireReview: true },
      };
      const makeContext = (executor: DatabaseInterface) => ({
        ...context,
        db: executor,
        assertTarget: async (model: string, id: string, revision?: string) => {
          await resolver({
            db: executor,
            scope,
            itemId: receipt.itemId,
            model,
            id,
            revision,
          });
        },
      });
      await expect(
        withEmbeddedWriteTransaction(
          db,
          isEmbeddedDatabase(db),
          async (executor) => {
            await apply(
              { submissionId: first.id, score: 0, feedback: 'First feedback' },
              makeContext(executor) as never,
            );
            throw new Error('execution receipt failure');
          },
        ),
      ).rejects.toThrow('execution receipt failure');
      expect(
        (
          await submissions.getSubmission({
            ...request,
            submissionId: first.id,
          })
        ).grade,
      ).toBeNull();
      await withEmbeddedWriteTransaction(
        db,
        isEmbeddedDatabase(db),
        async (executor) => {
          await apply(
            { submissionId: first.id, score: 0, feedback: 'First feedback' },
            makeContext(executor) as never,
          );
        },
      );
      expect(
        (
          await submissions.getSubmission({
            ...request,
            submissionId: first.id,
          })
        ).grade?.score,
      ).toBe(0);
      const next = await receive('correction');
      if (!('itemId' in next)) throw new Error(JSON.stringify(next));
      const correction = await captureEducationIntake({
        ingestion,
        scope,
        submissions,
        request: {
          ...request,
          itemId: next.itemId,
          previousSubmissionId: first.id,
        },
      });
      expect(correction.id).not.toBe(first.id);
      expect(
        (
          await captureEducationIntake({
            ingestion,
            scope,
            submissions,
            request: {
              ...request,
              itemId: next.itemId,
              previousSubmissionId: first.id,
            },
          })
        ).id,
      ).toBe(correction.id);
      expect(correction.grade).toBeNull();
      expect(
        (
          await submissions.getSubmission({
            ...request,
            submissionId: first.id,
          })
        ).grade?.feedback,
      ).toBe('First feedback');
      await expect(
        withEmbeddedWriteTransaction(
          db,
          isEmbeddedDatabase(db),
          async (executor) =>
            apply(
              { submissionId: first.id, score: 1, feedback: 'stale' },
              makeContext(executor) as never,
            ),
        ),
      ).rejects.toThrow();
    });
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}

/** The receipt principal is host-owned; uploader and guardian remain distinct. */
export async function assertDelegatedGuardianReview(db: DatabaseInterface) {
  const storage = await mkdtemp(join(tmpdir(), 'education-delegation-'));
  try {
    const f = await learnerFixture(db);
    const assets = await createAssetRuntime({ db, storage });
    const principalId = '22222222-2222-4222-8222-222222222222';
    let guardianAllowed = true;
    let principalPermissions = ['lessons.read', 'grades.create'];
    const submissions = new SubmissionService(
      db,
      async ({ own, relationshipTypeId, executor }) => {
        if (own) return true;
        // The host relationship lookup must share the active review executor.
        const relationship = await executor.get('profile_relationships', {
          id: f.relationship.id,
          tenant_id: f.parent.tenantId,
          from_profile_id: f.relationship.fromProfileId,
          to_profile_id: f.relationship.toProfileId,
        });
        return (
          guardianAllowed &&
          Boolean(relationship) &&
          relationshipTypeId === f.guardianType.id
        );
      },
      () => true,
      { storage },
    );
    const baseRequest = {
      enrollmentId: String(f.enrollment.id),
      lessonId: String(f.lesson.id),
    };
    const ownScope = {
      tenantId: f.own.tenantId,
      actorId: f.own.actorUserId,
      confidentialScopeId: String(f.enrollment.id),
    };
    const parentScope = { ...ownScope, actorId: f.parent.actorUserId };
    const options = {
      db,
      assets,
      authorize: async ({ scope }: { scope: typeof ownScope }) =>
        scope.tenantId === ownScope.tenantId &&
        scope.confidentialScopeId === ownScope.confidentialScopeId &&
        [ownScope.actorId, parentScope.actorId].includes(scope.actorId),
      jobTarget: { objectType: 'unused-worker', method: 'process' },
      purgeDerived: async () => {},
    };
    const uploader = new IngestionService({ ...options, scope: ownScope });
    const handlerId = '@happyvertical/smrt-education:review-submission';
    const operationKey = '@happyvertical/smrt-education:Grade:create@1';
    const receipt = await f.as(f.own, () =>
      uploader.receive({
        sourceId: 'paper',
        sourceVersion: '1',
        deliveryKey: 'learner-upload',
        deliveredAt: new Date(),
        parts: [
          {
            partId: '1',
            mediaType: 'image/png',
            bytes: Buffer.from('learner work'),
          },
        ],
        capturedCeiling: {
          execution: {
            principalId,
            permissions: ['grades.create'],
            handlers: [handlerId],
            operations: [operationKey],
          },
        },
        retention: {
          version: '1',
          expiresAt: new Date(Date.now() + 3600000),
          replayUntil: new Date(Date.now() + 7200000),
          acceptAfter: new Date(Date.now() - 3600000),
        },
        limits: {
          maxBytes: 4096,
          maxParts: 10,
          maxAttempts: 3,
          leaseMs: 10000,
          maxOutputBytes: 4096,
        },
      }),
    );
    if (!('itemId' in receipt)) throw new Error(JSON.stringify(receipt));
    const submission = await f.as(f.own, () =>
      captureEducationIntake({
        ingestion: uploader,
        scope: ownScope,
        submissions,
        request: {
          ...f.own,
          ...baseRequest,
          itemId: receipt.itemId,
          kind: 'completed_work',
        },
      }),
    );
    const request = { ...f.parent, ...baseRequest };
    const handlers = educationIntakeHandlers({
      submissions,
      request,
      submissionId: submission.id,
    });
    const guardian = new IngestionService({
      ...options,
      scope: parentScope,
      execution: {
        handlers,
        authorize: async ({ db: executor, scope }) => {
          // Same enrollment lock as domain writes; live relation decision is
          // checked while held, never inferred from the upload or fixed principal.
          await executor.query(
            'UPDATE enrollments SET id=id WHERE id=? AND tenant_id=?',
            request.enrollmentId,
            request.tenantId,
          );
          return {
            allowed:
              guardianAllowed &&
              scope.actorId === f.parent.actorUserId &&
              scope.tenantId === request.tenantId,
            reviewer: guardianAllowed,
            principalId,
            permissions: principalPermissions,
            mutationBoundary: 'serialized' as const,
            policy: [
              {
                version: 'app1',
                handlers: [handlerId],
                operations: [operationKey],
                reviewers: [f.parent.actorUserId],
                access: [ownScope.confidentialScopeId],
                requireReview: true,
              },
              { version: 'tenant1' },
              { version: 'source1' },
            ],
          };
        },
        assertTarget: educationIntakeTargetResolver({
          submissions,
          request,
          submissionId: submission.id,
        }),
      },
    });
    await f.as(f.parent, async () => {
      const analysis = await guardian.analyze(
        receipt.itemId,
        { version: 'test' },
        'marking',
      );
      const lease = await guardian.claimAnalysis(
        receipt.itemId,
        analysis.revision,
        'worker',
      );
      if (!lease) throw new Error('missing lease');
      await guardian.completeAnalysis(lease, {
        status: 'completed',
        provider: 'fixture',
        model: 'fixture',
        version: '1',
        output: {},
        usage: {},
      });
      const actionId = await guardian.createAction(receipt.itemId, 'grade', {
        explicit: true,
      });
      const review = await guardian.previewProposal({
        itemId: receipt.itemId,
        attemptId: lease.attemptId,
        actionId,
        expectedRevision: 0,
        requestId: 'preview',
        handlerId,
        handlerVersion: '1',
        args: {
          submissionId: submission.id,
          score: 0.5,
          feedback: 'Guardian approved',
        },
      });
      await guardian.submitDecision({
        actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
        requestId: 'decision',
        decision: 'approve',
      });
      guardianAllowed = false;
      await expect(guardian.applyAction(actionId)).rejects.toThrow();
      guardianAllowed = true;
      await db.query(
        'UPDATE profile_relationships SET to_profile_id=? WHERE id=?',
        f.sibling.profileId,
        f.relationship.id,
      );
      await expect(guardian.applyAction(actionId)).rejects.toThrow();
      await db.query(
        'UPDATE profile_relationships SET to_profile_id=? WHERE id=?',
        f.learner.profileId,
        f.relationship.id,
      );
      principalPermissions = [];
      await expect(guardian.applyAction(actionId)).rejects.toThrow();
      principalPermissions = ['grades.create'];
      expect((await guardian.applyAction(actionId)).state).toBe('succeeded');
      expect((await guardian.applyAction(actionId)).state).toBe('succeeded');
      const grades = await db.query(
        'SELECT id FROM grades WHERE submission_id=?',
        submission.id,
      );
      expect(grades.rows).toHaveLength(1);
      expect(
        (
          await submissions.getSubmission({
            ...request,
            submissionId: submission.id,
          })
        ).grade?.feedback,
      ).toBe('Guardian approved');
      const foreign = new IngestionService({
        ...options,
        scope: { ...parentScope, tenantId: f.foreign.tenantId },
      });
      await expect(foreign.getItem(receipt.itemId)).rejects.toThrow();
      const sibling = new IngestionService({
        ...options,
        scope: { ...parentScope, confidentialScopeId: String(f.sibling.id) },
      });
      await expect(sibling.getItem(receipt.itemId)).rejects.toThrow();
      expect(
        (
          await uploader.readEvidence(
            receipt.itemId,
            (
              await uploader.getEvidence(receipt.itemId)
            )[0].id,
          )
        ).toString(),
      ).toBe(Buffer.from('learner work').toString());
    });
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}
