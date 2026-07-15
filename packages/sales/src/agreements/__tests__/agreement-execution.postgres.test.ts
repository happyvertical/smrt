import { randomUUID } from 'node:crypto';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgreementExecutionCollection } from '../collections/AgreementExecutionCollection.js';
import { AgreementExecutionEventCollection } from '../collections/AgreementExecutionEventCollection.js';
import { ExecutedAgreementCollection } from '../collections/ExecutedAgreementCollection.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('agreement execution evidence on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let executions: AgreementExecutionCollection;
  let events: AgreementExecutionEventCollection;
  let executedAgreements: ExecutedAgreementCollection;

  beforeEach(async () => {
    enableTenancy();
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'AgreementExecution',
        'AgreementExecutionEvent',
        'ExecutedAgreement',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    db = isolated.db;
    executions = await AgreementExecutionCollection.create({ db });
    events = await AgreementExecutionEventCollection.create({ db });
    executedAgreements = await ExecutedAgreementCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('dedupes verified events, retains immutable evidence, and isolates tenants', async () => {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const executionId = await withTenant({ tenantId }, async () => {
      const execution = await executions.create({
        tenantId,
        provider: 'boldsign',
        idempotencyKey: `pg-agreement-${randomUUID()}`,
        sourceKind: 'referral_agreement',
        sourceId: randomUUID(),
        sourceVersion: 1,
        sourceAssetId: randomUUID(),
        sourceSha256: 'source-sha256',
        sourceSizeBytes: 100,
        signerIntent: '[]',
        providerRequestId: `request-${randomUUID()}`,
        status: 'completed',
      });
      const id = execution.id as string;

      const eventInput = {
        tenantId,
        executionId: id,
        provider: 'boldsign',
        providerEventId: `event-${randomUUID()}`,
        dedupeKey: `event-dedupe-${randomUUID()}`,
        orderingKey: execution.providerRequestId,
        eventType: 'completed',
        status: 'completed' as const,
        occurredAt: new Date('2026-07-14T21:00:00Z'),
        receivedAt: new Date('2026-07-14T21:00:01Z'),
        payloadSha256: 'payload-sha256',
        signerEvidence: JSON.stringify([
          {
            name: 'Signer One',
            email: 'signer@example.test',
            status: 'signed',
          },
        ]),
        payload: '{"event":"completed"}',
      };
      expect((await events.recordVerified(eventInput)).created).toBe(true);
      expect((await events.recordVerified(eventInput)).created).toBe(false);

      const evidence = await executedAgreements.createImmutable({
        tenantId,
        executionId: id,
        sourceKind: execution.sourceKind,
        sourceId: execution.sourceId,
        sourceVersion: execution.sourceVersion,
        sourceAssetId: execution.sourceAssetId,
        sourceSha256: execution.sourceSha256,
        sourceSizeBytes: execution.sourceSizeBytes,
        signedDocumentAssetId: randomUUID(),
        signedDocumentSha256: 'signed-sha256',
        signedDocumentSizeBytes: 120,
        signedDocumentMediaType: 'application/pdf',
        signedDocumentFilename: 'signed.pdf',
        auditTrailAssetId: randomUUID(),
        auditTrailSha256: 'audit-sha256',
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
        acceptedAt: new Date('2026-07-14T21:00:00Z'),
      });
      expect(evidence.created).toBe(true);

      const hydrated = await executedAgreements.get({
        id: evidence.agreement.id,
      });
      if (!hydrated) throw new Error('expected executed agreement');
      hydrated.auditTrailSha256 = 'tampered';
      await expect(hydrated.save()).rejects.toThrow(/immutable/);
      return id;
    });

    await withTenant({ tenantId: otherTenantId }, async () => {
      expect(await executions.get({ id: executionId })).toBeNull();
      expect(await events.findByExecution(executionId)).toEqual([]);
      expect(await executedAgreements.findByExecution(executionId)).toBeNull();
    });
  });

  it('fences one provider request per tenant/provider at the database boundary', async () => {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const providerRequestId = `request-${randomUUID()}`;
    const createBoundExecution = (activeTenantId: string, suffix: string) =>
      executions.create({
        tenantId: activeTenantId,
        provider: 'boldsign',
        idempotencyKey: `binding-${suffix}-${randomUUID()}`,
        sourceKind: 'referral_agreement',
        sourceId: randomUUID(),
        sourceVersion: 1,
        providerRequestId,
        _insertOnly: true,
      });

    await withTenant({ tenantId }, async () => {
      await createBoundExecution(tenantId, 'first');
    });
    await withTenant({ tenantId: otherTenantId }, async () => {
      await expect(
        createBoundExecution(otherTenantId, 'other-tenant'),
      ).resolves.toBeDefined();
    });
    await withTenant({ tenantId }, async () => {
      await expect(
        createBoundExecution(tenantId, 'duplicate'),
      ).rejects.toThrow();
    });
  });

  it('claims an expired provider-create lease exactly once within its tenant', async () => {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const executionId = await withTenant({ tenantId }, async () => {
      const execution = await executions.create({
        tenantId,
        provider: 'idempotent-provider',
        idempotencyKey: `lease-${randomUUID()}`,
        sourceKind: 'referral_agreement',
        sourceId: randomUUID(),
        sourceVersion: 1,
        status: 'prepared',
        attemptCount: 1,
        createLeaseId: 'expired-operation',
        createLeaseExpiresAt: new Date('2026-07-14T20:00:00Z'),
        _insertOnly: true,
      });
      const input = {
        tenantId,
        executionId: execution.id as string,
        expectedAttemptCount: 1,
        expectedLeaseId: 'expired-operation',
        expectedStatus: 'prepared',
        expectedLastError: '',
        leaseExpiresAt: new Date('2026-07-14T20:10:00Z'),
        now: new Date('2026-07-14T20:05:00Z'),
      };
      const attempts = await Promise.all([
        executions.claimCreateAttempt({
          ...input,
          operationId: 'recovery-operation-a',
        }),
        executions.claimCreateAttempt({
          ...input,
          operationId: 'recovery-operation-b',
        }),
      ]);

      expect(attempts.filter(Boolean)).toHaveLength(1);
      const claimed = await executions.get({ id: execution.id });
      expect(claimed?.attemptCount).toBe(2);
      expect(claimed?.createLeaseId).toMatch(/^recovery-operation-[ab]$/);
      return execution.id as string;
    });

    await withTenant({ tenantId: otherTenantId }, async () => {
      await expect(
        executions.claimCreateAttempt({
          tenantId,
          executionId,
          expectedAttemptCount: 2,
          expectedLeaseId: 'recovery-operation-a',
          expectedStatus: 'prepared',
          expectedLastError: '',
          operationId: 'cross-tenant-operation',
          leaseExpiresAt: new Date('2026-07-14T20:20:00Z'),
          now: new Date('2026-07-14T20:15:00Z'),
        }),
      ).rejects.toThrow(/tenant mismatch/);
    });
  });

  it('fences stale provider-create completion and failure writes', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      const execution = await executions.create({
        tenantId,
        provider: 'idempotent-provider',
        idempotencyKey: `settlement-${randomUUID()}`,
        sourceKind: 'referral_agreement',
        sourceId: randomUUID(),
        sourceVersion: 1,
        status: 'prepared',
        attemptCount: 2,
        createLeaseId: 'current-operation',
        createLeaseExpiresAt: new Date('2026-07-14T20:10:00Z'),
        _insertOnly: true,
      });

      await expect(
        executions.completeCreateAttempt({
          tenantId,
          executionId: execution.id as string,
          operationId: 'stale-operation',
          provider: 'idempotent-provider',
          providerRequestId: 'stale-request',
          status: 'sent',
          expiresAt: null,
        }),
      ).resolves.toBeNull();
      await expect(
        executions.failCreateAttempt({
          tenantId,
          executionId: execution.id as string,
          operationId: 'stale-operation',
          lastError: 'stale failure',
        }),
      ).resolves.toBeNull();

      const completed = await executions.completeCreateAttempt({
        tenantId,
        executionId: execution.id as string,
        operationId: 'current-operation',
        provider: 'idempotent-provider',
        providerRequestId: 'current-request',
        status: 'sent',
        expiresAt: null,
      });
      expect(completed).toMatchObject({
        attemptCount: 2,
        providerRequestId: 'current-request',
        status: 'sent',
        lastError: '',
        createLeaseId: '',
      });
      await expect(
        executions.failCreateAttempt({
          tenantId,
          executionId: execution.id as string,
          operationId: 'current-operation',
          lastError: 'late failure',
        }),
      ).resolves.toBeNull();
      await expect(executions.get({ id: execution.id })).resolves.toMatchObject(
        {
          providerRequestId: 'current-request',
          status: 'sent',
          lastError: '',
        },
      );

      const signedAssetId = randomUUID();
      await expect(
        executions.bindEvidenceArtifact({
          tenantId,
          executionId: execution.id as string,
          kind: 'signed_document',
          assetId: signedAssetId,
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
          mediaType: 'application/pdf',
          filename: 'signed.pdf',
        }),
      ).resolves.toMatchObject({ signedDocumentAssetId: signedAssetId });
      await expect(
        executions.bindEvidenceArtifact({
          tenantId,
          executionId: execution.id as string,
          kind: 'signed_document',
          assetId: randomUUID(),
          sha256: 'b'.repeat(64),
          sizeBytes: 456,
          mediaType: 'application/pdf',
          filename: 'loser.pdf',
        }),
      ).resolves.toBeNull();
      await expect(executions.get({ id: execution.id })).resolves.toMatchObject(
        {
          signedDocumentAssetId: signedAssetId,
          signedDocumentSha256: 'a'.repeat(64),
        },
      );
    });
  });

  it('allows only one lifecycle writer for the same persisted snapshot', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      const observedAt = new Date('2026-07-14T20:00:00Z');
      const execution = await executions.create({
        tenantId,
        provider: 'boldsign',
        idempotencyKey: `lifecycle-${randomUUID()}`,
        sourceKind: 'referral_agreement',
        sourceId: randomUUID(),
        sourceVersion: 1,
        providerRequestId: `request-${randomUUID()}`,
        status: 'sent',
        lastProviderEventAt: observedAt,
        _insertOnly: true,
      });
      const common = {
        tenantId,
        executionId: execution.id as string,
        expectedStatus: 'sent' as const,
        expiresAt: null,
        cancellationReason: '',
        lastReconciledAt: null,
        completedAt: null,
      };

      const writers = await Promise.all([
        executions.compareAndSetLifecycle({
          ...common,
          status: 'delivered',
          lastProviderEventAt: new Date('2026-07-14T20:01:00Z'),
        }),
        executions.compareAndSetLifecycle({
          ...common,
          status: 'cancelled',
          cancellationReason: 'concurrent cancellation',
          lastProviderEventAt: new Date('2026-07-14T20:02:00Z'),
        }),
      ]);

      expect(writers.filter(Boolean)).toHaveLength(1);
      const persisted = await executions.get({ id: execution.id });
      expect(['delivered', 'cancelled']).toContain(persisted?.status);
      expect(writers.find((candidate) => candidate)?.status).toBe(
        persisted?.status,
      );
    });
  });
});
