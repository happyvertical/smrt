import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  readWorkbookCompletion,
  WorkbookCompletionDecisionCollection,
} from '../workbook-completion.js';
import { WORKBOOK_MATH_VOCABULARY } from '../workbook-contracts.js';
import { WorkbookAssessmentRevisionCollection } from '../workbook-models.js';
import { WorkbookService } from '../workbook-service.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

it('keeps immutable decisions on their exact current attempt and rejects identity rewrites', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [...workbookClasses, 'WorkbookCompletionDecision'],
  });
  const storage = await mkdtemp(join(tmpdir(), 'completion-model-'));
  try {
    const f = await learnerFixture(db);
    const service = new WorkbookService(
      db,
      ({ own, relationshipTypeId }) =>
        own || relationshipTypeId === f.guardianType.id,
      () => true,
      { storage },
    );
    await f.as(f.parent, async () => {
      const activity = await service.resolveWorkbookActivity({
        ...f.parent,
        workbookKey: 'completion-model',
        title: 'Synthetic workbook',
        edition: '',
        pageKey: 'p1',
        pageLabel: 'Page 1',
      });
      const scope = {
        tenantId: f.parent.tenantId,
        learnerId: f.parent.learnerId,
        activityId: activity.id,
      };
      expect((await readWorkbookCompletion(db, scope)).completion).toEqual({
        status: 'doing',
        completedAt: null,
      });
      const capture = {
        ...f.parent,
        activityId: activity.id,
        requestKey: 'first-capture',
        pages: [
          {
            name: 'p.png',
            mimeType: 'image/png' as const,
            data: Buffer.from('synthetic'),
          },
        ],
      };
      const first = await service.captureWorkbookWork(capture);
      const decisions = await WorkbookCompletionDecisionCollection.create({
        db,
      });
      const input = {
        ...scope,
        attemptId: first.id,
        submissionId: first.submissionId,
        feedbackHeadId: null,
        actorUserId: f.parent.actorUserId,
        requestKey: 'done',
      };
      const before = Date.now();
      const decision = await decisions.create({
        ...input,
        recordedAt: new Date(0),
      });
      expect(decision.recordedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect((await readWorkbookCompletion(db, scope)).completion.status).toBe(
        'complete',
      );
      await expect(decision.save()).rejects.toThrow('immutable');
      await expect(decision.delete()).rejects.toThrow('immutable');
      await expect(decisions.create(input)).rejects.toThrow();
      await expect(
        decisions.create({ ...input, requestKey: 'other' }),
      ).rejects.toThrow();
      expect(
        (await readWorkbookCompletion(db, scope)).decision?.requestKey,
      ).toBe('done');
      const revisions = await WorkbookAssessmentRevisionCollection.create({
        db,
      });
      const anchors = await service.getWorkbookSourceAnchors({
        ...f.parent,
        activityId: activity.id,
        submissionId: first.submissionId,
      });
      const assessmentJson = JSON.stringify({
        version: 1,
        feedback: '',
        provenance: {
          provider: 'synthetic',
          model: 'test',
          configurationVersion: '1',
          rubricVersion: '1',
          inputHash: anchors[0].sha256,
          analysisId: 'test',
        },
        vocabulary: WORKBOOK_MATH_VOCABULARY,
        questions: [
          {
            id: '1',
            prompt: '1 + 1',
            answer: '',
            feedback: '',
            result: 'unassessed',
            reason: 'unanswered',
            points: null,
            possiblePoints: null,
            anchors: [{ ...anchors[0], page: 1, rect: [0, 0, 1, 1] }],
            conceptIds: [],
          },
        ],
      });
      const aiId = randomUUID();
      const guardianId = randomUUID();
      const laterAiId = randomUUID();
      for (const [id, kind, recordedAt] of [
        [aiId, 'ai', '2026-01-01T00:00:00.000Z'],
        [guardianId, 'guardian', '2026-01-02T00:00:00.000Z'],
        [laterAiId, 'ai', '2026-01-03T00:00:00.000Z'],
      ]) {
        await revisions.create({
          id,
          tenantId: scope.tenantId,
          learnerId: scope.learnerId,
          attemptId: first.id,
          requestKey: id,
          kind,
          recordedAt: new Date(recordedAt),
          assessmentJson,
        });
        const snapshot = await readWorkbookCompletion(db, scope);
        expect(snapshot.feedbackHeadId).toBe(
          kind === 'guardian' || id === laterAiId ? guardianId : aiId,
        );
        expect(snapshot.decision?.id).toBe(decision.id);
        expect(snapshot.completion.completedAt).toEqual(decision.recordedAt);
      }

      const second = await service.captureWorkbookWork({
        ...capture,
        requestKey: 'correction',
        previousSubmissionId: first.submissionId,
      });
      const current = await readWorkbookCompletion(db, scope);
      expect(current.currentAttempt?.id).toBe(second.id);
      expect(current.decision).toBeNull();
      expect(current.decisions.map((row) => row.id)).toEqual([decision.id]);
      expect(current.completion).toEqual({
        status: 'doing',
        completedAt: null,
      });
      await expect(
        decisions.create({
          ...input,
          requestKey: 'foreign-attempt',
          attemptId: second.id,
        }),
      ).rejects.toThrow('ownership mismatch');
      await expect(
        decisions.create({
          ...input,
          requestKey: 'foreign-actor',
          actorUserId: String(f.stranger.user.id),
        }),
      ).rejects.toThrow('ownership mismatch');
      await expect(
        decisions.create({
          ...input,
          requestKey: 'bad-head',
          feedbackHeadId: String(f.stranger.user.id),
        }),
      ).rejects.toThrow('head mismatch');
      // Multiple leaves must fail closed even when one has a newer capture time.
      await db.query(
        'UPDATE workbook_attempts SET previous_attempt_id = NULL WHERE id = ?',
        [second.id],
      );
      await expect(readWorkbookCompletion(db, scope)).rejects.toThrow(
        'ambiguous',
      );
      const firstRow = await db.get('workbook_attempts', { id: first.id });
      await db.query(
        'UPDATE workbook_attempts SET episode_id = ?, captured_at = ? WHERE id = ?',
        [randomUUID(), '2030-01-01T00:00:00.000Z', second.id],
      );
      expect((await readWorkbookCompletion(db, scope)).currentAttempt?.id).toBe(
        second.id,
      );
      await db.query(
        'UPDATE workbook_attempts SET episode_id = ? WHERE id = ?',
        [firstRow?.episode_id, second.id],
      );

      await db.query(
        'UPDATE workbook_attempts SET previous_attempt_id = ? WHERE id = ?',
        [first.id, second.id],
      );
      await db.query('DROP TABLE workbook_completion_decisions');
      expect((await readWorkbookCompletion(db, scope)).completion).toEqual({
        status: 'doing',
        completedAt: null,
      });
      expect(await db.tableExists('workbook_completion_decisions')).toBe(false);
    });
  } finally {
    await db.close?.();
    await rm(storage, { recursive: true, force: true });
  }
});
