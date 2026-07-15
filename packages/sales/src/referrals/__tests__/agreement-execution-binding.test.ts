import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgreementExecutionCollection } from '../../agreements/collections/AgreementExecutionCollection.js';
import { ExecutedAgreementCollection } from '../../agreements/collections/ExecutedAgreementCollection.js';
import type { AgreementExecutionService } from '../../agreements/services/AgreementExecutionService.js';
import { ReferralAgreementCollection } from '../collections/ReferralAgreementCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import { ReferralAgreementExecutionService } from '../services/ReferralAgreementExecutionService.js';

const TENANT = 'tenant-referrals';

describe('ReferralAgreementExecutionService', () => {
  let db: DatabaseInterface;
  let agreements: ReferralAgreementCollection;
  let executions: AgreementExecutionCollection;
  let executedAgreements: ExecutedAgreementCollection;
  let referrerId: string;
  let programId: string;
  let createExecution: ReturnType<typeof vi.fn>;
  let service: ReferralAgreementExecutionService;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    agreements = await ReferralAgreementCollection.create({ db });
    executions = await AgreementExecutionCollection.create({ db });
    executedAgreements = await ExecutedAgreementCollection.create({ db });
    const referrers = await ReferrerCollection.create({ db });
    const programs = await ReferralProgramCollection.create({ db });

    await withTenant({ tenantId: TENANT }, async () => {
      referrerId =
        (
          await referrers.create({
            profileId: randomUUID(),
            displayName: 'Referral Partner',
            status: 'active',
          })
        ).id ?? '';
      programId =
        (
          await programs.create({
            key: 'signed-referrals',
            name: 'Signed referrals',
          })
        ).id ?? '';
    });

    createExecution = vi.fn(async (input) => {
      const execution = await executions.create({
        tenantId: TENANT,
        provider: 'boldsign',
        idempotencyKey: input.idempotencyKey,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        sourceAssetId: randomUUID(),
        sourceSha256: 'source-hash',
        title: input.title,
        signerIntent: '[]',
        providerRequestId: `request-${input.sourceVersion}`,
        status: 'sent',
        effectiveFrom: input.effectiveFrom,
        supersedesExecutedAgreementId: input.supersedesExecutedAgreementId,
      });
      return {
        executionId: execution.id ?? '',
        providerRequestId: execution.providerRequestId,
        status: execution.status,
        replayed: false,
      };
    });
    service = new ReferralAgreementExecutionService({
      agreements,
      executions,
      executedAgreements,
      executionService: {
        createExecution,
      } as unknown as AgreementExecutionService,
      now: () => new Date('2026-07-14T20:00:00Z'),
    });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') await db.close();
  });

  it('binds immutable evidence and preserves effective-dated amendment behavior', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const v1 = await agreements.create({
        referrerId,
        programId,
        version: 1,
        status: 'draft',
        commissionPlanKey: 'referral-standard',
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
      });
      const sentV1 = await service.requestSignature(requestInput(v1.id ?? ''));
      expect((await agreements.get({ id: v1.id }))?.executionId).toBe(
        sentV1.executionId,
      );
      const executedV1 = await createExecuted(
        sentV1.executionId,
        v1.id ?? '',
        1,
        new Date('2026-07-01T00:00:00Z'),
      );
      await service.applyExecutedAgreement({
        tenantId: TENANT,
        agreementId: v1.id ?? '',
        executedAgreementId: executedV1.id,
      });
      expect((await agreements.get({ id: v1.id }))?.status).toBe('active');

      const v2 = await agreements.createAmendment(referrerId, programId, {
        clearingDays: 45,
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
      });
      expect(v2.executionId).toBe('');
      expect(v2.executedAgreementId).toBe('');
      const sentV2 = await service.requestSignature(requestInput(v2.id ?? ''));
      const executedV2 = await createExecuted(
        sentV2.executionId,
        v2.id ?? '',
        2,
        new Date('2026-09-01T00:00:00Z'),
        executedV1.id,
      );
      await service.applyExecutedAgreement({
        tenantId: TENANT,
        agreementId: v2.id ?? '',
        executedAgreementId: executedV2.id,
        at: new Date('2026-07-14T20:00:00Z'),
      });

      expect((await agreements.get({ id: v1.id }))?.status).toBe('active');
      expect(
        (
          await agreements.activeFor(
            referrerId,
            programId,
            new Date('2026-08-01T00:00:00Z'),
          )
        )?.version,
      ).toBe(1);
      expect(
        (
          await agreements.activeFor(
            referrerId,
            programId,
            new Date('2026-09-01T00:00:00Z'),
          )
        )?.version,
      ).toBe(2);

      await service.supersedePriorIfEffective({
        tenantId: TENANT,
        agreementId: v2.id ?? '',
        at: new Date('2026-09-01T00:00:00Z'),
      });
      const superseded = await agreements.get({ id: v1.id });
      expect(superseded?.status).toBe('superseded');
      expect(superseded?.effectiveTo?.toISOString()).toBe(
        '2026-09-01T00:00:00.000Z',
      );
    });
  });

  it('rejects executed evidence from another source version', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const agreement = await agreements.create({
        referrerId,
        programId,
        version: 1,
        status: 'draft',
        commissionPlanKey: 'referral-standard',
      });
      const sent = await service.requestSignature(
        requestInput(agreement.id ?? ''),
      );
      const wrong = await createExecuted(
        sent.executionId,
        agreement.id ?? '',
        2,
        new Date('2026-07-14T20:00:00Z'),
      );
      await expect(
        service.applyExecutedAgreement({
          tenantId: TENANT,
          agreementId: agreement.id ?? '',
          executedAgreementId: wrong.id,
        }),
      ).rejects.toThrow(/does not belong/);
    });
  });

  it('does not extend a prior explicit end date when an amendment supersedes it', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const v1 = await agreements.create({
        referrerId,
        programId,
        version: 1,
        status: 'draft',
        commissionPlanKey: 'referral-standard',
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
        effectiveTo: new Date('2026-08-15T00:00:00Z'),
      });
      const sentV1 = await service.requestSignature(requestInput(v1.id ?? ''));
      const executedV1 = await createExecuted(
        sentV1.executionId,
        v1.id ?? '',
        1,
        new Date('2026-07-01T00:00:00Z'),
      );
      await service.applyExecutedAgreement({
        tenantId: TENANT,
        agreementId: v1.id ?? '',
        executedAgreementId: executedV1.id,
      });

      const v2 = await agreements.createAmendment(referrerId, programId, {
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
      });
      const sentV2 = await service.requestSignature(requestInput(v2.id ?? ''));
      const executedV2 = await createExecuted(
        sentV2.executionId,
        v2.id ?? '',
        2,
        new Date('2026-09-01T00:00:00Z'),
        executedV1.id,
      );
      await service.applyExecutedAgreement({
        tenantId: TENANT,
        agreementId: v2.id ?? '',
        executedAgreementId: executedV2.id,
        at: new Date('2026-07-14T20:00:00Z'),
      });
      await service.supersedePriorIfEffective({
        tenantId: TENANT,
        agreementId: v2.id ?? '',
        at: new Date('2026-09-01T00:00:00Z'),
      });

      const prior = await agreements.get({ id: v1.id });
      expect(prior?.status).toBe('superseded');
      expect(prior?.effectiveTo?.toISOString()).toBe(
        '2026-08-15T00:00:00.000Z',
      );
      await expect(
        agreements.activeFor(
          referrerId,
          programId,
          new Date('2026-08-20T00:00:00Z'),
        ),
      ).resolves.toBeNull();
    });
  });

  it('binds a persisted execution fence after an uncertain provider create', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const agreement = await agreements.create({
        referrerId,
        programId,
        version: 1,
        status: 'draft',
        commissionPlanKey: 'referral-standard',
      });
      createExecution.mockImplementationOnce(async (input) => {
        await executions.create({
          tenantId: TENANT,
          provider: 'boldsign',
          idempotencyKey: input.idempotencyKey,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          sourceAssetId: randomUUID(),
          sourceSha256: 'source-hash',
          sourceSizeBytes: 100,
          requestIntentSha256: 'intent-hash',
          title: input.title,
          signerIntent: '[]',
          status: 'failed',
          attemptCount: 1,
          lastError: JSON.stringify({ requestMayHaveSucceeded: true }),
        });
        throw new Error('provider outcome uncertain');
      });

      await expect(
        service.requestSignature({
          tenantId: TENANT,
          agreementId: agreement.id as string,
          document: {
            name: 'referral-agreement.pdf',
            mediaType: 'application/pdf',
            data: Buffer.from('%PDF-agreement'),
          },
          signers: [],
        }),
      ).rejects.toThrow(/provider outcome uncertain/);

      const reloaded = await agreements.get({ id: agreement.id });
      expect(reloaded?.executionId).toBeTruthy();
    });
  });

  function requestInput(agreementId: string) {
    return {
      tenantId: TENANT,
      agreementId,
      document: {
        name: 'referral-agreement.pdf',
        mediaType: 'application/pdf',
        data: Buffer.from('%PDF-referral'),
      },
      signers: [
        {
          name: 'Partner',
          email: 'partner@example.test',
          fields: [
            {
              id: 'signature',
              type: 'signature' as const,
              page: 1,
              bounds: { x: 1, y: 1, width: 1, height: 1 },
            },
          ],
        },
      ],
    };
  }

  async function createExecuted(
    executionId: string,
    sourceId: string,
    sourceVersion: number,
    effectiveFrom: Date,
    supersedesExecutedAgreementId = '',
  ) {
    const result = await executedAgreements.createImmutable({
      tenantId: TENANT,
      executionId,
      sourceKind: 'referral_agreement',
      sourceId,
      sourceVersion,
      sourceAssetId: randomUUID(),
      sourceSha256: 'source-hash',
      sourceSizeBytes: 100,
      signedDocumentAssetId: randomUUID(),
      signedDocumentSha256: 'signed-hash',
      signedDocumentSizeBytes: 120,
      signedDocumentMediaType: 'application/pdf',
      signedDocumentFilename: 'signed.pdf',
      auditTrailAssetId: randomUUID(),
      auditTrailSha256: 'audit-hash',
      auditTrailSizeBytes: 80,
      auditTrailMediaType: 'application/pdf',
      auditTrailFilename: 'audit.pdf',
      signerEvidence: JSON.stringify([
        {
          name: 'Signer One',
          email: 'signer@example.test',
          status: 'signed',
        },
      ]),
      acceptedAt: new Date('2026-07-14T20:00:00Z'),
      effectiveFrom,
      supersedesExecutedAgreementId,
    });
    return result.agreement;
  }
});
