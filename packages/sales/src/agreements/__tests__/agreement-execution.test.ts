import { createHash, randomUUID } from 'node:crypto';
import type {
  SignatureArtifact,
  SignatureProvider,
  SignatureRequest,
  SignatureWebhookEvent,
} from '@happyvertical/signatures';
import { SignatureProviderError } from '@happyvertical/signatures';
import type { AssetRuntimeLike } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  requireTenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgreementExecutionCollection } from '../collections/AgreementExecutionCollection.js';
import { AgreementExecutionEventCollection } from '../collections/AgreementExecutionEventCollection.js';
import { ExecutedAgreementCollection } from '../collections/ExecutedAgreementCollection.js';
import { AgreementExecutionService } from '../services/AgreementExecutionService.js';

const TENANT = 'tenant-a';
const PDF = Buffer.from('%PDF-source-agreement');
const SIGNED = Buffer.from('%PDF-signed-agreement');
const AUDIT = Buffer.from('%PDF-audit-trail');

describe('AgreementExecutionService', () => {
  let db: DatabaseInterface;
  let executions: AgreementExecutionCollection;
  let events: AgreementExecutionEventCollection;
  let executedAgreements: ExecutedAgreementCollection;
  let provider: ReturnType<typeof createProvider>;
  let assets: AssetRuntimeLike;
  let service: AgreementExecutionService;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    executions = await AgreementExecutionCollection.create({ db });
    events = await AgreementExecutionEventCollection.create({ db });
    executedAgreements = await ExecutedAgreementCollection.create({ db });
    provider = createProvider();
    assets = createAssetRuntime();
    service = new AgreementExecutionService({
      provider,
      assets,
      executions,
      events,
      executedAgreements,
      now: () => new Date('2026-07-14T20:00:00.000Z'),
    });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') await db.close();
  });

  it('creates once, stores exact source evidence, and never persists access codes', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const first = await service.createExecution(createInput());
      const replay = await service.createExecution(createInput());

      expect(first.providerRequestId).toBe('request-1');
      expect(replay.replayed).toBe(true);
      expect(provider.createRequest).toHaveBeenCalledTimes(1);
      expect(assets.storeSourceAsset).toHaveBeenCalledTimes(1);

      const changedDocument = createInput();
      changedDocument.document.data = Buffer.from('%PDF-different-terms');
      await expect(service.createExecution(changedDocument)).rejects.toThrow(
        /belongs to a different agreement execution/,
      );
      expect(provider.createRequest).toHaveBeenCalledTimes(1);
      expect(assets.storeSourceAsset).toHaveBeenCalledTimes(1);

      const execution = await executions.get({ id: first.executionId });
      expect(execution?.sourceSha256).toBe(hash(PDF));
      expect(execution?.requestIntentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(execution?.credentialRef).toBe('secret://boldsign/tenant-a');
      expect(execution?.signerIntent).not.toContain('super-secret-code');
      expect(execution?.getSignerIntent()).toEqual([
        {
          name: 'Signer One',
          email: 'signer@example.test',
          role: 'referrer',
          authenticationMethod: 'access_code',
        },
      ]);
    });
  });

  it('fences concurrent creates before the provider side effect', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      let releaseProvider!: () => void;
      let providerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        providerStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      provider.createRequest.mockImplementationOnce(async () => {
        providerStarted();
        await release;
        return request('sent');
      });

      const firstPromise = service.createExecution(createInput());
      await started;
      const concurrent = await service.createExecution(createInput());
      expect(concurrent.replayed).toBe(true);
      expect(concurrent.status).toBe('prepared');
      expect(concurrent.providerRequestId).toBeUndefined();

      releaseProvider();
      const first = await firstPromise;
      expect(first.providerRequestId).toBe('request-1');
      expect(provider.createRequest).toHaveBeenCalledTimes(1);
    });
  });

  it('ingests a verified completion once and retains immutable artifacts and audit evidence', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const created = await service.createExecution(createInput());
      provider.event = completedEvent();
      provider.request = request('completed');

      const first = await service.ingestWebhook({
        tenantId: TENANT,
        payload: '{"event":"completed"}',
        signature: 'valid',
      });
      const replay = await service.ingestWebhook({
        tenantId: TENANT,
        payload: '{"event":"completed"}',
        signature: 'valid',
      });

      expect(first.executedAgreementId).toBeTruthy();
      expect(replay.replayed).toBe(true);
      expect(replay.executedAgreementId).toBe(first.executedAgreementId);
      expect(provider.downloadArtifact).toHaveBeenCalledTimes(2);
      expect(
        await events.findProviderEventsByExecution(created.executionId),
      ).toHaveLength(1);
      expect(
        (await events.findByExecution(created.executionId)).filter(
          (event) => event.eventType === 'operation.finalize.succeeded',
        ),
      ).toHaveLength(2);

      const executed = await executedAgreements.get({
        id: first.executedAgreementId,
      });
      expect(executed?.sourceSha256).toBe(hash(PDF));
      expect(executed?.sourceSizeBytes).toBe(PDF.byteLength);
      expect(executed?.signedDocumentSha256).toBe(hash(SIGNED));
      expect(executed?.signedDocumentSizeBytes).toBe(SIGNED.byteLength);
      expect(executed?.signedDocumentFilename).toBe('signed_document.pdf');
      expect(executed?.auditTrailSha256).toBe(hash(AUDIT));
      expect(executed?.auditTrailSizeBytes).toBe(AUDIT.byteLength);
      expect(executed?.auditTrailFilename).toBe('audit_trail.pdf');
      expect(executed?.signerEvidence).toContain('signer@example.test');

      if (!executed) throw new Error('expected executed agreement');
      executed.signedDocumentSha256 = 'tampered';
      await expect(executed.save()).rejects.toThrow(/immutable/);

      const [event] = await events.findProviderEventsByExecution(
        created.executionId,
      );
      event.payload = '{"tampered":true}';
      await expect(event.save()).rejects.toThrow(/immutable/);
    });
  });

  it('records stale verified events without regressing lifecycle state', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const created = await service.createExecution(createInput());
      provider.event = webhookEvent(
        'viewed',
        'event-viewed',
        '2026-07-14T21:00:00Z',
      );
      await service.ingestWebhook({
        tenantId: TENANT,
        payload: '{"event":"viewed"}',
        signature: 'valid',
      });
      provider.event = webhookEvent(
        'sent',
        'event-sent',
        '2026-07-14T20:30:00Z',
      );
      await service.ingestWebhook({
        tenantId: TENANT,
        payload: '{"event":"sent"}',
        signature: 'valid',
      });
      provider.event = webhookEvent(
        'sent',
        'event-sent-equal-time',
        '2026-07-14T21:00:00Z',
      );
      await service.ingestWebhook({
        tenantId: TENANT,
        payload: '{"event":"sent-equal-time"}',
        signature: 'valid',
      });

      expect((await executions.get({ id: created.executionId }))?.status).toBe(
        'viewed',
      );
      expect(
        await events.findProviderEventsByExecution(created.executionId),
      ).toHaveLength(3);
    });
  });

  it('rejects a replay-key collision with different verified payload evidence', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      await service.createExecution(createInput());
      provider.event = webhookEvent(
        'viewed',
        'event-collision',
        '2026-07-14T21:00:00Z',
      );
      await service.ingestWebhook({
        tenantId: TENANT,
        payload: '{"event":"viewed"}',
        signature: 'valid',
      });

      await expect(
        service.ingestWebhook({
          tenantId: TENANT,
          payload: '{"event":"viewed","mutated":true}',
          signature: 'valid',
        }),
      ).rejects.toThrow(/collides with different verified evidence/);
    });
  });

  it('preserves exact artifact metadata when finalization resumes after a partial failure', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const created = await service.createExecution(createInput());
      provider.event = completedEvent();
      provider.request = request('completed');
      provider.downloadArtifact
        .mockImplementationOnce(async () => artifact('signed_document', SIGNED))
        .mockRejectedValueOnce(new Error('temporary audit retrieval failure'));

      await expect(
        service.ingestWebhook({
          tenantId: TENANT,
          payload: '{"event":"completed"}',
          signature: 'valid',
        }),
      ).rejects.toThrow(/temporary audit retrieval failure/);

      const staged = await executions.get({ id: created.executionId });
      expect(staged?.signedDocumentFilename).toBe('signed_document.pdf');
      expect(staged?.signedDocumentMediaType).toBe('application/pdf');

      const resumed = await service.ingestWebhook({
        tenantId: TENANT,
        payload: '{"event":"completed"}',
        signature: 'valid',
      });
      const executed = await executedAgreements.get({
        id: resumed.executedAgreementId,
      });
      expect(executed?.signedDocumentFilename).toBe('signed_document.pdf');
      expect(executed?.signedDocumentMediaType).toBe('application/pdf');
      expect(provider.downloadArtifact).toHaveBeenCalledTimes(3);
    });
  });

  it('freezes persisted execution identity while allowing lifecycle updates', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const created = await service.createExecution(createInput());
      const execution = await executions.get({ id: created.executionId });
      if (!execution) throw new Error('expected execution');

      execution.status = 'viewed';
      await execution.save();
      execution.sourceId = 'other-agreement';
      await expect(execution.save()).rejects.toThrow(/identity is immutable/);

      execution.sourceId = 'agreement-1';
      execution.providerRequestId = 'request-2';
      await expect(execution.save()).rejects.toThrow(
        /provider request is immutable once bound/,
      );
    });
  });

  it('fails closed on tenant mismatch before provider or database work', async () => {
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await expect(service.createExecution(createInput())).rejects.toThrow(
        /tenant mismatch/,
      );
      expect(provider.createRequest).not.toHaveBeenCalled();
      expect(assets.storeSourceAsset).not.toHaveBeenCalled();
    });
  });

  it('retries only provider creates confirmed not to have succeeded', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      provider.createRequest.mockRejectedValueOnce(
        new SignatureProviderError('rejected before processing', {
          status: 400,
          requestMayHaveSucceeded: false,
        }),
      );
      await expect(service.createExecution(createInput())).rejects.toThrow(
        /rejected before processing/,
      );

      const retried = await service.createExecution(createInput());
      expect(retried.providerRequestId).toBe('request-1');
      expect(retried.replayed).toBe(true);
      expect(provider.createRequest).toHaveBeenCalledTimes(2);
      expect(assets.storeSourceAsset).toHaveBeenCalledTimes(1);
      expect(
        (await executions.get({ id: retried.executionId }))?.attemptCount,
      ).toBe(2);
    });
  });

  it('recovers safely when the pre-provider audit fence cannot be written', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      vi.spyOn(events, 'recordVerified').mockRejectedValueOnce(
        new Error('audit store unavailable'),
      );
      await expect(service.createExecution(createInput())).rejects.toThrow(
        /audit store unavailable/,
      );
      expect(provider.createRequest).not.toHaveBeenCalled();

      const retried = await service.createExecution(createInput());
      expect(retried.providerRequestId).toBe('request-1');
      expect(provider.createRequest).toHaveBeenCalledTimes(1);
      expect(assets.storeSourceAsset).toHaveBeenCalledTimes(1);
    });
  });

  it('requires reconciliation or adoption after an uncertain provider create', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      provider.createRequest.mockRejectedValueOnce(
        new SignatureProviderError('connection ended after send', {
          retryable: true,
          requestMayHaveSucceeded: true,
        }),
      );
      await expect(service.createExecution(createInput())).rejects.toThrow(
        /connection ended after send/,
      );
      const [execution] = await executions.findBySource(
        'referral_agreement',
        'agreement-1',
      );
      if (!execution?.id) throw new Error('expected failed execution');

      await expect(service.createExecution(createInput())).rejects.toThrow(
        /reconcile or adopt/,
      );
      expect(provider.createRequest).toHaveBeenCalledTimes(1);

      const adopted = await service.adoptProviderRequest({
        tenantId: TENANT,
        executionId: execution.id,
        providerRequestId: 'request-1',
      });
      expect(adopted.providerRequestId).toBe('request-1');
    });
  });

  it('refuses to bind one provider request to two executions', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      await service.createExecution(createInput());
      provider.createRequest.mockRejectedValueOnce(
        new SignatureProviderError('connection ended after send', {
          retryable: true,
          requestMayHaveSucceeded: true,
        }),
      );
      const secondInput = {
        ...createInput(),
        idempotencyKey: 'tenant-a:referral-agreement:agreement-2:v2',
        sourceId: 'agreement-2',
        sourceVersion: 2,
      };
      await expect(service.createExecution(secondInput)).rejects.toThrow(
        /connection ended after send/,
      );
      const [second] = await executions.findBySource(
        'referral_agreement',
        'agreement-2',
      );
      if (!second?.id) throw new Error('expected second execution');

      await expect(
        service.adoptProviderRequest({
          tenantId: TENANT,
          executionId: second.id,
          providerRequestId: 'request-1',
        }),
      ).rejects.toThrow(/already bound to another AgreementExecution/);
    });
  });

  it('enforces provider request binding uniqueness at the database boundary', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const providerRequestId = 'shared-provider-request';
      await executions.create({
        tenantId: TENANT,
        provider: 'boldsign',
        idempotencyKey: 'binding-fence-1',
        sourceKind: 'referral_agreement',
        sourceId: 'agreement-1',
        sourceVersion: 1,
        providerRequestId,
        _insertOnly: true,
      });
      await expect(
        executions.create({
          tenantId: TENANT,
          provider: 'boldsign',
          idempotencyKey: 'binding-fence-2',
          sourceKind: 'referral_agreement',
          sourceId: 'agreement-2',
          sourceVersion: 1,
          providerRequestId,
          _insertOnly: true,
        }),
      ).rejects.toThrow();
    });
  });

  it('propagates expiry and cancellation without regressing a terminal state', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const created = await service.createExecution(createInput());
      provider.request = {
        ...request('sent'),
        expiresAt: new Date('2026-08-01T00:00:00Z'),
      };
      await service.extendExpiry({
        tenantId: TENANT,
        executionId: created.executionId,
        expiresAt: '2026-08-01T00:00:00Z',
      });
      const extended = await executions.get({ id: created.executionId });
      expect(extended?.expiresAt?.toISOString()).toBe(
        '2026-08-01T00:00:00.000Z',
      );

      provider.request = request('cancelled');
      await service.cancel({
        tenantId: TENANT,
        executionId: created.executionId,
        reason: 'Agreement replaced',
      });
      await service.cancel({
        tenantId: TENANT,
        executionId: created.executionId,
        reason: 'Agreement replaced',
      });
      expect(provider.cancelRequest).toHaveBeenCalledTimes(1);

      provider.request = request('viewed');
      await service.reconcile({
        tenantId: TENANT,
        executionId: created.executionId,
      });
      expect((await executions.get({ id: created.executionId }))?.status).toBe(
        'cancelled',
      );
      await expect(
        service.extendExpiry({
          tenantId: TENANT,
          executionId: created.executionId,
          expiresAt: '2026-09-01T00:00:00Z',
        }),
      ).rejects.toThrow(/terminal AgreementExecution/);
      expect(provider.extendExpiry).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects provider reads that return a different request identity', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const created = await service.createExecution(createInput());
      provider.request = { ...request('viewed'), id: 'request-other' };

      await expect(
        service.reconcile({
          tenantId: TENANT,
          executionId: created.executionId,
        }),
      ).rejects.toThrow(/while 'request-1' was requested/);
      expect((await executions.get({ id: created.executionId }))?.status).toBe(
        'sent',
      );
    });
  });
});

