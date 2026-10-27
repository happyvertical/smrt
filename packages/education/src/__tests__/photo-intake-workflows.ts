import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import type { HandlerContext } from '@happyvertical/smrt-ingestion/execution';
import { IngestionService } from '@happyvertical/smrt-ingestion/server';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it, vi } from 'vitest';
import { SubmissionService } from '../submission-service.js';
import {
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
} from '../workbook-contracts.js';
import type {
  WorkbookPhotoIdentification,
  WorkbookPhotoProposal,
} from '../workbook-photo-contracts.js';
import {
  preserveWorkbookPhotoIdentification,
  receiveWorkbookPhotoIntake,
  WORKBOOK_PHOTO_HANDLER,
  workbookPhotoIntakeHandlers,
  workbookPhotoIntakeTargetResolver,
} from '../workbook-photo-ingestion.js';
import {
  WorkbookContextRevisionCollection,
  WorkbookPhotoDecisionCollection,
  WorkbookPhotoIntakeCollection,
} from '../workbook-photo-models.js';
import {
  preservePhotoProposal,
  WorkbookPhotoService,
} from '../workbook-photo-service.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './workbook-workflows.js';
export const photoClasses = [
  ...workbookClasses,
  'WorkbookPhotoIntake',
  'WorkbookPhotoAsset',
  'WorkbookPhotoDecision',
  'WorkbookContextRevision',
];
export function photoIntakeTests(
  factory: () => Promise<{
    db: DatabaseInterface;
    cleanup: () => Promise<void>;
  }>,
) {
  async function fixture() {
    const { db, cleanup } = await factory();
    const f = await learnerFixture(db);
    const storage = await mkdtemp(join(tmpdir(), 'photo-intake-'));
    const service = new WorkbookPhotoService(
      db,
      ({ own, relationshipTypeId }) =>
        own || relationshipTypeId === f.guardianType.id,
      () => true,
      { storage },
    );
    const pages = [
      {
        name: 'original.png',
        mimeType: 'image/png' as const,
        data: Buffer.from('original private cover'),
      },
    ];
    const receive = async (itemId = 'receipt-1') =>
      f.as(f.own, () =>
        service.retainWorkbookPhotoIntake({ ...f.own, itemId, pages }),
      );
    const identification: WorkbookPhotoIdentification & {
      workbook: NonNullable<WorkbookPhotoIdentification['workbook']>;
    } = {
      kind: 'cover',
      workbook: {
        workbookKey: 'printed-book-1',
        title: 'Arithmetic',
        edition: '1',
        publisher: 'Example Press',
      },
      workState: 'unknown',
    };
    return {
      ...f,
      db,
      service,
      pages,
      storage,
      receive,
      identification,
      finish: async () => {
        await cleanup();
        await rm(storage, { recursive: true, force: true });
      },
    };
  }
  it('marks visible completed work before identity and preserves its lineage when filed later', async () => {
    const f = await fixture();
    try {
      const photo = await f.receive('visible-work-no-book-or-lesson');
      const req = { ...f.own, intakeId: photo.id };
      const proposal: WorkbookPhotoProposal = {
        identification: { kind: 'work', workState: 'completed' },
        confidence: 'confident',
        identityEvidence: [],
        lessonEvidence: '',
      };
      const resolved = await f.as(f.own, () =>
        f.service[preservePhotoProposal]({
          ...req,
          requestKey: 'identify-visible-work',
          proposal,
          provenance: { revision: 1 },
          sourceHashes: photo.originals.map((o) => o.sha256),
          allowAutomaticResolution: true,
        }),
      );
      expect(resolved.status).toBe('resolved');
      expect(resolved.identification?.workbook).toBeUndefined();
      expect(resolved.activity?.filing?.state).toBe('unfiled');
      expect(
        await f.as(f.own, () => f.service.listWorkbookPhotoWorkbooks(f.own)),
      ).toEqual([]);
      const attempt = await f.as(f.own, () =>
        f.service.captureWorkbookPhotoIntake({
          ...req,
          requestKey: 'capture-visible-work',
        }),
      );
      expect(
        (
          await f.as(f.own, () =>
            f.service.captureWorkbookPhotoIntake({
              ...req,
              requestKey: 'capture-visible-work',
            }),
          )
        ).id,
      ).toBe(attempt.id);
      const captured = await f.as(f.own, () =>
        f.service.getWorkbookPhotoIntake(req),
      );
      if (!captured.activity) throw new Error('No durable work unit');
      const activity = captured.activity;
      expect(activity.workbookKey).toBe('');
      expect(activity.title).toBe('');
      const marking = {
        ...f.parent,
        activityId: activity.id,
        submissionId: attempt.submissionId,
      };
      const anchors = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(marking),
      );
      const assessment: WorkbookAssessment = {
        version: 1,
        feedback: 'Visible work only',
        questions: [
          {
            id: 'q1',
            prompt: '2 + 2',
            answer: '4',
            result: 'correct',
            reason: 'none',
            feedback: 'Correct visible response',
            points: null,
            possiblePoints: null,
            anchors: [
              {
                assetId: anchors[0].assetId,
                sha256: anchors[0].sha256,
                page: 1,
                rect: [0, 0, 1, 1],
              },
            ],
            conceptIds: ['math.addition'],
          },
          {
            id: 'q2',
            prompt: 'Visible matching task',
            answer: '',
            result: 'unassessed',
            reason: 'illegible',
            feedback: 'Connection endpoint unreadable',
            points: null,
            possiblePoints: null,
            anchors: [
              {
                assetId: anchors[0].assetId,
                sha256: anchors[0].sha256,
                page: 1,
                rect: [0, 0, 1, 1],
              },
            ],
            conceptIds: [],
            markingCertainty: 'uncertain',
          },
        ],
        provenance: {
          provider: 'fixture',
          model: 'fixture',
          configurationVersion: '1',
          rubricVersion: '1',
          inputHash: anchors[0].sha256,
          analysisId: 'unfiled-visible-analysis',
        },
        vocabulary: WORKBOOK_MATH_VOCABULARY,
      };
      const ai = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...marking,
          requestKey: 'unfiled-ai',
          assessment,
        }),
      );
      const before = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({ ...marking, limit: 1 }),
      );
      expect(before.attempts[0].revisions[0].id).toBe(ai.id);
      expect(before.attempts[0].reviewRequired).toBe(true);
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getSubmission({
              ...f.parent,
              enrollmentId: activity.enrollmentId,
              submissionId: attempt.submissionId,
            }),
          )
        ).grade,
      ).toBeNull();
      const reviewed = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...marking,
          revisionId: ai.id,
          expectedHeadId: null,
          requestKey: 'review-unfiled',
          assessment,
        }),
      );
      const conceptsBefore = await f.as(f.parent, () =>
        f.service.getConceptEvidenceSummary(marking),
      );
      const filed = await f.as(f.parent, () =>
        f.service.fileWorkbookWork({
          ...f.parent,
          activityId: activity.id,
          newWorkbook: { title: 'Arithmetic', edition: '1' },
          expectedRevisionId: null,
          requestKey: 'file-real-book',
          reason: 'Guardian files existing work',
        }),
      );
      expect(filed.id).toBe(activity.id);
      expect(filed.filing?.state).toBe('filed');
      expect(filed.enrollmentId).toBe(activity.enrollmentId);
      expect(filed.lessonId).toBe(activity.lessonId);
      expect(
        await f.as(f.parent, () =>
          f.service.getConceptEvidenceSummary(marking),
        ),
      ).toEqual(conceptsBefore);
      const after = await f.as(f.parent, () =>
        f.service.getWorkbookTimeline({ ...marking, limit: 1 }),
      );
      expect(after.attempts[0].id).toBe(attempt.id);
      expect(after.attempts[0].submissionId).toBe(attempt.submissionId);
      expect(after.attempts[0].revisions.map((r) => r.id)).toContain(ai.id);
      expect(after.attempts[0].revisions.map((r) => r.id)).toContain(
        reviewed.id,
      );
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getWorkbookPhotoIntake({
              ...f.parent,
              intakeId: photo.id,
            }),
          )
        ).activity?.filing?.state,
      ).toBe('filed');
      const original = await f.as(f.parent, () =>
        f.service.readWorkbookPhotoOriginal({
          ...f.parent,
          intakeId: photo.id,
          assetId: photo.originals[0].assetId,
        }),
      );
      expect(Buffer.from(original.data)).toEqual(f.pages[0].data);
    } finally {
      await f.finish();
    }
  });
  it('keeps guardian-origin unfiled work private until its exact explicit release', async () => {
    const f = await fixture();
    try {
      const photo = await f.as(f.parent, () =>
        f.service.retainWorkbookPhotoIntake({
          ...f.parent,
          itemId: 'guardian-unfiled',
          pages: f.pages,
        }),
      );
      const req = { ...f.parent, intakeId: photo.id };
      const resolved = await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...req,
          requestKey: 'observed-work',
          identification: { kind: 'work', workState: 'completed' },
        }),
      );
      if (!resolved.activity) throw new Error('Missing unfiled activity');
      const activity = resolved.activity;
      const attempt = await f.as(f.parent, () =>
        f.service.captureWorkbookPhotoIntake({ ...req, requestKey: 'capture' }),
      );
      const marking = {
        ...f.parent,
        activityId: activity.id,
        submissionId: attempt.submissionId,
      };
      const [source] = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(marking),
      );
      const assessment: WorkbookAssessment = {
        version: 1,
        feedback: 'Guardian-private visible work',
        questions: [
          {
            id: 'q1',
            prompt: '2 + 2',
            answer: '4',
            result: 'correct',
            reason: 'none',
            feedback: 'Correct response',
            points: null,
            possiblePoints: null,
            anchors: [
              {
                assetId: source.assetId,
                sha256: source.sha256,
                page: 1,
                rect: [0, 0, 1, 1],
              },
            ],
            conceptIds: ['math.addition'],
          },
        ],
        provenance: {
          provider: 'fixture',
          model: 'fixture',
          configurationVersion: '1',
          rubricVersion: '1',
          inputHash: source.sha256,
          analysisId: 'private-unfiled-analysis',
        },
        vocabulary: WORKBOOK_MATH_VOCABULARY,
      };
      const ai = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...marking,
          requestKey: 'assessment',
          assessment,
        }),
      );
      const child = {
        ...f.own,
        enrollmentId: activity.enrollmentId,
        submissionId: attempt.submissionId,
      };
      const base = new SubmissionService(
        f.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === f.guardianType.id,
        () => true,
        { storage: f.storage },
      );
      const before = await f.as(f.own, () => base.getSubmission(child));
      expect(before.awaitingParentRelease).toBe(true);
      expect(before.pages).toEqual([]);
      expect(before.grade).toBeNull();
      expect(
        (
          await f.as(f.own, () =>
            f.service.getWorkbookTimeline({
              ...f.own,
              activityId: activity.id,
            }),
          )
        ).attempts[0].revisions,
      ).toEqual([]);
      await f.as(f.own, () =>
        expect(
          f.service.getWorkbookPhotoIntake({ ...f.own, intakeId: photo.id }),
        ).rejects.toThrow(),
      );
      await f.as(f.own, () =>
        expect(
          f.service.readWorkbookPhotoOriginal({
            ...f.own,
            intakeId: photo.id,
            assetId: photo.originals[0].assetId,
          }),
        ).rejects.toThrow(),
      );
      const reviewed = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...marking,
          revisionId: ai.id,
          expectedHeadId: null,
          requestKey: 'review',
          assessment,
        }),
      );
      await f.as(f.parent, () =>
        f.service.releaseWorkbookFeedback({
          ...marking,
          revisionId: reviewed.id,
          expectedHeadId: reviewed.id,
          requestKey: 'release',
        }),
      );
      expect(
        (await f.as(f.own, () => base.getSubmission(child))).pages,
      ).toHaveLength(1);
      expect(
        (
          await f.as(f.own, () =>
            f.service.getWorkbookPhotoTimeline({
              ...f.own,
              intakeId: photo.id,
              limit: 1,
            }),
          )
        ).attempts[0].revisions.map((r) => r.id),
      ).toContain(reviewed.id);
      expect(
        Buffer.from(
          (
            await f.as(f.own, () =>
              f.service.readWorkbookPhotoOriginal({
                ...f.own,
                intakeId: photo.id,
                assetId: photo.originals[0].assetId,
              }),
            )
          ).data,
        ),
      ).toEqual(f.pages[0].data);
      const later = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...marking,
          requestKey: 'later-unreleased',
          assessment: {
            ...assessment,
            provenance: {
              ...assessment.provenance,
              analysisId: 'later-unreleased-analysis',
            },
          },
        }),
      );
      const visible = await f.as(f.own, () =>
        f.service.getWorkbookPhotoTimeline({
          ...f.own,
          intakeId: photo.id,
          limit: 1,
        }),
      );
      expect(visible.attempts[0].revisions.map((r) => r.id)).not.toContain(
        later.id,
      );
      expect(visible.attempts[0].revisions.map((r) => r.id)).toContain(
        reviewed.id,
      );
    } finally {
      await f.finish();
    }
  });

  it('does not confuse uncertain material, blank pages or claimed identity with unfiled completed work', async () => {
    const f = await fixture();
    try {
      const photo = await f.receive('uncertain-unfiled');
      const req = {
        ...f.own,
        intakeId: photo.id,
        sourceHashes: photo.originals.map((o) => o.sha256),
        provenance: { revision: 1 },
        allowAutomaticResolution: true,
      };
      const pending = await f.as(f.own, () =>
        f.service[preservePhotoProposal]({
          ...req,
          requestKey: 'uncertain-classification',
          proposal: {
            identification: { kind: 'work', workState: 'completed' },
            confidence: 'uncertain',
            identityEvidence: [],
            lessonEvidence: '',
          },
        }),
      );
      expect(pending.status).toBe('pending');
      expect(pending.activity).toBeNull();
      await f.as(f.own, () =>
        expect(
          f.service.captureWorkbookPhotoIntake({
            ...f.own,
            intakeId: photo.id,
            requestKey: 'not-completed',
          }),
        ).rejects.toThrow(),
      );
      for (const identification of [
        { kind: 'work', workState: 'blank' },
        { kind: 'work', workState: 'unknown' },
        {
          kind: 'work',
          workState: 'completed',
          workbook: { workbookKey: 'invented', title: 'Invented' },
        },
      ] as WorkbookPhotoIdentification[]) {
        await f.as(f.parent, () =>
          expect(
            f.service.resolveWorkbookPhotoIntake({
              ...f.parent,
              intakeId: photo.id,
              requestKey: 'bad-work',
              identification,
            }),
          ).rejects.toThrow('Unfiled work'),
        );
      }
      expect(
        await f.as(f.own, () => f.service.listWorkbookActivities(f.own)),
      ).toEqual([]);
    } finally {
      await f.finish();
    }
  });
  it('authorizes an exact durable receipt beyond the inbox window without weakening ownership or privacy', async () => {
    const f = await fixture();
    try {
      await f.as(f.own, async () => {
        if (!f.db.transaction)
          throw new Error('Transactional fixture required');
        await f.db.transaction(async (db) => {
          const rows = await WorkbookPhotoIntakeCollection.create({ db });
          for (let index = 0; index < 1000; index++)
            await rows.create({
              tenantId: f.own.tenantId,
              learnerId: f.own.learnerId,
              actorUserId: f.own.actorUserId,
              itemId: `older-${index}`,
              contentDigest: 'a'.repeat(64),
              createdAt: new Date('2000-01-01T00:00:00Z'),
            });
        });
      });
      const target = await f.receive('beyond-inbox-window');
      const context: HandlerContext = {
        db: f.db,
        scope: {
          tenantId: f.own.tenantId,
          actorId: f.own.actorUserId,
          confidentialScopeId: f.own.learnerId,
        },
        itemId: target.itemId,
        policy: { requireReview: true } as HandlerContext['policy'],
        assertTarget: async () => {},
      };
      const handler = workbookPhotoIntakeHandlers({
        workbooks: f.service,
        request: f.own,
      })[0];
      const args = JSON.parse(
        JSON.stringify({
          identification: f.identification,
          confidence: 'confident',
          identityEvidence: ['Arithmetic', 'Edition1'],
          lessonEvidence: '',
        }),
      );
      await f.as(f.own, async () => {
        const listed = await f.service.listWorkbookPhotoIntakes(f.own);
        expect(listed).toHaveLength(1000);
        expect(listed.some((row) => row.id === target.id)).toBe(false);
        const newest = await f.service.listWorkbookPhotoIntakes(f.own, {
          newestFirst: true,
        });
        expect(newest).toHaveLength(1000);
        expect(newest[0].id).toBe(target.id);
        await expect(handler.validate(args, context)).resolves.toEqual({
          ok: true,
        });
        expect(
          (
            await f.service.getWorkbookPhotoIntakeByItem({
              ...f.own,
              itemId: target.itemId,
            })
          ).id,
        ).toBe(target.id);
        await expect(handler.preview(args, context)).resolves.toMatchObject({
          display: { gradeApplied: false },
        });
        await expect(
          handler.discovery!.candidates!('', context, { limit: 10 }),
        ).resolves.toMatchObject({ items: [] });
        await expect(
          f.service.getWorkbookPhotoIntakeByItem({
            ...f.own,
            itemId: 'missing-item',
          }),
        ).rejects.toThrow();
        await expect(
          f.service.getWorkbookPhotoIntakeByItem({
            ...f.own,
            learnerId: String(f.sibling.id),
            itemId: target.itemId,
          }),
        ).rejects.toThrow();
        await expect(
          f.service.getWorkbookPhotoIntakeByItem({
            ...f.own,
            learnerId: String(f.foreign.id),
            itemId: target.itemId,
          }),
        ).rejects.toThrow();
      });
      await f.as({ ...f.own, tenantId: f.foreign.tenantId }, () =>
        expect(
          f.service.getWorkbookPhotoIntakeByItem({
            ...f.own,
            itemId: target.itemId,
          }),
        ).rejects.toThrow(),
      );
      const hidden = await f.as(f.parent, () =>
        f.service.retainWorkbookPhotoIntake({
          ...f.parent,
          itemId: 'guardian-hidden',
          pages: f.pages,
        }),
      );
      await f.as(f.own, () =>
        expect(
          handler.validate(args, { ...context, itemId: hidden.itemId }),
        ).rejects.toThrow(),
      );
      const parentHandler = workbookPhotoIntakeHandlers({
        workbooks: f.service,
        request: f.parent,
      })[0];
      const parentContext = {
        ...context,
        scope: { ...context.scope, actorId: f.parent.actorUserId },
      };
      await f.as(f.parent, () =>
        expect(parentHandler.validate(args, parentContext)).resolves.toEqual({
          ok: true,
        }),
      );
      await f.db.query(
        'UPDATE profile_relationships SET to_profile_id=? WHERE id=?',
        [String(f.bob.profile.id), String(f.relationship.id)],
      );
      await f.as(f.parent, () =>
        expect(parentHandler.validate(args, parentContext)).rejects.toThrow(),
      );
    } finally {
      await f.finish();
    }
  }, 60000);

  it('authorizes before intake and retains private originals without an activity', async () => {
    const f = await fixture();
    try {
      await f.as(f.own, () => f.service.authorizePhotoIntake(f.own));
      const view = await f.receive();
      expect(view.status).toBe('pending');
      expect(view.activity).toBeNull();
      expect(view.submissionId).toBeNull();
      const original = await f.as(f.parent, () =>
        f.service.readWorkbookPhotoOriginal({
          ...f.parent,
          intakeId: view.id,
          assetId: view.originals[0].assetId,
        }),
      );
      expect(Buffer.from(original.data)).toEqual(f.pages[0].data);
      expect(
        (await f.db.get('assets', { id: view.originals[0].assetId }))
          ?.access_mode,
      ).toBe('private');
      await f.as(f.own, async () => {
        await expect(
          f.service.authorizePhotoIntake({
            ...f.own,
            actorUserId: f.parent.actorUserId,
          }),
        ).rejects.toThrow();
        await expect(
          f.service.getWorkbookPhotoIntake({
            ...f.own,
            learnerId: String(f.sibling.id),
            intakeId: view.id,
          }),
        ).rejects.toThrow();
        await expect(
          f.service.readWorkbookPhotoOriginal({
            ...f.own,
            intakeId: view.id,
            assetId: crypto.randomUUID(),
          }),
        ).rejects.toThrow();
      });
      expect(
        (
          await f.as(f.own, () => f.service.listWorkbookPhotoIntakes(f.own))
        ).map((r) => r.id),
      ).toContain(view.id);
    } finally {
      await f.finish();
    }
  });
  it('deduplicates receipt and cover decisions and keeps context separate from immutable book identity', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      expect((await f.receive()).id).toBe(view.id);
      await f.as(f.own, () =>
        expect(
          f.service.retainWorkbookPhotoIntake({
            ...f.own,
            itemId: view.itemId,
            pages: [{ ...f.pages[0], data: Buffer.from('changed') }],
          }),
        ).rejects.toThrow('conflict'),
      );
      await f.as(f.own, () =>
        expect(
          f.service.resolveWorkbookPhotoIntake({
            ...f.own,
            intakeId: view.id,
            requestKey: 'cover',
            identification: f.identification,
          }),
        ).rejects.toThrow(),
      );
      const counts = async () =>
        Promise.all(
          [
            'workbook_activities',
            'submissions',
            'grades',
            'lesson_progress',
          ].map(
            async (table) =>
              (await f.db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]
                .n,
          ),
        );
      const before = await counts();
      await f.as(f.parent, async () => {
        const req = {
          ...f.parent,
          intakeId: view.id,
          requestKey: 'cover',
          identification: f.identification,
        };
        const first = await f.service.resolveWorkbookPhotoIntake(req);
        expect(first.status).toBe('resolved');
        expect(first.activity).toBeNull();
        await f.service.resolveWorkbookPhotoIntake(req);
        await expect(
          f.service.resolveWorkbookPhotoIntake({
            ...req,
            identification: { ...f.identification, notes: 'changed' },
          }),
        ).rejects.toThrow('conflict');
        const context = await WorkbookContextRevisionCollection.create({
          db: f.db,
        });
        expect(
          (await context.list({ where: { tenantId: f.parent.tenantId } }))
            .length,
        ).toBe(1);
        await expect(
          f.service.resolveWorkbookPhotoIntake({
            ...req,
            requestKey: 'changed-title',
            identification: {
              ...f.identification,
              workbook: {
                ...f.identification.workbook,
                title: 'Another title',
              },
            },
          }),
        ).rejects.toThrow('another title');
      });
      expect(await counts()).toEqual(before);
    } finally {
      await f.finish();
    }
  });
  it('keeps generic titles pending, appends grounded context, and reuses ISBN cover identity', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      const proposal: WorkbookPhotoProposal = {
        identification: f.identification,
        confidence: 'confident',
        identityEvidence: [
          'Arithmetic',
          'Example Press',
          'Edition 1',
          'ISBN 9781234567897',
        ],
        lessonEvidence: '',
      };
      await f.as(f.parent, async () => {
        const req = {
          ...f.parent,
          intakeId: view.id,
          requestKey: 'analysis-1',
          proposal: {
            ...proposal,
            identification: {
              kind: 'cover' as const,
              workbook: { workbookKey: 'generic', title: 'Math' },
            },
          },
          provenance: { revision: 1 },
          allowAutomaticResolution: true,
          sourceHashes: view.originals.map((o) => o.sha256),
        };
        expect((await f.service[preservePhotoProposal](req)).status).toBe(
          'pending',
        );
        await expect(
          f.service[preservePhotoProposal]({
            ...req,
            sourceHashes: ['foreign'],
          }),
        ).rejects.toThrow('source');
        const confident = {
          ...proposal,
          identification: {
            ...f.identification,
            workbook: { ...f.identification.workbook, isbn: '9781234567897' },
          },
        };
        const resolved = await f.service[preservePhotoProposal]({
          ...req,
          requestKey: 'analysis-2',
          proposal: confident,
        });
        expect(resolved.status).toBe('resolved');
        expect(resolved.identification?.workbook?.workbookKey).toBe(
          'isbn:9781234567897',
        );
        expect(resolved.activity).toBeNull();
        expect(
          (
            await f.service[preservePhotoProposal]({
              ...req,
              requestKey: 'analysis-2',
              proposal: confident,
            })
          ).id,
        ).toBe(view.id);
      });
    } finally {
      await f.finish();
    }
  });
  it('requires explicit completed work for blank lessons and captures multi-page lesson once', async () => {
    const f = await fixture();
    try {
      const view = await f.as(f.own, () =>
        f.service.retainWorkbookPhotoIntake({
          ...f.own,
          itemId: 'multi-page',
          pages: [
            ...f.pages,
            {
              ...f.pages[0],
              name: 'second.png',
              data: Buffer.from('second page same printed lesson'),
            },
          ],
        }),
      );
      await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...f.parent,
          intakeId: view.id,
          requestKey: 'lesson',
          identification: {
            ...f.identification,
            kind: 'lesson',
            activity: {
              pageKey: 'lesson:1',
              pageLabel: 'Lesson 1 — pages 7 and 8',
            },
            workState: 'blank',
          },
        }),
      );
      await f.as(f.own, async () => {
        const req = {
          ...f.own,
          intakeId: view.id,
          requestKey: 'intentional-attempt',
        };
        await expect(f.service.captureWorkbookPhotoIntake(req)).rejects.toThrow(
          'intentional',
        );
        const attempt = await f.service.captureWorkbookPhotoIntake({
          ...req,
          completedWork: true,
        });
        expect(attempt.submission.pages).toHaveLength(2);
        expect(
          (
            await f.service.captureWorkbookPhotoIntake({
              ...req,
              completedWork: true,
            })
          ).id,
        ).toBe(attempt.id);
        await expect(
          f.service.captureWorkbookPhotoIntake({
            ...req,
            completedWork: true,
            assistance: 'assisted',
          }),
        ).rejects.toThrow('conflict');
        expect((await f.service.getWorkbookPhotoIntake(req)).status).toBe(
          'captured',
        );
      });
      await f.as(f.parent, () =>
        expect(
          f.service.resolveWorkbookPhotoIntake({
            ...f.parent,
            intakeId: view.id,
            requestKey: 'retarget',
            identification: f.identification,
          }),
        ).rejects.toThrow('immutable'),
      );
    } finally {
      await f.finish();
    }
  });
  it('serializes concurrent receipt retries and rolls back retained private files with metadata', async () => {
    const f = await fixture();
    try {
      const [first, second] = await Promise.all([
        f.receive('parallel'),
        f.receive('parallel'),
      ]);
      expect(first.id).toBe(second.id);
      await f.as(f.own, () =>
        expect(
          f.service.withTransaction(async (tx) => {
            await tx.retainWorkbookPhotoIntake({
              ...f.own,
              itemId: 'rollback',
              pages: f.pages,
            });
            throw new Error('abort after copy');
          }),
        ).rejects.toThrow('abort after copy'),
      );
      expect(
        await f.db.get('workbook_photo_intakes', {
          tenant_id: f.own.tenantId,
          item_id: 'rollback',
        }),
      ).toBeFalsy();
      const view = await f.receive('rollback');
      expect(view.originals).toHaveLength(1);
      await f.as(f.own, () =>
        expect(
          f.service.withExecutor(f.db, (tx) =>
            tx.retainWorkbookPhotoIntake({
              ...f.own,
              itemId: 'borrowed',
              pages: f.pages,
            }),
          ),
        ).rejects.toThrow('owned transaction'),
      );
    } finally {
      await f.finish();
    }
  });
  it('uses real ingestion generation for a cover then a completed lesson and preserves provider failure', async () => {
    const f = await fixture();
    try {
      await f.as(f.own, async () => {
        const scope = {
          tenantId: f.own.tenantId,
          actorId: f.own.actorUserId,
          confidentialScopeId: f.own.learnerId,
        };
        const principalId = '22222222-2222-4222-8222-222222222222';
        const operation =
          '@happyvertical/smrt-education:WorkbookPhotoIntake:get@1';
        const assets = await createAssetRuntime({
          db: f.db,
          storage: f.storage,
        });
        let proposal: WorkbookPhotoProposal = {
          confidence: 'confident',
          identityEvidence: ['Arithmetic', 'Example Press', 'Edition 1'],
          lessonEvidence: '',
          identification: f.identification,
        };
        let failure = false;
        let reviewRequired = false;
        const ingestion = new IngestionService({
          db: f.db,
          assets,
          scope,
          authorize: async () => true,
          jobTarget: { objectType: 'unused-worker', method: 'process' },
          purgeDerived: async () => {},
          proposals: {
            version: 'photo-test',
            promptVersion: '1',
            generator: {
              identity: { provider: 'fixture', model: 'fixture', version: '1' },
              generate: async (input) => {
                if (failure) throw new Error('provider offline');
                return {
                  completion: 'complete',
                  output: {
                    outcome: reviewRequired ? 'needs_review' : 'proposals',
                    suggestions: [
                      {
                        handlerId: WORKBOOK_PHOTO_HANDLER,
                        handlerVersion: '1',
                        args: JSON.parse(JSON.stringify(proposal)),
                        evidence: [
                          {
                            evidenceId: input.evidence[0].evidenceId,
                            location: { kind: 'source' },
                          },
                        ],
                        alternatives: [],
                        missingFields: [],
                        explanation: 'Synthetic current printed identity',
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
            handlers: workbookPhotoIntakeHandlers({
              workbooks: f.service,
              request: f.own,
            }),
            authorize: async () => ({
              allowed: true,
              reviewer: true,
              principalId,
              permissions: ['workbookphotointakes.read'],
              mutationBoundary: 'serialized',
              policy: [
                {
                  version: 'app',
                  providers: ['fixture'],
                  handlers: [WORKBOOK_PHOTO_HANDLER],
                  operations: [operation],
                  reviewers: [f.own.actorUserId],
                  access: [f.own.learnerId],
                  requireReview: true,
                },
                { version: 'tenant' },
                { version: 'source' },
              ],
            }),
            assertTarget: workbookPhotoIntakeTargetResolver({
              workbooks: f.service,
              request: f.own,
            }),
          },
        });
        async function generate(deliveryKey: string) {
          const result = await receiveWorkbookPhotoIntake({
            ingestion,
            scope,
            workbooks: f.service,
            request: f.own,
            receive: {
              sourceId: 'photo',
              sourceVersion: '1',
              deliveryKey,
              deliveredAt: new Date(),
              parts: [
                {
                  partId: 'page',
                  mediaType: 'image/png',
                  bytes: Buffer.from(deliveryKey),
                },
              ],
              capturedCeiling: {
                execution: {
                  principalId,
                  permissions: ['workbookphotointakes.read'],
                  handlers: [WORKBOOK_PHOTO_HANDLER],
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
            },
          });
          if (!result.intake) throw new Error('Missing photo intake');
          const itemId = result.intake.itemId;
          const evidence = (await ingestion.getEvidence(itemId))[0];
          const analysis = await ingestion.analyze(
            itemId,
            { stage: 'extract', extraction: { configurationRevision: '1' } },
            'extract',
          );
          const lease = await ingestion.claimAnalysis(
            itemId,
            analysis.revision,
            'worker',
          );
          if (!lease) throw new Error('Missing extraction lease');
          await ingestion.completeAnalysis(lease, {
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
                      text: proposal.identityEvidence.join(' '),
                      location: { kind: 'source' },
                      boxes: null,
                    },
                  ],
                  capabilities: [{ location: 'source', boxes: false }],
                },
              ],
            },
          });
          const generation = await ingestion.analyze(
            itemId,
            await ingestion.prepareGeneration(itemId, lease.attemptId),
            'interpret',
          );
          const generationLease = await ingestion.claimAnalysis(
            itemId,
            generation.revision,
            'worker',
          );
          if (!generationLease) throw new Error('Missing interpretation lease');
          await ingestion.generateProposals(generationLease);
          return preserveWorkbookPhotoIdentification({
            ingestion,
            scope,
            workbooks: f.service,
            request: { ...f.own, intakeId: result.intake.id },
          });
        }
        const cover = await generate('cover');
        expect(cover.status).toBe('resolved');
        expect(cover.activity).toBeNull();
        expect(await f.service.listWorkbookPhotoWorkbooks(f.own)).toHaveLength(
          1,
        );
        const candidate = (
          await f.service.listWorkbookPhotoWorkbooks(f.own)
        )[0];
        // Exact malformed live-model shape: a selected candidate does not waive
        // the required workbookKey. Keep it pending, never repair the payload.
        proposal = {
          confidence: 'confident',
          workbookId: candidate.id,
          identityEvidence: [candidate.title, candidate.edition],
          lessonEvidence: '',
          identification: {
            kind: 'reference',
            workState: 'unknown',
            workbook: { title: candidate.title, edition: candidate.edition },
          },
        } as WorkbookPhotoProposal;
        const missingKey = await generate('reference-missing-candidate-key');
        expect(missingKey.status).toBe('pending');
        const refused = await ingestion.getCompletedAnalysis(missingKey.itemId);
        expect(
          (
            refused.result.output.proposals as {
              suggestions: Array<{ missingFields: string[] }>;
            }
          ).suggestions[0].missingFields,
        ).toContain('/identification/workbook/workbookKey');
        proposal.identification.workbook = {
          workbookKey: candidate.workbookKey,
          title: candidate.title,
          edition: candidate.edition,
        };
        const reference = await generate('reference-existing-identity');
        expect(reference.status).toBe('resolved');
        expect(reference.identification?.workbook?.workbookKey).toBe(
          candidate.workbookKey,
        );
        expect(reference.activity).toBeNull();
        expect(reference.submissionId).toBeNull();
        expect(await f.service.listWorkbookPhotoWorkbooks(f.own)).toHaveLength(
          1,
        );
        proposal.identification.workbook.publisher = 'Conflicting Press';
        const conflicting = await generate('reference-conflicting-publisher');
        expect(conflicting.status).toBe('pending');
        expect(await f.service.listWorkbookPhotoWorkbooks(f.own)).toHaveLength(
          1,
        );
        proposal.identification.workbook = { ...f.identification.workbook! };
        proposal.identification.kind = 'cover';
        proposal.workbookId = undefined;
        proposal.identityEvidence = [
          'Arithmetic',
          'Example Press',
          'Edition 1',
        ];
        reviewRequired = true;
        const uncertain = await generate('needs-guardian-review');
        expect(uncertain.status).toBe('pending');
        expect(uncertain.proposal?.confidence).toBe('confident');
        reviewRequired = false;
        proposal = {
          ...proposal,
          identityEvidence: ['Arithmetic', 'Edition 1'],
          lessonEvidence: 'Lesson 4',
          identification: {
            ...f.identification,
            workbook: {
              workbookKey: 'provider-hint',
              title: 'Arithmetic',
              edition: '1',
            },
            kind: 'lesson',
            activity: { pageKey: 'lesson:4', pageLabel: 'Lesson 4' },
            workState: 'completed',
          },
        };
        proposal.lessonEvidence = 'Page 7';
        const pageOnly = await generate('page-number-only');
        expect(pageOnly.status).toBe('pending');
        expect(pageOnly.activity).toBeNull();
        proposal.lessonEvidence = 'Lesson 4';
        const lesson = await generate('lesson');
        expect(lesson.status).toBe('resolved');
        expect(lesson.activity).not.toBeNull();
        expect(lesson.identification?.workbook?.workbookKey).toBe(
          cover.identification?.workbook?.workbookKey,
        );
        const attempt = await f.service.captureWorkbookPhotoIntake({
          ...f.own,
          intakeId: lesson.id,
          requestKey: `photo:${lesson.itemId}`,
        });
        expect(attempt.submission.grade).toBeNull();
        const repeated = await generate('same-lesson-new-photo');
        expect(repeated.activity?.id).toBe(lesson.activity?.id);
        await expect(
          f.service.captureWorkbookPhotoIntake({
            ...f.own,
            intakeId: repeated.id,
            requestKey: 'new-photo-not-a-correction',
          }),
        ).rejects.toThrow();
        expect(
          (
            await f.service.getWorkbookPhotoIntake({
              ...f.own,
              intakeId: repeated.id,
            })
          ).submissionId,
        ).toBeNull();
        if (!lesson.activity) throw new Error('Missing lesson activity');
        expect(
          (
            await f.service.getWorkbookAttemptBySubmission({
              ...f.own,
              enrollmentId: lesson.activity.enrollmentId,
              submissionId: attempt.submissionId,
            })
          )?.id,
        ).toBe(attempt.id);
        failure = true;
        const pending = await generate('provider-failure');
        expect(pending.status).toBe('pending');
        expect(pending.proposal).toBeNull();
        expect(
          (
            await f.service.readWorkbookPhotoOriginal({
              ...f.own,
              intakeId: pending.id,
              assetId: pending.originals[0].assetId,
            })
          ).data.length,
        ).toBeGreaterThan(0);
      });
    } finally {
      await f.finish();
    }
  });

  it('withholds guardian pending and reference originals from learners while preserving guardian and resolved lesson access', async () => {
    const f = await fixture();
    try {
      const view = await f.as(f.parent, () =>
        f.service.retainWorkbookPhotoIntake({
          ...f.parent,
          itemId: 'guardian-private-reference',
          pages: f.pages,
        }),
      );
      const deny = async () =>
        f.as(f.own, async () => {
          await expect(
            f.service.getWorkbookPhotoIntake({ ...f.own, intakeId: view.id }),
          ).rejects.toThrow();
          await expect(
            f.service.readWorkbookPhotoOriginal({
              ...f.own,
              intakeId: view.id,
              assetId: view.originals[0].assetId,
            }),
          ).rejects.toThrow();
          expect(
            (await f.service.listWorkbookPhotoIntakes(f.own)).some(
              (r) => r.id === view.id,
            ),
          ).toBe(false);
        });
      await deny();
      await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...f.parent,
          intakeId: view.id,
          requestKey: 'reference',
          identification: {
            ...f.identification,
            kind: 'reference',
            notes: 'Private answer key material',
          },
        }),
      );
      await deny();
      expect(
        (
          await f.as(f.parent, () =>
            f.service.readWorkbookPhotoOriginal({
              ...f.parent,
              intakeId: view.id,
              assetId: view.originals[0].assetId,
            }),
          )
        ).data.length,
      ).toBeGreaterThan(0);
      await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...f.parent,
          intakeId: view.id,
          requestKey: 'explicit-lesson',
          identification: {
            ...f.identification,
            kind: 'lesson',
            activity: {
              pageKey: 'lesson:explicit',
              pageLabel: 'Explicitly selected lesson',
            },
            workState: 'blank',
          },
        }),
      );
      await f.as(f.own, () =>
        expect(
          f.service.getWorkbookPhotoIntake({ ...f.own, intakeId: view.id }),
        ).rejects.toThrow(),
      );
    } finally {
      await f.finish();
    }
  });
  it('denies foreign ownership, changed active context and revoked guardian relationship', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      await f.as(f.own, () =>
        expect(
          f.service.getWorkbookPhotoIntake({
            ...f.own,
            learnerId: String(f.foreign.id),
            intakeId: view.id,
          }),
        ).rejects.toThrow(),
      );
      await f.as({ ...f.own, tenantId: f.foreign.tenantId }, () =>
        expect(
          f.service.getWorkbookPhotoIntake({ ...f.own, intakeId: view.id }),
        ).rejects.toThrow(),
      );
      await f.db.query(
        'UPDATE profile_relationships SET to_profile_id=? WHERE id=?',
        [String(f.bob.profile.id), String(f.relationship.id)],
      );
      await f.as(f.parent, () =>
        expect(
          f.service.getWorkbookPhotoIntake({ ...f.parent, intakeId: view.id }),
        ).rejects.toThrow(),
      );
      await f.db.query(
        'UPDATE profile_relationships SET to_profile_id=? WHERE id=?',
        [String(f.alice.profile.id), String(f.relationship.id)],
      );
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getWorkbookPhotoIntake({
              ...f.parent,
              intakeId: view.id,
            }),
          )
        ).id,
      ).toBe(view.id);
      await f.as(f.parent, () =>
        expect(
          f.service.resolveWorkbookPhotoIntake({
            ...f.parent,
            intakeId: view.id,
            requestKey: 'unknown-material',
            identification: { kind: 'unknown' as 'uncertain' },
          }),
        ).rejects.toThrow('Invalid photo'),
      );
    } finally {
      await f.finish();
    }
  });
  it('keeps guardian-origin mistaken lessons and derived feedback private until exact release even with provisional feedback enabled', async () => {
    const f = await fixture();
    try {
      const photo = await f.as(f.parent, () =>
        f.service.retainWorkbookPhotoIntake({
          ...f.parent,
          itemId: 'guardian-mistaken-lesson',
          pages: f.pages,
        }),
      );
      const resolved = await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...f.parent,
          intakeId: photo.id,
          requestKey: 'misclassified-as-lesson',
          identification: {
            ...f.identification,
            kind: 'lesson',
            activity: { pageKey: 'lesson:private-1', pageLabel: 'Lesson 1' },
            workState: 'completed',
          },
        }),
      );
      if (!resolved.activity) throw new Error('Missing activity');
      const activity = resolved.activity;
      await f.as(f.parent, () =>
        f.service.setWorkbookFeedbackPolicy({
          ...f.parent,
          activityId: activity.id,
          expectedPolicyVersion: activity.policyVersion,
          reviewRequired: false,
        }),
      );
      const attempt = await f.as(f.parent, () =>
        f.service.captureWorkbookPhotoIntake({
          ...f.parent,
          intakeId: photo.id,
          requestKey: 'guardian-photo-capture',
        }),
      );
      const request = {
        ...f.parent,
        activityId: activity.id,
        submissionId: attempt.submissionId,
      };
      const sources = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors(request),
      );
      const assessment: WorkbookAssessment = {
        version: 1,
        feedback: 'PRIVATE answer key feedback',
        questions: [
          {
            id: 'q1',
            prompt: 'PRIVATE question text',
            answer: 'PRIVATE answer',
            result: 'correct',
            reason: 'none',
            feedback: 'PRIVATE answer explanation',
            points: 1,
            possiblePoints: 1,
            anchors: [
              {
                assetId: sources[0].assetId,
                sha256: sources[0].sha256,
                page: 1,
                rect: [0, 0, 1, 1],
              },
            ],
            conceptIds: ['math.addition'],
          },
        ],
        provenance: {
          provider: 'fixture',
          model: 'fixture',
          configurationVersion: '1',
          rubricVersion: '1',
          inputHash: sources[0].sha256,
          analysisId: 'private-analysis',
        },
        vocabulary: WORKBOOK_MATH_VOCABULARY,
      };
      const ai = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...request,
          requestKey: 'private-ai',
          assessment,
        }),
      );
      const guardian = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...request,
          revisionId: ai.id,
          expectedHeadId: null,
          requestKey: 'private-review',
          assessment,
        }),
      );
      const sign = vi.fn(async () => 'https://private.example/signed');
      const base = new SubmissionService(
        f.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === f.guardianType.id,
        () => true,
        { storage: f.storage, signAsset: sign },
      );
      const child = {
        ...f.own,
        enrollmentId: activity.enrollmentId,
        submissionId: attempt.submissionId,
      };
      const assetId = attempt.submission.pages[0].assetId;
      await f.as(f.own, async () => {
        const hidden = await base.getSubmission(child);
        expect(hidden.pages).toEqual([]);
        expect(hidden.grade).toBeNull();
        expect(hidden.notes).toBe('');
        expect(hidden.awaitingParentRelease).toBe(true);
        expect(hidden.sourceRequiresParentRelease).toBe(true);
        expect(hidden.status).toBe('captured');
        await expect(
          base.signSubmissionAsset({ ...child, assetId }),
        ).rejects.toThrow();
        expect(sign).not.toHaveBeenCalled();
        const timeline = await f.service.getWorkbookTimeline({
          ...f.own,
          activityId: activity.id,
        });
        expect(timeline.attempts[0].submission.pages).toEqual([]);
        expect(timeline.attempts[0].revisions).toEqual([]);
        expect(timeline.attempts[0].submission.grade).toBeNull();
        await expect(
          f.service.acknowledgeWorkbookFeedbackDelivery({
            ...request,
            ...f.own,
            revisionId: ai.id,
            requestKey: 'guessed-ai',
          }),
        ).rejects.toThrow();
        await expect(
          f.service.getWorkbookPhotoIntake({ ...f.own, intakeId: photo.id }),
        ).rejects.toThrow();
        await expect(
          f.service.readWorkbookPhotoOriginal({
            ...f.own,
            intakeId: photo.id,
            assetId: photo.originals[0].assetId,
          }),
        ).rejects.toThrow();
      });
      await f.as(f.parent, async () => {
        const visible = await base.getSubmission({ ...child, ...f.parent });
        expect(visible.pages).toHaveLength(1);
        expect(visible.sourceRequiresParentRelease).toBe(true);
        expect(visible.grade).not.toBeNull();
        expect(
          (await base.signSubmissionAsset({ ...child, ...f.parent, assetId }))
            .url,
        ).toBe('https://private.example/signed');
        expect(
          (
            await f.service.getWorkbookTimeline({
              ...f.parent,
              activityId: activity.id,
            })
          ).attempts[0].revisions,
        ).toHaveLength(2);
        await f.service.releaseWorkbookFeedback({
          ...request,
          revisionId: guardian.id,
          expectedHeadId: guardian.id,
          requestKey: 'explicit-parent-release',
        });
      });
      await f.as(f.own, async () => {
        expect((await base.getSubmission(child)).pages).toHaveLength(1);
        expect(
          (await base.getSubmission(child)).awaitingParentRelease,
        ).toBeUndefined();
        expect(
          (await base.signSubmissionAsset({ ...child, assetId })).url,
        ).toBe('https://private.example/signed');
        const timeline = await f.service.getWorkbookTimeline({
          ...f.own,
          activityId: activity.id,
        });
        expect(timeline.attempts[0].revisions.map((r) => r.id)).toEqual([
          guardian.id,
        ]);
        expect(
          (
            await f.service.getWorkbookPhotoIntake({
              ...f.own,
              intakeId: photo.id,
            })
          ).id,
        ).toBe(photo.id);
        expect(
          (
            await f.service.readWorkbookPhotoOriginal({
              ...f.own,
              intakeId: photo.id,
              assetId: photo.originals[0].assetId,
            })
          ).data.length,
        ).toBeGreaterThan(0);
      });
      const nextAI = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...request,
          requestKey: 'new-unreleased-ai',
          assessment: {
            ...assessment,
            feedback: 'PRIVATE later reanalysis',
            provenance: {
              ...assessment.provenance,
              analysisId: 'later-private-analysis',
            },
          },
        }),
      );
      expect(
        (
          await f.as(f.own, () =>
            f.service.getWorkbookTimeline({
              ...f.own,
              activityId: activity.id,
            }),
          )
        ).attempts[0].revisions.map((r) => r.id),
      ).not.toContain(nextAI.id);
      const second = await f.as(f.parent, () =>
        f.service.retainWorkbookPhotoIntake({
          ...f.parent,
          itemId: 'guardian-other-lesson',
          pages: f.pages,
        }),
      );
      const other = await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...f.parent,
          intakeId: second.id,
          requestKey: 'other-lesson',
          identification: {
            ...f.identification,
            kind: 'lesson',
            activity: { pageKey: 'lesson:private-2', pageLabel: 'Lesson 2' },
            workState: 'completed',
          },
        }),
      );
      if (!other.activity) throw new Error('Missing second activity');
      const otherActivity = other.activity;
      const otherAttempt = await f.as(f.parent, () =>
        f.service.captureWorkbookPhotoIntake({
          ...f.parent,
          intakeId: second.id,
          requestKey: 'capture-other',
        }),
      );
      expect(
        (
          await f.as(f.own, () =>
            base.getSubmission({
              ...f.own,
              enrollmentId: otherActivity.enrollmentId,
              submissionId: otherAttempt.submissionId,
            }),
          )
        ).pages,
      ).toEqual([]);
      const ownPhoto = await f.receive('child-owned-unaffected');
      const ownResolution = await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...f.parent,
          intakeId: ownPhoto.id,
          requestKey: 'own-lesson',
          identification: {
            ...f.identification,
            kind: 'lesson',
            activity: { pageKey: 'lesson:own-visible', pageLabel: 'Own work' },
            workState: 'completed',
          },
        }),
      );
      if (!ownResolution.activity) throw new Error('Missing own activity');
      const ownActivity = ownResolution.activity;
      const ownAttempt = await f.as(f.own, () =>
        f.service.captureWorkbookPhotoIntake({
          ...f.own,
          intakeId: ownPhoto.id,
          requestKey: 'own-capture',
        }),
      );
      const ownRequest = {
        ...f.own,
        activityId: ownActivity.id,
        submissionId: ownAttempt.submissionId,
      };
      const ownSources = await f.as(f.own, () =>
        f.service.getWorkbookSourceAnchors(ownRequest),
      );
      const ownAI = await f.as(f.own, () =>
        f.service.recordWorkbookAnalysis({
          ...ownRequest,
          requestKey: 'own-ai',
          assessment: {
            ...assessment,
            questions: assessment.questions.map((q) => ({
              ...q,
              anchors: [
                {
                  assetId: ownSources[0].assetId,
                  sha256: ownSources[0].sha256,
                  page: 1,
                  rect: [0, 0, 1, 1],
                },
              ],
            })),
            provenance: {
              ...assessment.provenance,
              inputHash: ownSources[0].sha256,
              analysisId: 'own-visible-analysis',
            },
          },
        }),
      );
      await f.as(f.own, async () => {
        const ordinary = await base.getSubmission({
          ...ownRequest,
          enrollmentId: ownActivity.enrollmentId,
        });
        expect(ordinary.pages).toHaveLength(1);
        expect(ordinary.awaitingParentRelease).toBeUndefined();
        expect(ordinary.sourceRequiresParentRelease).toBeUndefined();
        expect(
          (
            await f.service.getWorkbookTimeline({
              ...f.own,
              activityId: ownActivity.id,
            })
          ).attempts[0].revisions.map((r) => r.id),
        ).toContain(ownAI.id);
      });
    } finally {
      await f.finish();
    }
  });
}
