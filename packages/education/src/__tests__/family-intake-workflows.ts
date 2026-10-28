import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStore, createAssetRuntime } from '@happyvertical/smrt-assets';
import { IngestionService } from '@happyvertical/smrt-ingestion/server';
import { ProfileRelationshipCollection } from '@happyvertical/smrt-profiles';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it, vi } from 'vitest';
import { familyIntakeScopeId } from '../family-intake-contracts.js';
import {
  receiveFamilyIntake,
  retainFamilyIntakeReceipt,
} from '../family-intake-ingestion.js';
import {
  FamilyIntake,
  FamilyIntakeAsset,
  FamilyIntakeDecision,
} from '../family-intake-models.js';
import { FamilyIntakeService } from '../family-intake-service.js';
import {
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
} from '../workbook-contracts.js';
import {
  WorkbookPhotoAssetCollection,
  WorkbookPhotoIntakeCollection,
} from '../workbook-photo-models.js';
import { learnerFixture } from './learner-workflows.js';
import { photoClasses } from './photo-intake-workflows.js';

export const familyClasses = [
  ...photoClasses,
  'FamilyIntake',
  'FamilyIntakeAsset',
  'FamilyIntakeDecision',
];
export function familyIntakeTests(
  factory: () => Promise<{
    db: DatabaseInterface;
    cleanup: () => Promise<void>;
  }>,
) {
  async function fixture() {
    const { db, cleanup } = await factory();
    const f = await learnerFixture(db);
    const parent = {
      ...f.parent,
      guardianRelationshipId: String(f.relationship.id),
    };
    const storage = await mkdtemp(join(tmpdir(), 'family-intake-'));
    let permitted = true;
    const service = new FamilyIntakeService(
      db,
      ({ own, relationshipTypeId }) =>
        own || relationshipTypeId === f.guardianType.id,
      () => true,
      { storage },
      ({ actorUserId, executor }) =>
        permitted && actorUserId === f.parent.actorUserId && Boolean(executor),
    );
    const pages = [
      {
        name: 'work.png',
        mimeType: 'image/png' as const,
        data: Buffer.from('private completed arithmetic'),
      },
    ];
    const receipt = {
      tenantId: parent.tenantId,
      actorUserId: parent.actorUserId,
      itemId: 'family-receipt',
      source: {
        sourceId: 'scanner',
        sourceVersion: '1',
        deliveryKey: 'delivery-1',
      },
      pages,
    };
    const receive = () =>
      f.as(f.parent, () => service.retainFamilyIntake(receipt));
    return {
      ...f,
      parent,
      storage,
      db,
      service,
      pages,
      receipt,
      receive,
      revoke: () => {
        permitted = false;
      },
      finish: async () => {
        await cleanup();
        await rm(storage, { recursive: true, force: true });
      },
    };
  }
  it('retains only public source provenance fields, never adapter secrets', async () => {
    const f = await fixture();
    try {
      const source = {
        ...f.receipt.source,
        credentials: 'not-retained',
        headers: { authorization: 'not-retained' },
      };
      const view = await f.as(f.parent, () =>
        f.service.retainFamilyIntake({ ...f.receipt, source }),
      );
      expect(view.source).toEqual(f.receipt.source);
      expect(JSON.stringify(view)).not.toContain('not-retained');
    } finally {
      await f.finish();
    }
  });
  it('retains private unknown originals with exact bytes, hash and provenance; validates delivery retries', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      expect(view).toMatchObject({
        learnerId: null,
        photoIntakeId: null,
        revision: 0,
        source: f.receipt.source,
      });
      expect(await f.receive()).toEqual(view);
      expect(view.originals[0].sha256).toBe(
        createHash('sha256').update(f.pages[0].data).digest('hex'),
      );
      const request = { ...f.parent, intakeId: view.id };
      const original = await f.as(f.parent, () =>
        f.service.readFamilyIntakeOriginal({
          ...request,
          assetId: view.originals[0].assetId,
        }),
      );
      expect(Buffer.from(original.data)).toEqual(f.pages[0].data);
      expect(
        await f.as(f.parent, () => f.service.countFamilyIntakes(f.parent)),
      ).toBe(1);
      expect(
        await f.as(f.parent, () => f.service.getFamilyIntakeTimeline(request)),
      ).toEqual([]);
      await f.as(f.parent, () =>
        expect(
          f.service.retainFamilyIntake({
            ...f.receipt,
            pages: [{ ...f.pages[0], data: Buffer.from('changed') }],
          }),
        ).rejects.toThrow(),
      );
      await f.as(f.parent, () =>
        expect(
          f.service.retainFamilyIntake({
            ...f.receipt,
            source: { ...f.receipt.source, deliveryKey: 'changed' },
          }),
        ).rejects.toThrow(),
      );
    } finally {
      await f.finish();
    }
  });
  it('revalidates guardian permission on every family read and mutation', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      const selection = { ...f.parent, intakeId: view.id };
      await f.as(f.own, () =>
        expect(
          f.service.getFamilyIntake({
            ...selection,
            actorUserId: f.own.actorUserId,
          }),
        ).rejects.toThrow(),
      );
      await expect(f.service.getFamilyIntake(selection)).rejects.toThrow();
      await f.as(f.own, () =>
        expect(f.service.getFamilyIntake(selection)).rejects.toThrow(),
      );
      await f.as(f.parent, () =>
        expect(
          f.service.readFamilyIntakeOriginal({
            ...selection,
            assetId: '22222222-2222-4222-8222-222222222222',
          }),
        ).rejects.toThrow(),
      );

      await f.as(f.parent, () =>
        expect(
          f.service.assignFamilyIntake({
            ...selection,
            learnerId: String(f.foreign.id),
            requestKey: 'foreign',
            expectedRevision: 0,
            reason: 'explicit',
          }),
        ).rejects.toThrow(),
      );
      await f.as(f.parent, () =>
        expect(
          f.service.assignFamilyIntake({
            ...selection,
            learnerId: String(f.sibling.id),
            requestKey: 'sibling',
            expectedRevision: 0,
            reason: 'explicit',
          }),
        ).rejects.toThrow(),
      );
      f.revoke();
      await f.as(f.parent, async () => {
        for (const operation of [
          () => f.service.getFamilyIntake(selection),
          () => f.service.listFamilyIntakes(f.parent),
          () => f.service.countFamilyIntakes(f.parent),
          () => f.service.getFamilyIntakeTimeline(selection),
          () =>
            f.service.readFamilyIntakeOriginal({
              ...selection,
              assetId: view.originals[0].assetId,
            }),
          () =>
            f.service.assignFamilyIntake({
              ...selection,
              requestKey: 'revoked',
              expectedRevision: 0,
              reason: 'explicit',
            }),
          () =>
            f.service.adoptFamilyIntake({
              ...selection,
              requestKey: 'revoked-adopt',
              expectedRevision: 0,
            }),
          f.receive,
        ])
          await expect(operation()).rejects.toThrow();
      });
    } finally {
      await f.finish();
    }
  });
  it('separates audited assignment, adoption and completed-work capture with stable retries', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      const selection = { ...f.parent, intakeId: view.id };
      const assignment = {
        ...selection,
        requestKey: 'assign',
        expectedRevision: 0,
        reason: 'Guardian identified whole document',
      };
      await f.as(f.parent, () =>
        expect(
          f.service.adoptFamilyIntake({
            ...selection,
            requestKey: 'early-adopt',
            expectedRevision: 0,
          }),
        ).rejects.toThrow(),
      );
      const assigned = await f.as(f.parent, () =>
        f.service.assignFamilyIntake(assignment),
      );
      expect(assigned).toMatchObject({
        learnerId: f.parent.learnerId,
        photoIntakeId: null,
        revision: 1,
      });
      expect(
        await f.as(f.parent, () => f.service.assignFamilyIntake(assignment)),
      ).toEqual(assigned);
      await f.as(f.parent, () =>
        expect(
          f.service.assignFamilyIntake({ ...assignment, reason: 'changed' }),
        ).rejects.toThrow(),
      );
      await f.as(f.parent, () =>
        expect(
          f.service.assignFamilyIntake({ ...assignment, requestKey: 'stale' }),
        ).rejects.toThrow(),
      );
      const adoption = {
        ...selection,
        requestKey: 'adopt',
        expectedRevision: 1,
      };
      const adopted = await f.as(f.parent, () =>
        f.service.adoptFamilyIntake(adoption),
      );
      expect(adopted.revision).toBe(2);
      expect(adopted.originals).toEqual(view.originals);
      expect(
        await f.as(f.parent, () => f.service.adoptFamilyIntake(adoption)),
      ).toEqual(adopted);
      if (!adopted.photoIntakeId) throw new Error('Missing adoption binding');
      const photoRequest = { ...f.parent, intakeId: adopted.photoIntakeId };
      const photo = await f.as(f.parent, () =>
        f.service.getWorkbookPhotoIntake(photoRequest),
      );
      expect(photo.submissionId).toBeNull();
      expect(photo.activity).toBeNull();
      await f.as(f.parent, () =>
        expect(
          f.service.captureWorkbookPhotoIntake({
            ...photoRequest,
            requestKey: 'premature-capture',
          }),
        ).rejects.toThrow(),
      );
      await f.as(f.parent, () =>
        f.service.resolveWorkbookPhotoIntake({
          ...photoRequest,
          requestKey: 'resolve-work',
          identification: { kind: 'work', workState: 'completed' },
        }),
      );
      const capture = { ...photoRequest, requestKey: 'capture' };
      const attempt = await f.as(f.parent, () =>
        f.service.captureWorkbookPhotoIntake(capture),
      );
      expect(
        (
          await f.as(f.parent, () =>
            f.service.captureWorkbookPhotoIntake(capture),
          )
        ).id,
      ).toBe(attempt.id);
      expect(
        (
          await f.db.query(
            'SELECT id FROM submissions WHERE intake_item_id=?',
            [view.itemId],
          )
        ).rows,
      ).toHaveLength(1);
      const childOriginal = {
        ...f.own,
        intakeId: photoRequest.intakeId,
        assetId: view.originals[0].assetId,
      };
      await f.as(f.own, () =>
        expect(
          f.service.readWorkbookPhotoOriginal(childOriginal),
        ).rejects.toThrow(),
      );
      const capturedPhoto = await f.as(f.parent, () =>
        f.service.getWorkbookPhotoIntake(photoRequest),
      );
      if (!capturedPhoto.activity) throw new Error('Missing captured activity');
      const marking = {
        ...f.parent,
        activityId: capturedPhoto.activity.id,
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
        Buffer.from(
          (
            await f.as(f.own, () =>
              f.service.readWorkbookPhotoOriginal(childOriginal),
            )
          ).data,
        ),
      ).toEqual(f.pages[0].data);
      await f.as(f.own, () =>
        expect(
          f.service.getFamilyIntake({ ...f.own, intakeId: view.id }),
        ).rejects.toThrow(),
      );
      await f.as(f.own, () =>
        expect(
          f.service.readWorkbookPhotoOriginal({
            ...childOriginal,
            assetId: '22222222-2222-4222-8222-222222222222',
          }),
        ).rejects.toThrow(),
      );
      const sibling = {
        ...f.own,
        actorUserId: String(f.bob.user.id),
        learnerId: String(f.sibling.id),
      };
      await f.as(sibling, () =>
        expect(
          f.service.readWorkbookPhotoOriginal({ ...childOriginal, ...sibling }),
        ).rejects.toThrow(),
      );
      expect(
        await f.as(f.parent, () => f.service.adoptFamilyIntake(adoption)),
      ).toEqual(adopted);
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getFamilyIntakeTimeline(selection),
          )
        ).map((d) => d.decision.kind),
      ).toEqual(['assign', 'adopt']);
      await f.as(f.parent, () =>
        expect(
          f.service.assignFamilyIntake({
            ...assignment,
            requestKey: 'retarget',
            expectedRevision: 2,
          }),
        ).rejects.toThrow(),
      );
      expect(
        Buffer.from(
          (
            await f.as(f.parent, () =>
              f.service.readFamilyIntakeOriginal({
                ...selection,
                assetId: view.originals[0].assetId,
              }),
            )
          ).data,
        ),
      ).toEqual(f.pages[0].data);
    } finally {
      await f.finish();
    }
  });
  it('rolls back adoption failure after creating learner joins and retries without losing originals', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      const selection = { ...f.parent, intakeId: view.id };
      await f.as(f.parent, () =>
        f.service.assignFamilyIntake({
          ...selection,
          requestKey: 'assign',
          expectedRevision: 0,
          reason: 'Guardian attribution',
        }),
      );
      const adoption = {
        ...selection,
        requestKey: 'adopt',
        expectedRevision: 1,
      };
      const createLink = WorkbookPhotoAssetCollection.prototype.create;
      let inserted = false;
      const failure = vi
        .spyOn(WorkbookPhotoAssetCollection.prototype, 'create')
        .mockImplementationOnce(async function (
          this: WorkbookPhotoAssetCollection,
          ...args
        ) {
          await createLink.apply(this, args);
          inserted = true;
          throw new Error('injected post-join persistence failure');
        });
      try {
        await f.as(f.parent, () =>
          expect(f.service.adoptFamilyIntake(adoption)).rejects.toThrow(
            'injected',
          ),
        );
      } finally {
        failure.mockRestore();
      }
      expect(inserted).toBe(true);
      expect(
        (
          await f.db.query(
            'SELECT id FROM workbook_photo_intakes WHERE family_intake_id=?',
            [view.id],
          )
        ).rows,
      ).toEqual([]);
      const retained = await f.as(f.parent, () =>
        f.service.getFamilyIntake(selection),
      );
      expect(retained).toMatchObject({ revision: 1, photoIntakeId: null });
      expect(retained.originals).toEqual(view.originals);
      const adopted = await f.as(f.parent, () =>
        f.service.adoptFamilyIntake(adoption),
      );
      expect(adopted.photoIntakeId).toEqual(expect.any(String));
      expect(
        (
          await f.db.query(
            'SELECT id FROM workbook_photo_intakes WHERE family_intake_id=?',
            [view.id],
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await f.finish();
    }
  });
  it('serializes competing assignments at one revision and preserves one audit decision', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      const selection = { ...f.parent, intakeId: view.id };
      const outcomes = await Promise.allSettled(
        ['first', 'second'].map((requestKey) =>
          f.as(f.parent, () =>
            f.service.assignFamilyIntake({
              ...selection,
              requestKey,
              expectedRevision: 0,
              reason: requestKey,
            }),
          ),
        ),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect(
        await f.as(f.parent, () =>
          f.service.getFamilyIntakeTimeline(selection),
        ),
      ).toHaveLength(1);
    } finally {
      await f.finish();
    }
  });
  it('rejects assignment when learner membership is revoked after receipt', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      await f.db.update(
        'memberships',
        { tenant_id: f.own.tenantId, user_id: f.own.actorUserId },
        { status: 'inactive' },
      );
      const selection = { ...f.parent, intakeId: view.id };
      await f.as(f.parent, () =>
        expect(
          f.service.assignFamilyIntake({
            ...selection,
            requestKey: 'revoked-child',
            expectedRevision: 0,
            reason: 'Guardian attribution',
          }),
        ).rejects.toThrow(),
      );
      expect(
        (await f.as(f.parent, () => f.service.getFamilyIntake(selection)))
          .revision,
      ).toBe(0);
      await f.db.update(
        'memberships',
        { tenant_id: f.parent.tenantId, user_id: f.parent.actorUserId },
        { status: 'inactive' },
      );
      await f.as(f.parent, () =>
        expect(f.service.getFamilyIntake(selection)).rejects.toThrow(),
      );
    } finally {
      await f.finish();
    }
  });
  it('bridges authoritative family receipts and retains originals after generic ingestion expiry', async () => {
    const f = await fixture();
    try {
      await f.as(f.parent, async () => {
        const scope = {
          tenantId: f.parent.tenantId,
          actorId: f.parent.actorUserId,
          confidentialScopeId: familyIntakeScopeId(f.parent.tenantId),
        };
        const assets = await createAssetRuntime({
          db: f.db,
          storage: f.storage,
        });
        let allowed = true;
        const ingestion = new IngestionService({
          db: f.db,
          assets,
          scope,
          authorize: async ({ scope: requested }) =>
            allowed && requested.actorId === f.parent.actorUserId,
          jobTarget: { objectType: 'unused-worker', method: 'process' },
          purgeDerived: async () => {},
        });
        const dispatch = vi
          .spyOn(ingestion, 'repairDispatches')
          .mockResolvedValue(0);
        try {
          const input = {
            ingestion,
            scope,
            family: f.service,
            request: {
              tenantId: f.parent.tenantId,
              actorUserId: f.parent.actorUserId,
            },
          };
          const now = Date.now();
          const receive = {
            sourceId: 'family-scanner',
            sourceVersion: '7',
            deliveryKey: 'exact-source-delivery',
            deliveredAt: new Date(now),
            parts: [
              {
                partId: 'page',
                mediaType: 'image/png',
                bytes: f.pages[0].data,
              },
            ],
            capturedCeiling: {
              execution: {
                principalId: '22222222-2222-4222-8222-222222222222',
                permissions: [],
                handlers: [],
                operations: [],
              },
            },
            retention: {
              version: '1',
              expiresAt: new Date(now + 3600000),
              replayUntil: new Date(now + 7200000),
              acceptAfter: new Date(now - 3600000),
            },
            limits: {
              maxBytes: 100000,
              maxParts: 10,
              maxAttempts: 3,
              leaseMs: 10000,
              maxOutputBytes: 100000,
            },
          };
          await expect(
            receiveFamilyIntake({
              ...input,
              scope: { ...scope, confidentialScopeId: f.parent.learnerId },
              receive,
            }),
          ).rejects.toThrow('scope mismatch');
          const first = await receiveFamilyIntake({ ...input, receive });
          if (!first.intake) throw new Error('Missing family receipt');
          const view = first.intake;
          expect(view.source).toMatchObject({
            sourceId: receive.sourceId,
            sourceVersion: receive.sourceVersion,
            deliveryKey: receive.deliveryKey,
          });
          expect(view.learnerId).toBeNull();
          expect(
            (await receiveFamilyIntake({ ...input, receive })).intake?.id,
          ).toBe(view.id);
          expect(
            (await retainFamilyIntakeReceipt({ ...input, itemId: view.itemId }))
              .id,
          ).toBe(view.id);
          allowed = false;
          await expect(
            retainFamilyIntakeReceipt({ ...input, itemId: view.itemId }),
          ).rejects.toThrow();
          allowed = true;
          const wrappedParts = [
            {
              partId: 'email',
              mediaType: 'application/json',
              filename: 'metadata.json',
              bytes: Buffer.from(
                '{"headers":"secret-header","body":"private envelope"}',
              ),
            },
            {
              partId: 'pdf',
              parentPartId: 'email',
              mediaType: 'application/pdf',
              filename: 'work.pdf',
              bytes: Buffer.from('original pdf attachment'),
            },
            {
              partId: 'image',
              parentPartId: 'email',
              mediaType: 'image/png',
              filename: 'work.png',
              bytes: Buffer.from('original image attachment'),
            },
            {
              partId: 'pdf-page',
              parentPartId: 'pdf',
              mediaType: 'image/jpeg',
              filename: 'derived-page.jpg',
              bytes: Buffer.from('derived duplicate pdf page'),
            },
          ];
          const wrapped = await receiveFamilyIntake({
            ...input,
            receive: {
              ...receive,
              deliveryKey: 'wrapped-source-tree',
              parts: wrappedParts,
            },
          });
          if (!wrapped.intake) throw new Error('Missing wrapped intake');
          expect(wrapped.intake.originals.map((o) => o.name).sort()).toEqual([
            'work.pdf',
            'work.png',
          ]);
          expect(wrapped.intake.source.evidence).toHaveLength(4);
          for (const part of wrappedParts) {
            const provenance = wrapped.intake.source.evidence?.find(
              (e) => e.partId === part.partId,
            );
            expect(provenance).toMatchObject({
              partId: part.partId,
              mimeType: part.mediaType,
              sha256: createHash('sha256').update(part.bytes).digest('hex'),
            });
            if (part.parentPartId)
              expect(provenance?.parentEvidenceId).toBe(
                wrapped.intake.source.evidence?.find(
                  (e) => e.partId === part.parentPartId,
                )?.evidenceId,
              );
            else expect(provenance?.parentEvidenceId).toBeNull();
          }
          expect(JSON.stringify(wrapped.intake.source)).not.toContain(
            'secret-header',
          );
          expect(JSON.stringify(wrapped.intake.source)).not.toContain(
            'private envelope',
          );
          expect(wrapped.intake).toMatchObject({
            learnerId: null,
            photoIntakeId: null,
            revision: 0,
          });
          const mixed = {
            ...receive,
            deliveryKey: 'mixed-pdf-tiff',
            parts: [
              {
                partId: 'pdf',
                mediaType: 'application/pdf',
                filename: 'supported.pdf',
                bytes: Buffer.from('supported original pdf'),
              },
              {
                partId: 'tiff',
                mediaType: 'image/tiff',
                filename: 'unsupported.tiff',
                bytes: Buffer.from('unsupported independent tiff'),
              },
            ],
          };
          const beforeMixed = await f.service.countFamilyIntakes(input.request);
          await expect(
            receiveFamilyIntake({ ...input, receive: mixed }),
          ).rejects.toThrow('Unsupported family original');
          const genericRetry = await ingestion.receive(mixed);
          if (!('itemId' in genericRetry) || !genericRetry.itemId)
            throw new Error('Missing rejected bridge generic receipt');
          expect(await f.service.countFamilyIntakes(input.request)).toBe(
            beforeMixed,
          );
          expect(
            (await f.service.listFamilyIntakes(input.request)).some(
              (row) => row.itemId === genericRetry.itemId,
            ),
          ).toBe(false);
          expect(
            (
              await f.db.query(
                'SELECT id FROM workbook_photo_intakes WHERE item_id=?',
                [genericRetry.itemId],
              )
            ).rows,
          ).toEqual([]);
          const mixedEvidence = await ingestion.getEvidence(
            genericRetry.itemId,
          );
          expect(mixedEvidence).toHaveLength(2);
          for (const part of mixed.parts) {
            const original = mixedEvidence.find(
              (e) => e.partId === part.partId,
            );
            if (!original) throw new Error('Missing generic original');
            expect(
              Buffer.from(
                await ingestion.readEvidence(genericRetry.itemId, original.id),
              ),
            ).toEqual(part.bytes);
          }
          await ingestion.expire(view.itemId);
          const selection = { ...f.parent, intakeId: view.id };
          const retained = await f.service.getFamilyIntake(selection);
          expect(retained).toEqual(view);
          expect(
            Buffer.from(
              (
                await f.service.readFamilyIntakeOriginal({
                  ...selection,
                  assetId: view.originals[0].assetId,
                })
              ).data,
            ),
          ).toEqual(f.pages[0].data);
          await f.service.assignFamilyIntake({
            ...selection,
            requestKey: 'bridge-assign',
            expectedRevision: 0,
            reason: 'Whole document identified',
          });
          const adopted = await f.service.adoptFamilyIntake({
            ...selection,
            requestKey: 'bridge-adopt',
            expectedRevision: 1,
          });
          expect(adopted.photoIntakeId).toEqual(expect.any(String));
          await f.service.assertWorkbookPhotoScope(
            f.parent,
            scope,
            view.itemId,
          );
          await expect(
            f.service.assertWorkbookPhotoScope(
              f.parent,
              scope,
              'unrelated-receipt',
            ),
          ).rejects.toThrow();
          await expect(
            f.service.assertWorkbookPhotoScope(
              { ...f.parent, learnerId: String(f.sibling.id) },
              scope,
              view.itemId,
            ),
          ).rejects.toThrow();
          if (!adopted.photoIntakeId) throw new Error('Missing adopted photo');
          const photoRequest = { ...f.parent, intakeId: adopted.photoIntakeId };
          await f.service.resolveWorkbookPhotoIntake({
            ...photoRequest,
            requestKey: 'expired-resolve',
            identification: { kind: 'work', workState: 'completed' },
          });
          const capture = { ...photoRequest, requestKey: 'expired-capture' };
          const attempt = await f.service.captureWorkbookPhotoIntake(capture);
          expect((await f.service.captureWorkbookPhotoIntake(capture)).id).toBe(
            attempt.id,
          );
          expect(
            (
              await f.db.query(
                'SELECT id FROM submissions WHERE intake_item_id=?',
                [view.itemId],
              )
            ).rows,
          ).toHaveLength(1);
        } finally {
          dispatch.mockRestore();
        }
      });
    } finally {
      await f.finish();
    }
  });
  it('rejects forged family adoption photo ownership without an immutable adoption decision', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      const photos = await WorkbookPhotoIntakeCollection.create({ db: f.db });
      await f.as(f.parent, () =>
        expect(
          photos.create({
            tenantId: f.parent.tenantId,
            learnerId: f.parent.learnerId,
            familyIntakeId: view.id,
            itemId: view.itemId,
            actorUserId: f.parent.actorUserId,
            contentDigest: 'forged',
          }),
        ).rejects.toThrow(),
      );
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getFamilyIntake({ ...f.parent, intakeId: view.id }),
          )
        ).photoIntakeId,
      ).toBeNull();
    } finally {
      await f.finish();
    }
  });
  it('denies corrupted original bytes on read and adoption without recording learner history', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      const selection = { ...f.parent, intakeId: view.id };
      await f.as(f.parent, () =>
        f.service.assignFamilyIntake({
          ...selection,
          requestKey: 'assign',
          expectedRevision: 0,
          reason: 'Guardian attribution',
        }),
      );
      const corruption = vi
        .spyOn(AssetStore.prototype, 'read')
        .mockResolvedValue(Buffer.from('corrupted stored bytes'));
      try {
        await f.as(f.parent, () =>
          expect(
            f.service.readFamilyIntakeOriginal({
              ...selection,
              assetId: view.originals[0].assetId,
            }),
          ).rejects.toThrow('integrity mismatch'),
        );
        await f.as(f.parent, () =>
          expect(
            f.service.adoptFamilyIntake({
              ...selection,
              requestKey: 'adopt-corrupt',
              expectedRevision: 1,
            }),
          ).rejects.toThrow('integrity mismatch'),
        );
      } finally {
        corruption.mockRestore();
      }
      expect(
        await f.as(f.parent, () => f.service.getFamilyIntake(selection)),
      ).toMatchObject({ revision: 1, photoIntakeId: null });
      expect(
        Buffer.from(
          (
            await f.as(f.parent, () =>
              f.service.readFamilyIntakeOriginal({
                ...selection,
                assetId: view.originals[0].assetId,
              }),
            )
          ).data,
        ),
      ).toEqual(f.pages[0].data);
    } finally {
      await f.finish();
    }
  });
  it('binds family authorization to the borrowed executor and closes escaped service scopes', async () => {
    const f = await fixture();
    try {
      const view = await f.receive();
      let checked = false;
      const service = new FamilyIntakeService(
        f.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === f.guardianType.id,
        () => true,
        { storage: f.storage },
        ({ executor }) => {
          expect(executor).toBe(f.db);
          checked = true;
          return true;
        },
      );
      let escaped: FamilyIntakeService | undefined;
      const selection = { ...f.parent, intakeId: view.id };
      await f.as(f.parent, () =>
        service.withExecutor(f.db, async (scoped) => {
          escaped = scoped;
          expect((await scoped.getFamilyIntake(selection)).id).toBe(view.id);
        }),
      );
      await f.as(f.parent, () =>
        expect(
          service.withExecutor(f.db, (scoped) =>
            scoped.retainFamilyIntake({
              ...f.receipt,
              itemId: 'borrowed-retain',
            }),
          ),
        ).rejects.toThrow('owned transaction'),
      );
      expect(checked).toBe(true);
      if (!escaped) throw new Error('Missing captured service');
      const closed = escaped;
      await f.as(f.parent, () =>
        expect(closed.getFamilyIntake(selection)).rejects.toThrow(),
      );
      expect(
        await f.db.get('family_intakes', {
          tenant_id: f.parent.tenantId,
          item_id: 'borrowed-retain',
        }),
      ).toBeFalsy();
    } finally {
      await f.finish();
    }
  });
  it('compensates freshly written family files and metadata after storage rejects, then retries', async () => {
    const f = await fixture();
    try {
      const assetsBefore = (await f.db.query('SELECT id FROM assets')).rows;
      const preserve = AssetStore.prototype.preserveFile;
      let writtenId = '';
      const failure = vi
        .spyOn(AssetStore.prototype, 'preserveFile')
        .mockImplementationOnce(async function (this: AssetStore, ...args) {
          await preserve.apply(this, args);
          writtenId = String(args[0].id);
          throw new Error('storage rejected after writing');
        });
      try {
        await expect(f.receive()).rejects.toThrow(
          'storage rejected after writing',
        );
      } finally {
        failure.mockRestore();
      }
      expect(writtenId).not.toBe('');
      expect(
        (await readdir(f.storage, { recursive: true })).some((path) =>
          path.includes(writtenId),
        ),
      ).toBe(false);
      expect(
        await f.db.get('family_intakes', {
          tenant_id: f.parent.tenantId,
          item_id: f.receipt.itemId,
        }),
      ).toBeFalsy();
      expect((await f.db.query('SELECT id FROM assets')).rows).toEqual(
        assetsBefore,
      );
      expect((await f.receive()).originals).toHaveLength(1);
    } finally {
      await f.finish();
    }
  });
  it('audits valid learner correction before adoption and rejects retargeting afterward', async () => {
    const f = await fixture();
    try {
      const relationship = await f.as(f.parent, async () =>
        (await ProfileRelationshipCollection.create({ db: f.db })).create({
          tenantId: f.parent.tenantId,
          fromProfileId: String(f.guardian.profile.id),
          toProfileId: String(f.bob.profile.id),
          typeId: String(f.guardianType.id),
        }),
      );
      const view = await f.receive();
      const selection = { ...f.parent, intakeId: view.id };
      await f.as(f.parent, () =>
        f.service.assignFamilyIntake({
          ...selection,
          requestKey: 'alice',
          expectedRevision: 0,
          reason: 'Initial attribution',
        }),
      );
      const sibling = {
        ...selection,
        learnerId: String(f.sibling.id),
        guardianRelationshipId: String(relationship.id),
      };
      const corrected = await f.as(f.parent, () =>
        f.service.assignFamilyIntake({
          ...sibling,
          requestKey: 'bob',
          expectedRevision: 1,
          reason: 'Guardian corrects entire document',
        }),
      );
      expect(corrected).toMatchObject({
        learnerId: String(f.sibling.id),
        revision: 2,
        photoIntakeId: null,
      });
      expect(
        (
          await f.as(f.parent, () =>
            f.service.getFamilyIntakeTimeline(selection),
          )
        ).map((d) => d.decision.learnerId),
      ).toEqual([f.parent.learnerId, String(f.sibling.id)]);
      await f.as(f.parent, () =>
        f.service.adoptFamilyIntake({
          ...sibling,
          requestKey: 'adopt-bob',
          expectedRevision: 2,
        }),
      );
      await f.as(f.parent, () =>
        expect(
          f.service.assignFamilyIntake({
            ...selection,
            requestKey: 'retarget-alice',
            expectedRevision: 3,
            reason: 'Attempt cross learner retarget',
          }),
        ).rejects.toThrow(),
      );
    } finally {
      await f.finish();
    }
  });
  it('forwards revision save guards on new family records without writing them', async () => {
    const f = await fixture();
    try {
      const retained = await f.receive();
      const original = retained.originals[0];
      const rows = [
        new FamilyIntake({
          db: f.db,
          id: randomUUID(),
          tenantId: f.parent.tenantId,
          itemId: 'guarded-new-receipt',
          actorUserId: f.parent.actorUserId,
          ownerProfileId: String(f.guardian.profile.id),
          contentDigest: 'guarded',
          sourceJson: JSON.stringify(f.receipt.source),
        }),
        new FamilyIntakeAsset({
          db: f.db,
          id: randomUUID(),
          tenantId: f.parent.tenantId,
          intakeId: retained.id,
          assetId: original.assetId,
          name: original.name,
          mimeType: original.mimeType,
          sha256: original.sha256,
          position: 1,
        }),
        new FamilyIntakeDecision({
          db: f.db,
          id: randomUUID(),
          tenantId: f.parent.tenantId,
          intakeId: retained.id,
          actorUserId: f.parent.actorUserId,
          requestKey: 'guarded-new-decision',
          sequence: 1,
          bodyJson: JSON.stringify({
            kind: 'assign',
            learnerId: f.parent.learnerId,
            reason: 'Guarded fixture',
          }),
        }),
      ];
      await f.as(f.parent, async () => {
        for (const row of rows) {
          await row.initialize();
          // The public base guard rejects revision options on unsaved rows.
          // Dropping options here would instead insert these valid records.
          await expect(
            row.save({ expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }),
          ).rejects.toMatchObject({ code: 'RUNTIME_INVALID_STATE' });
          expect(await f.db.get(row.tableName, { id: row.id })).toBeFalsy();
        }
      });
      expect(
        await f.as(f.parent, () =>
          f.service.getFamilyIntake({ ...f.parent, intakeId: retained.id }),
        ),
      ).toEqual(retained);
    } finally {
      await f.finish();
    }
  });
}