function createInput() {
  return {
    tenantId: TENANT,
    idempotencyKey: 'tenant-a:referral-agreement:agreement-1:v1',
    sourceKind: 'referral_agreement',
    sourceId: 'agreement-1',
    sourceVersion: 1,
    title: 'Referral Agreement v1',
    document: {
      name: 'referral-agreement-v1.pdf',
      mediaType: 'application/pdf',
      data: PDF,
    },
    signers: [
      {
        name: 'Signer One',
        email: 'signer@example.test',
        role: 'referrer',
        authentication: {
          method: 'access_code' as const,
          accessCode: 'super-secret-code',
        },
        fields: [
          {
            id: 'signature-1',
            type: 'signature' as const,
            page: 1,
            bounds: { x: 40, y: 700, width: 160, height: 45 },
          },
        ],
      },
    ],
    credentialRef: 'secret://boldsign/tenant-a',
    effectiveFrom: new Date('2026-07-15T00:00:00Z'),
  };
}

function createAssetRuntime(): AssetRuntimeLike {
  return {
    collection: {} as AssetRuntimeLike['collection'],
    associations: {
      attach: vi.fn(async () => ({})),
    } as unknown as AssetRuntimeLike['associations'],
    store: {} as AssetRuntimeLike['store'],
    storeSourceAsset: vi.fn(async (name, _data, options) => ({
      id: randomUUID(),
      tenantId: requireTenantId(),
      name,
      mimeType: options.mimeType,
    })) as unknown as AssetRuntimeLike['storeSourceAsset'],
  };
}

function createProvider() {
  const state: {
    request: SignatureRequest;
    event: SignatureWebhookEvent;
  } = {
    request: request('sent'),
    event: webhookEvent('sent', 'event-sent', '2026-07-14T20:00:00Z'),
  };
  return {
    capabilities: {
      id: 'boldsign',
      displayName: 'BoldSign',
      region: 'ca',
      supportsWebhooks: true,
      supportsCancellation: true,
      supportsExpiryExtension: true,
      supportsSignedDocument: true,
      supportsAuditTrail: true,
      providerEnforcedIdempotency: false,
      authenticationMethods: ['none', 'access_code'] as const,
    },
    createRequest: vi.fn(async () => state.request),
    getRequest: vi.fn(async () => state.request),
    cancelRequest: vi.fn(async () => state.request),
    extendExpiry: vi.fn(async () => state.request),
    downloadArtifact: vi.fn(async (input) =>
      artifact(input.kind, input.kind === 'signed_document' ? SIGNED : AUDIT),
    ),
    parseWebhook: vi.fn((input) => {
      if (input.signature !== 'valid') throw new Error('invalid webhook');
      return state.event;
    }),
    get request() {
      return state.request;
    },
    set request(value: SignatureRequest) {
      state.request = value;
    },
    get event() {
      return state.event;
    },
    set event(value: SignatureWebhookEvent) {
      state.event = value;
    },
  } satisfies SignatureProvider & {
    request: SignatureRequest;
    event: SignatureWebhookEvent;
  };
}

function request(status: SignatureRequest['status']): SignatureRequest {
  return {
    provider: 'boldsign',
    tenantId: TENANT,
    id: 'request-1',
    status,
    title: 'Referral Agreement v1',
    signers: [
      {
        id: 'signer-1',
        name: 'Signer One',
        email: 'signer@example.test',
        role: 'referrer',
        status: status === 'completed' ? 'signed' : 'pending',
        authenticationMethod: 'access_code',
      },
    ],
    createdAt: new Date('2026-07-14T20:00:00Z'),
  };
}

function webhookEvent(
  status: SignatureWebhookEvent['status'],
  id: string,
  createdAt: string,
): SignatureWebhookEvent {
  return {
    id,
    provider: 'boldsign',
    tenantId: TENANT,
    requestId: 'request-1',
    type: status,
    status,
    createdAt: new Date(createdAt),
    signers: request(status).signers,
    replay: {
      deduplicationKey: id,
      orderingKey: 'request-1',
    },
    raw: { id, status },
  };
}

function completedEvent(): SignatureWebhookEvent {
  return webhookEvent('completed', 'event-completed', '2026-07-14T21:00:00Z');
}

function artifact(
  kind: SignatureArtifact['kind'],
  bytes: Buffer,
): SignatureArtifact {
  return {
    provider: 'boldsign',
    tenantId: TENANT,
    requestId: 'request-1',
    kind,
    filename: `${kind}.pdf`,
    mediaType: 'application/pdf',
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    sha256: Promise.resolve(hash(bytes)),
    retrievedAt: new Date('2026-07-14T21:00:01Z'),
  };
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
