/** Provider-neutral signature orchestration and immutable evidence ingestion. */

import { createHash, randomUUID } from 'node:crypto';
import type {
  SignatureArtifact,
  SignatureByteSource,
  SignatureProvider,
  SignatureRequest,
  SignatureWebhookEvent,
} from '@happyvertical/signatures';
import type { AssetRuntimeLike } from '@happyvertical/smrt-assets';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import type { AgreementExecutionCollection } from '../collections/AgreementExecutionCollection.js';
import type { AgreementExecutionEventCollection } from '../collections/AgreementExecutionEventCollection.js';
import type { ExecutedAgreementCollection } from '../collections/ExecutedAgreementCollection.js';
import type { AgreementExecution } from '../models/AgreementExecution.js';
import type { ExecutedAgreement } from '../models/ExecutedAgreement.js';
import type {
  AgreementExecutionResult,
  AgreementWebhookIngestionResult,
  CreateAgreementExecutionInput,
  IngestAgreementWebhookInput,
} from '../types.js';
import {
  coerceAgreementDate,
  sanitizeSignerEvidence,
  sanitizeSignerIntent,
} from '../types.js';

export interface AgreementExecutionServiceDeps {
  provider: SignatureProvider;
  assets: AssetRuntimeLike;
  executions: AgreementExecutionCollection;
  events: AgreementExecutionEventCollection;
  executedAgreements: ExecutedAgreementCollection;
  now?: () => Date;
  createLeaseDurationMs?: number;
}

export interface AdoptAgreementProviderRequestInput {
  tenantId: string;
  executionId: string;
  providerRequestId: string;
  signal?: AbortSignal;
}

export interface AgreementExecutionOperationInput {
  tenantId: string;
  executionId: string;
  signal?: AbortSignal;
}

export interface CancelAgreementExecutionInput
  extends AgreementExecutionOperationInput {
  reason: string;
}

export interface ExtendAgreementExecutionInput
  extends AgreementExecutionOperationInput {
  expiresAt: Date | string;
  warnPrior?: boolean;
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'declined',
  'cancelled',
  'expired',
  'failed',
]);

const STATUS_PROGRESS = new Map([
  ['prepared', 0],
  ['sent', 1],
  ['delivered', 2],
  ['viewed', 3],
  ['partially_signed', 4],
]);

const DEFAULT_CREATE_LEASE_DURATION_MS = 5 * 60 * 1000;

export class AgreementExecutionService {
  private readonly now: () => Date;
  private readonly createLeaseDurationMs: number;

  constructor(private readonly deps: AgreementExecutionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.createLeaseDurationMs =
      deps.createLeaseDurationMs ?? DEFAULT_CREATE_LEASE_DURATION_MS;
    if (
      !Number.isFinite(this.createLeaseDurationMs) ||
      this.createLeaseDurationMs <= 0
    ) {
      throw new Error('Agreement execution create lease must be positive');
    }
  }

  async createExecution(
    input: CreateAgreementExecutionInput,
  ): Promise<AgreementExecutionResult> {
    this.assertTenant(input.tenantId);
    this.assertProviderCapabilities();
    this.assertCreateInput(input);

    const sourceBytes = await readByteSource(input.document.data);
    if (sourceBytes.byteLength === 0) {
      throw new Error('Agreement execution document must not be empty');
    }
    const sourceSha256 = sha256(sourceBytes);
    const effectiveFrom = normalizeOptionalAgreementDate(
      input.effectiveFrom,
      'effectiveFrom',
    );
    const effectiveTo = normalizeOptionalAgreementDate(
      input.effectiveTo,
      'effectiveTo',
    );
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
      throw new Error(
        'Agreement execution effectiveTo must not precede effectiveFrom',
      );
    }
    const requestIntentSha256 = hashRequestIntent(
      input,
      this.deps.provider.capabilities.id,
      sourceSha256,
      effectiveFrom,
      effectiveTo,
    );

    const existing = await this.deps.executions.findByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      this.assertSameIntent(existing, input, requestIntentSha256);
      return await this.resumeOrReplayCreate(existing, input, sourceBytes);
    }

    const sourceAsset = await this.deps.assets.storeSourceAsset(
      input.document.name,
      sourceBytes,
      {
        mimeType: input.document.mediaType,
        typeSlug: 'agreement-source',
        sourceType: 'agreement-execution',
        externalId: input.idempotencyKey,
        metadata: {
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          sha256: sourceSha256,
        },
      },
    );
    this.assertTenantValue(
      sourceAsset.tenantId,
      input.tenantId,
      'source asset',
    );
    if (!sourceAsset.id) throw new Error('Stored source Asset has no id');

    const operationId = randomUUID();
    const createLeaseExpiresAt = this.newCreateLeaseExpiry();
    let execution: AgreementExecution;
    try {
      execution = await this.deps.executions.create({
        tenantId: input.tenantId,
        provider: this.deps.provider.capabilities.id,
        providerAccountRef: input.providerAccountRef ?? '',
        credentialRef: input.credentialRef ?? '',
        idempotencyKey: input.idempotencyKey,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        sourceAssetId: sourceAsset.id,
        sourceSha256,
        sourceSizeBytes: sourceBytes.byteLength,
        requestIntentSha256,
        title: input.title,
        signerIntent: JSON.stringify(sanitizeSignerIntent(input.signers)),
        status: 'prepared',
        effectiveFrom,
        effectiveTo,
        supersedesExecutedAgreementId:
          input.supersedesExecutedAgreementId ?? '',
        metadata: JSON.stringify(input.metadata ?? {}),
        // Persist the remote-attempt fence in the same INSERT that wins the
        // idempotency race. Other callers observe an in-flight attempt and
        // never issue a second provider create.
        attemptCount: 1,
        createLeaseId: operationId,
        createLeaseExpiresAt,
        _insertOnly: true,
      });
    } catch (error) {
      const raced = await this.deps.executions.findByIdempotencyKey(
        input.idempotencyKey,
      );
      if (!raced) throw error;
      this.assertSameIntent(raced, input, requestIntentSha256);
      return await this.resumeOrReplayCreate(raced, input, sourceBytes);
    }
    try {
      await this.ensureAssetAssociation(
        'AgreementExecution',
        execution.id ?? '',
        sourceAsset.id,
        'source_document',
      );
    } catch (error) {
      execution.status = 'failed';
      execution.lastError = summarizeError(error, false);
      this.clearCreateLease(execution);
      await execution.save();
      throw error;
    }
    return await this.sendProviderRequest(
      execution,
      input,
      sourceBytes,
      operationId,
    );
  }

  private async sendProviderRequest(
    execution: AgreementExecution,
    input: CreateAgreementExecutionInput,
    sourceBytes: Buffer,
    operationId: string,
  ): Promise<AgreementExecutionResult> {
    if (execution.createLeaseId !== operationId) {
      throw new Error(
        `AgreementExecution ${execution.id}: provider-create lease is not owned by this operation`,
      );
    }
    try {
      await this.recordOperationAudit(
        execution,
        operationId,
        'create.started',
        'system',
        { attemptCount: execution.attemptCount },
      );
    } catch (error) {
      // No provider mutation occurred, so a later idempotent caller may retry.
      execution.status = 'failed';
      execution.lastError = summarizeError(error, false);
      this.clearCreateLease(execution);
      await execution.save();
      throw error;
    }
    let request: SignatureRequest;
    let providerResponded = false;
    try {
      request = await this.deps.provider.createRequest({
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        title: input.title,
        ...(input.message ? { message: input.message } : {}),
        documents: [
          {
            name: input.document.name,
            mediaType: input.document.mediaType,
            data: sourceBytes,
          },
        ],
        signers: input.signers,
        ...(input.signingOrder !== undefined
          ? { signingOrder: input.signingOrder }
          : {}),
        ...(input.expiresInDays !== undefined
          ? { expiresInDays: input.expiresInDays }
          : {}),
        metadata: {
          ...(input.metadata ?? {}),
          smrtExecutionId: execution.id ?? '',
          smrtSourceKind: input.sourceKind,
          smrtSourceId: input.sourceId,
          smrtSourceVersion: String(input.sourceVersion),
          smrtSourceSha256: execution.sourceSha256,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      providerResponded = true;
      this.assertProviderRequest(request, input.tenantId);
      await this.assertProviderRequestAvailable(execution, request.id);
      await this.bindProviderRequest(execution, request.id);
      execution.status = request.status;
      execution.expiresAt = request.expiresAt ?? null;
      execution.lastError = '';
      this.clearCreateLease(execution);
      await execution.save();
    } catch (error) {
      const mayHaveSucceeded =
        providerResponded || requestMayHaveSucceeded(error);
      execution.status = 'failed';
      execution.lastError = summarizeError(error, mayHaveSucceeded);
      this.clearCreateLease(execution);
      await execution.save();
      await this.recordOperationAudit(
        execution,
        operationId,
        mayHaveSucceeded ? 'create.uncertain' : 'create.failed',
        'provider_operation',
        { error: execution.lastError },
      );
      throw error;
    }
    // Keep the confirmed provider state when append-only audit persistence
    // fails. A replay can safely return the bound request and operators can
    // reconcile the missing audit outcome without duplicating the request.
    await this.recordOperationAudit(
      execution,
      operationId,
      'create.succeeded',
      'provider_operation',
      { providerRequestId: request.id },
    );
    return this.result(execution, execution.attemptCount > 1);
  }

  private async resumeOrReplayCreate(
    execution: AgreementExecution,
    input: CreateAgreementExecutionInput,
    sourceBytes: Buffer,
  ): Promise<AgreementExecutionResult> {
    if (execution.providerRequestId) return this.result(execution, true);
    const now = this.now();
    if (this.isCreateLeaseActive(execution, now)) {
      return this.result(execution, true);
    }
    const abandonedCreate = this.isAbandonedCreate(execution);
    if (
      abandonedCreate &&
      !this.deps.provider.capabilities.providerEnforcedIdempotency
    ) {
      throw new Error(
        `AgreementExecution ${execution.id}: the provider-create lease expired without a confirmed request id; reconcile or adopt the provider request before retrying`,
      );
    }
    if (!abandonedCreate && !this.canSafelyRetryCreate(execution)) {
      throw new Error(
        `AgreementExecution ${execution.id}: the prior provider create has no confirmed request id; reconcile or adopt the provider request before retrying`,
      );
    }
    await this.ensureAssetAssociation(
      'AgreementExecution',
      execution.id ?? '',
      execution.sourceAssetId,
      'source_document',
    );
    const operationId = randomUUID();
    const claimed = await this.deps.executions.claimCreateAttempt({
      tenantId: input.tenantId,
      executionId: execution.id ?? '',
      expectedAttemptCount: execution.attemptCount,
      expectedLeaseId: execution.createLeaseId,
      expectedStatus: execution.status,
      expectedLastError: execution.lastError,
      operationId,
      leaseExpiresAt: this.newCreateLeaseExpiry(now),
      now,
    });
    if (!claimed) {
      const latest = await this.requireExecution(execution.id ?? '');
      if (
        latest.providerRequestId ||
        this.isCreateLeaseActive(latest, this.now())
      ) {
        return this.result(latest, true);
      }
      throw new Error(
        `AgreementExecution ${execution.id}: provider-create state changed while claiming recovery; retry the operation`,
      );
    }
    return await this.sendProviderRequest(
      claimed,
      input,
      sourceBytes,
      operationId,
    );
  }

  /**
   * Bind an operator-reconciled provider request after an uncertain create.
   * This is the safe recovery path for providers without atomic idempotency.
   */
  async adoptProviderRequest(
    input: AdoptAgreementProviderRequestInput,
  ): Promise<AgreementExecutionResult> {
    this.assertTenant(input.tenantId);
    const execution = await this.requireExecution(input.executionId);
    if (
      execution.providerRequestId &&
      execution.providerRequestId !== input.providerRequestId
    ) {
      throw new Error(
        `AgreementExecution ${execution.id} is already bound to a different provider request`,
      );
    }
    const operationId = await this.beginAuditedOperation(
      execution,
      'adopt',
      'operator',
    );
    try {
      const request = await this.deps.provider.getRequest({
        tenantId: input.tenantId,
        requestId: input.providerRequestId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      this.assertProviderRequest(
        request,
        input.tenantId,
        input.providerRequestId,
      );
      await this.assertProviderRequestAvailable(execution, request.id);
      const linkedExecutionId = request.metadata?.smrtExecutionId;
      if (linkedExecutionId && linkedExecutionId !== execution.id) {
        throw new Error(
          `Provider request '${request.id}' belongs to a different agreement execution`,
        );
      }
      await this.bindProviderRequest(execution, request.id);
      this.applyProviderState(execution, request, this.now());
      execution.lastReconciledAt = this.now();
      execution.lastError = '';
      await execution.save();
      await this.completeAuditedOperation(execution, operationId, 'adopt', {
        providerRequestId: request.id,
      });
      return this.result(execution, false);
    } catch (error) {
      await this.failAuditedOperation(
        execution,
        operationId,
        'adopt',
        error,
        false,
      );
      throw error;
    }
  }

  async reconcile(
    input: AgreementExecutionOperationInput,
  ): Promise<AgreementExecutionResult> {
    this.assertTenant(input.tenantId);
    const execution = await this.requireExecution(input.executionId);
    this.requireProviderRequestId(execution);
    const operationId = await this.beginAuditedOperation(
      execution,
      'reconcile',
      'system',
    );
    try {
      const request = await this.deps.provider.getRequest({
        tenantId: input.tenantId,
        requestId: execution.providerRequestId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      this.assertProviderRequest(
        request,
        input.tenantId,
        execution.providerRequestId,
      );
      this.applyProviderState(execution, request, this.now());
      execution.lastReconciledAt = this.now();
      execution.lastError = '';
      await execution.save();
      if (execution.status === 'completed') {
        await this.finalizeExecution(execution);
      }
      await this.completeAuditedOperation(execution, operationId, 'reconcile', {
        providerStatus: request.status,
      });
      return this.result(execution, false);
    } catch (error) {
      await this.failAuditedOperation(
        execution,
        operationId,
        'reconcile',
        error,
        false,
      );
      throw error;
    }
  }

  async cancel(
    input: CancelAgreementExecutionInput,
  ): Promise<AgreementExecutionResult> {
    this.assertTenant(input.tenantId);
    if (!input.reason.trim())
      throw new Error('Cancellation reason is required');
    const execution = await this.requireExecution(input.executionId);
    this.requireProviderRequestId(execution);
    if (execution.status === 'cancelled') return this.result(execution, true);
    this.assertNonTerminalOperation(execution, 'cancel');
    const operationId = await this.beginAuditedOperation(
      execution,
      'cancel',
      'operator',
      { reason: input.reason },
    );
    let providerResponded = false;
    try {
      const request = await this.deps.provider.cancelRequest({
        tenantId: input.tenantId,
        requestId: execution.providerRequestId,
        reason: input.reason,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      providerResponded = true;
      this.assertProviderRequest(
        request,
        input.tenantId,
        execution.providerRequestId,
      );
      this.applyProviderState(execution, request, this.now());
      execution.cancellationReason = input.reason;
      execution.lastError = '';
      await execution.save();
      await this.completeAuditedOperation(execution, operationId, 'cancel', {
        providerStatus: request.status,
      });
      return this.result(execution, false);
    } catch (error) {
      await this.failAuditedOperation(
        execution,
        operationId,
        'cancel',
        error,
        true,
        providerResponded,
      );
      throw error;
    }
  }

  async extendExpiry(
    input: ExtendAgreementExecutionInput,
  ): Promise<AgreementExecutionResult> {
    this.assertTenant(input.tenantId);
    const execution = await this.requireExecution(input.executionId);
    this.requireProviderRequestId(execution);
    this.assertNonTerminalOperation(execution, 'extend expiry for');
    const operationId = await this.beginAuditedOperation(
      execution,
      'extend_expiry',
      'operator',
      {
        expiresAt: normalizeRequiredAgreementDate(
          input.expiresAt,
        ).toISOString(),
      },
    );
    let providerResponded = false;
    try {
      const request = await this.deps.provider.extendExpiry({
        tenantId: input.tenantId,
        requestId: execution.providerRequestId,
        expiresAt: input.expiresAt,
        ...(input.warnPrior !== undefined
          ? { warnPrior: input.warnPrior }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      providerResponded = true;
      this.assertProviderRequest(
        request,
        input.tenantId,
        execution.providerRequestId,
      );
      this.applyProviderState(execution, request, this.now());
      execution.lastError = '';
      await execution.save();
      await this.completeAuditedOperation(
        execution,
        operationId,
        'extend_expiry',
        { expiresAt: request.expiresAt?.toISOString() ?? null },
      );
      return this.result(execution, false);
    } catch (error) {
      await this.failAuditedOperation(
        execution,
        operationId,
        'extend_expiry',
        error,
        true,
        providerResponded,
      );
      throw error;
    }
  }

  async ingestWebhook(
    input: IngestAgreementWebhookInput,
  ): Promise<AgreementWebhookIngestionResult> {
    this.assertTenant(input.tenantId);

    // The SDK adapter verifies authenticity and freshness before any state is
    // read or written. Signature headers are deliberately never persisted.
    const providerEvent = this.deps.provider.parseWebhook({
      payload: input.payload,
      signature: input.signature,
    });
    this.assertTenantValue(
      providerEvent.tenantId,
      input.tenantId,
      'verified webhook',
    );
    if (providerEvent.provider !== this.deps.provider.capabilities.id) {
      throw new Error('Verified webhook provider does not match the adapter');
    }

    const execution = await this.deps.executions.findByProviderRequest(
      providerEvent.provider,
      providerEvent.requestId,
    );
    if (!execution) {
      throw new Error(
        `No AgreementExecution is bound to provider request '${providerEvent.requestId}'`,
      );
    }

    const dedupeKey = `${input.tenantId}:${providerEvent.provider}:${providerEvent.replay.deduplicationKey}`;
    const recorded = await this.deps.events.recordVerified({
      tenantId: input.tenantId,
      executionId: execution.id ?? '',
      provider: providerEvent.provider,
      providerEventId: providerEvent.id,
      eventOrigin: 'provider_webhook',
      dedupeKey,
      orderingKey: providerEvent.replay.orderingKey,
      eventType: providerEvent.type,
      status: providerEvent.status,
      occurredAt: providerEvent.createdAt,
      receivedAt: this.now(),
      payloadSha256: sha256(Buffer.from(input.payload, 'utf8')),
      signerEvidence: JSON.stringify(
        sanitizeSignerEvidence(providerEvent.signers),
      ),
      payload: input.payload,
    });

    if (this.shouldApplyEvent(execution, providerEvent)) {
      execution.status = providerEvent.status;
      execution.lastProviderEventAt = providerEvent.createdAt;
      if (providerEvent.status === 'completed') {
        execution.completedAt = providerEvent.createdAt;
      }
      execution.lastError = '';
      await execution.save();
    }

    let executedAgreement: ExecutedAgreement | null = null;
    if (execution.status === 'completed') {
      const operationId = await this.beginAuditedOperation(
        execution,
        'finalize',
        'system',
        { providerEventId: providerEvent.id },
      );
      try {
        executedAgreement = await this.finalizeExecution(
          execution,
          providerEvent,
        );
        await this.completeAuditedOperation(
          execution,
          operationId,
          'finalize',
          { executedAgreementId: executedAgreement.id ?? '' },
        );
      } catch (error) {
        await this.failAuditedOperation(
          execution,
          operationId,
          'finalize',
          error,
          false,
        );
        throw error;
      }
    }

    return {
      executionId: execution.id ?? '',
      eventId: recorded.event.id ?? '',
      replayed: !recorded.created,
      ...(executedAgreement?.id
        ? { executedAgreementId: executedAgreement.id }
        : {}),
    };
  }

  private async finalizeExecution(
    execution: AgreementExecution,
    verifiedEvent?: SignatureWebhookEvent,
  ): Promise<ExecutedAgreement> {
    this.assertTenant(execution.tenantId);
    const existing = await this.deps.executedAgreements.findByExecution(
      execution.id ?? '',
    );
    if (existing) {
      await this.ensureExecutedAgreementAssociations(existing);
      return existing;
    }
    this.requireProviderRequestId(execution);

    const request = await this.deps.provider.getRequest({
      tenantId: execution.tenantId,
      requestId: execution.providerRequestId,
    });
    this.assertProviderRequest(
      request,
      execution.tenantId,
      execution.providerRequestId,
    );
    if (request.status !== 'completed') {
      throw new Error(
        `Provider request '${request.id}' is '${request.status}', not completed`,
      );
    }

    let signedMetadata: StoredArtifactMetadata | undefined;
    if (!execution.signedDocumentAssetId) {
      signedMetadata = await this.retrieveAndStoreArtifact(
        execution,
        'signed_document',
      );
      execution.signedDocumentAssetId = signedMetadata.assetId;
      execution.signedDocumentSha256 = signedMetadata.sha256;
      execution.signedDocumentSizeBytes = signedMetadata.sizeBytes;
      execution.signedDocumentMediaType = signedMetadata.mediaType;
      execution.signedDocumentFilename = signedMetadata.filename;
      await execution.save();
    }

    let auditMetadata: StoredArtifactMetadata | undefined;
    if (!execution.auditTrailAssetId) {
      auditMetadata = await this.retrieveAndStoreArtifact(
        execution,
        'audit_trail',
      );
      execution.auditTrailAssetId = auditMetadata.assetId;
      execution.auditTrailSha256 = auditMetadata.sha256;
      execution.auditTrailSizeBytes = auditMetadata.sizeBytes;
      execution.auditTrailMediaType = auditMetadata.mediaType;
      execution.auditTrailFilename = auditMetadata.filename;
      await execution.save();
    }

    const signed = signedMetadata ?? {
      assetId: execution.signedDocumentAssetId,
      sha256: execution.signedDocumentSha256,
      sizeBytes: execution.signedDocumentSizeBytes,
      filename: execution.signedDocumentFilename,
      mediaType: execution.signedDocumentMediaType,
    };
    const audit = auditMetadata ?? {
      assetId: execution.auditTrailAssetId,
      sha256: execution.auditTrailSha256,
      sizeBytes: execution.auditTrailSizeBytes,
      filename: execution.auditTrailFilename,
      mediaType: execution.auditTrailMediaType,
    };
    // The authenticated provider read is authoritative and complete; webhook
    // payloads may contain only the signer affected by that event.
    const signerEvidence = sanitizeSignerEvidence(request.signers);
    const acceptedAt =
      execution.completedAt ?? verifiedEvent?.createdAt ?? this.now();

    const created = await this.deps.executedAgreements.createImmutable({
      tenantId: execution.tenantId,
      executionId: execution.id ?? '',
      sourceKind: execution.sourceKind,
      sourceId: execution.sourceId,
      sourceVersion: execution.sourceVersion,
      sourceAssetId: execution.sourceAssetId,
      sourceSha256: execution.sourceSha256,
      sourceSizeBytes: execution.sourceSizeBytes,
      signedDocumentAssetId: signed.assetId,
      signedDocumentSha256: signed.sha256,
      signedDocumentSizeBytes: signed.sizeBytes,
      signedDocumentMediaType: signed.mediaType,
      signedDocumentFilename: signed.filename,
      auditTrailAssetId: audit.assetId,
      auditTrailSha256: audit.sha256,
      auditTrailSizeBytes: audit.sizeBytes,
      auditTrailMediaType: audit.mediaType,
      auditTrailFilename: audit.filename,
      signerEvidence: JSON.stringify(signerEvidence),
      acceptedAt,
      effectiveFrom: execution.effectiveFrom ?? acceptedAt,
      effectiveTo: execution.effectiveTo,
      supersedesExecutedAgreementId: execution.supersedesExecutedAgreementId,
      metadata: execution.metadata,
    });
    await this.ensureExecutedAgreementAssociations(created.agreement);
    execution.status = 'completed';
    execution.completedAt = acceptedAt;
    execution.lastError = '';
    await execution.save();
    return created.agreement;
  }

  private async retrieveAndStoreArtifact(
    execution: AgreementExecution,
    kind: 'signed_document' | 'audit_trail',
  ): Promise<StoredArtifactMetadata> {
    const artifact = await this.deps.provider.downloadArtifact({
      tenantId: execution.tenantId,
      requestId: execution.providerRequestId,
      kind,
    });
    this.assertArtifact(artifact, execution, kind);
    const bytes = await readReadableStream(artifact.stream);
    if (bytes.byteLength === 0) {
      throw new Error(`Downloaded ${kind} artifact was empty`);
    }
    const computed = sha256(bytes);
    const providerHash = (await artifact.sha256).toLowerCase();
    if (computed !== providerHash) {
      throw new Error(
        `Downloaded ${kind} hash did not match the SDK evidence hash`,
      );
    }
    const asset = await this.deps.assets.storeSourceAsset(
      artifact.filename,
      bytes,
      {
        mimeType: artifact.mediaType,
        typeSlug: 'agreement-evidence',
        sourceType: execution.provider,
        externalId: `${execution.providerRequestId}:${kind}`,
        metadata: {
          executionId: execution.id,
          provider: execution.provider,
          providerRequestId: execution.providerRequestId,
          artifactKind: kind,
          sha256: computed,
          retrievedAt: artifact.retrievedAt.toISOString(),
        },
      },
    );
    this.assertTenantValue(asset.tenantId, execution.tenantId, `${kind} asset`);
    if (!asset.id) throw new Error(`Stored ${kind} Asset has no id`);
    await this.ensureAssetAssociation(
      'AgreementExecution',
      execution.id ?? '',
      asset.id,
      kind,
    );
    return {
      assetId: asset.id,
      sha256: computed,
      sizeBytes: bytes.byteLength,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
    };
  }

  private async ensureExecutedAgreementAssociations(
    agreement: ExecutedAgreement,
  ): Promise<void> {
    if (!agreement.id) throw new Error('ExecutedAgreement has no id');
    await this.ensureAssetAssociation(
      'ExecutedAgreement',
      agreement.id,
      agreement.sourceAssetId,
      'source_document',
    );
    await this.ensureAssetAssociation(
      'ExecutedAgreement',
      agreement.id,
      agreement.signedDocumentAssetId,
      'signed_document',
    );
    await this.ensureAssetAssociation(
      'ExecutedAgreement',
      agreement.id,
      agreement.auditTrailAssetId,
      'audit_trail',
    );
  }

  private shouldApplyEvent(
    execution: AgreementExecution,
    event: SignatureWebhookEvent,
  ): boolean {
    if (
      execution.lastProviderEventAt &&
      event.createdAt < execution.lastProviderEventAt
    ) {
      return false;
    }
    return canAdvanceStatus(execution.status, event.status);
  }

  private applyProviderState(
    execution: AgreementExecution,
    request: SignatureRequest,
    observedAt: Date,
  ): void {
    if (!canAdvanceStatus(execution.status, request.status)) return;
    execution.status = request.status;
    execution.expiresAt = request.expiresAt ?? execution.expiresAt;
    execution.lastProviderEventAt = observedAt;
    if (request.status === 'completed') {
      execution.completedAt ??= observedAt;
    }
  }

  private assertProviderRequest(
    request: SignatureRequest,
    tenantId: string,
    expectedRequestId?: string,
  ): void {
    this.assertTenantValue(request.tenantId, tenantId, 'provider request');
    if (request.provider !== this.deps.provider.capabilities.id) {
      throw new Error('Provider request does not match the configured adapter');
    }
    if (!request.id) throw new Error('Provider request has no id');
    if (expectedRequestId && request.id !== expectedRequestId) {
      throw new Error(
        `Provider returned request '${request.id}' while '${expectedRequestId}' was requested`,
      );
    }
  }

  private assertArtifact(
    artifact: SignatureArtifact,
    execution: AgreementExecution,
    kind: 'signed_document' | 'audit_trail',
  ): void {
    this.assertTenantValue(artifact.tenantId, execution.tenantId, kind);
    if (
      artifact.provider !== execution.provider ||
      artifact.requestId !== execution.providerRequestId ||
      artifact.kind !== kind
    ) {
      throw new Error(`Downloaded ${kind} does not match its execution`);
    }
  }

  private assertProviderCapabilities(): void {
    const caps = this.deps.provider.capabilities;
    if (
      !caps.supportsWebhooks ||
      !caps.supportsCancellation ||
      !caps.supportsExpiryExtension ||
      !caps.supportsSignedDocument ||
      !caps.supportsAuditTrail
    ) {
      throw new Error(
        `Signature provider '${caps.id}' lacks required agreement-execution capabilities`,
      );
    }
  }

  private assertSameIntent(
    existing: AgreementExecution,
    input: CreateAgreementExecutionInput,
    requestIntentSha256: string,
  ): void {
    if (
      existing.provider !== this.deps.provider.capabilities.id ||
      existing.sourceKind !== input.sourceKind ||
      existing.sourceId !== input.sourceId ||
      existing.sourceVersion !== input.sourceVersion ||
      existing.title !== input.title ||
      existing.requestIntentSha256 !== requestIntentSha256
    ) {
      throw new Error(
        `Idempotency key '${input.idempotencyKey}' belongs to a different agreement execution`,
      );
    }
  }

  private assertCreateInput(input: CreateAgreementExecutionInput): void {
    for (const [label, value] of [
      ['idempotencyKey', input.idempotencyKey],
      ['sourceKind', input.sourceKind],
      ['sourceId', input.sourceId],
      ['title', input.title],
      ['document.name', input.document.name],
      ['document.mediaType', input.document.mediaType],
    ] as const) {
      if (!value.trim()) {
        throw new Error(`Agreement execution ${label} is required`);
      }
    }
    if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1) {
      throw new Error(
        'Agreement execution sourceVersion must be a positive integer',
      );
    }
    if (
      input.expiresInDays !== undefined &&
      (!Number.isSafeInteger(input.expiresInDays) || input.expiresInDays < 1)
    ) {
      throw new Error(
        'Agreement execution expiresInDays must be a positive integer',
      );
    }
    if (
      input.credentialRef &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(input.credentialRef)
    ) {
      throw new Error(
        'Agreement execution credentialRef must be a secret-store reference URI',
      );
    }
    if (input.signers.length === 0) {
      throw new Error('Agreement execution requires at least one signer');
    }
  }

  private async requireExecution(id: string): Promise<AgreementExecution> {
    const execution = await this.deps.executions.get({ id });
    if (!execution) throw new Error(`AgreementExecution '${id}' was not found`);
    return execution;
  }

  private requireProviderRequestId(execution: AgreementExecution): void {
    if (!execution.providerRequestId) {
      throw new Error(
        `AgreementExecution ${execution.id}: provider request is not confirmed; reconcile or adopt it first`,
      );
    }
  }

  private async assertProviderRequestAvailable(
    execution: AgreementExecution,
    providerRequestId: string,
  ): Promise<void> {
    const bound = await this.deps.executions.findByProviderRequest(
      execution.provider,
      providerRequestId,
    );
    if (bound && bound.id !== execution.id) {
      throw new Error(
        `Provider request '${providerRequestId}' is already bound to another AgreementExecution`,
      );
    }
  }

  private async bindProviderRequest(
    execution: AgreementExecution,
    providerRequestId: string,
  ): Promise<void> {
    if (execution.providerRequestId === providerRequestId) return;
    const priorRequestId = execution.providerRequestId;
    const priorRequestKey = execution.providerRequestKey;
    execution.providerRequestId = providerRequestId;
    try {
      // The derived unique providerRequestKey closes the race left by the
      // application-level availability check.
      await execution.save();
    } catch (error) {
      execution.providerRequestId = priorRequestId;
      execution.providerRequestKey = priorRequestKey;
      throw error;
    }
  }

  private canSafelyRetryCreate(execution: AgreementExecution): boolean {
    if (execution.attemptCount === 0 && execution.status === 'prepared') {
      return true;
    }
    try {
      const summary = JSON.parse(execution.lastError) as {
        requestMayHaveSucceeded?: unknown;
      };
      return summary.requestMayHaveSucceeded === false;
    } catch {
      return false;
    }
  }

  private isAbandonedCreate(execution: AgreementExecution): boolean {
    return (
      execution.status === 'prepared' &&
      execution.attemptCount > 0 &&
      !execution.providerRequestId &&
      !execution.lastError
    );
  }

  private isCreateLeaseActive(
    execution: AgreementExecution,
    at: Date,
  ): boolean {
    return Boolean(
      this.isAbandonedCreate(execution) &&
        execution.createLeaseId &&
        execution.createLeaseExpiresAt &&
        execution.createLeaseExpiresAt.getTime() > at.getTime(),
    );
  }

  private newCreateLeaseExpiry(from = this.now()): Date {
    return new Date(from.getTime() + this.createLeaseDurationMs);
  }

  private clearCreateLease(execution: AgreementExecution): void {
    execution.createLeaseId = '';
    execution.createLeaseExpiresAt = null;
  }

  private async ensureAssetAssociation(
    ownerType: 'AgreementExecution' | 'ExecutedAgreement',
    ownerId: string,
    assetId: string,
    role: 'source_document' | 'signed_document' | 'audit_trail',
  ): Promise<void> {
    if (!ownerId || !assetId) {
      throw new Error(`Cannot link ${role}: owner and Asset ids are required`);
    }
    await this.deps.assets.associations.attach(
      `@happyvertical/smrt-sales:${ownerType}`,
      ownerId,
      assetId,
      { role },
    );
  }

  private async beginAuditedOperation(
    execution: AgreementExecution,
    operation: string,
    origin: 'operator' | 'system',
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    execution.attemptCount += 1;
    await execution.save();
    const operationId = randomUUID();
    try {
      await this.recordOperationAudit(
        execution,
        operationId,
        `${operation}.started`,
        origin,
        { attemptCount: execution.attemptCount, ...metadata },
      );
    } catch (error) {
      execution.lastError = summarizeError(error, false);
      await execution.save();
      throw error;
    }
    return operationId;
  }

  private async completeAuditedOperation(
    execution: AgreementExecution,
    operationId: string,
    operation: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.recordOperationAudit(
      execution,
      operationId,
      `${operation}.succeeded`,
      'provider_operation',
      metadata,
    );
  }

  private async failAuditedOperation(
    execution: AgreementExecution,
    operationId: string,
    operation: string,
    error: unknown,
    mayMutateProvider: boolean,
    providerMutationConfirmed = false,
  ): Promise<void> {
    execution.lastError = summarizeError(error);
    await execution.save();
    const uncertain =
      mayMutateProvider &&
      (providerMutationConfirmed || isPotentiallyUncertain(error));
    await this.recordOperationAudit(
      execution,
      operationId,
      `${operation}.${uncertain ? 'uncertain' : 'failed'}`,
      'provider_operation',
      { error: execution.lastError },
    );
  }

  private async recordOperationAudit(
    execution: AgreementExecution,
    operationId: string,
    eventType: string,
    eventOrigin: 'operator' | 'provider_operation' | 'system',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const occurredAt = this.now();
    const payload = JSON.stringify(metadata);
    await this.deps.events.recordVerified({
      tenantId: execution.tenantId,
      executionId: execution.id ?? '',
      provider: execution.provider,
      providerEventId: '',
      eventOrigin,
      operationId,
      dedupeKey: `${execution.tenantId}:${execution.provider}:operation:${operationId}:${eventType}`,
      orderingKey: execution.providerRequestId || execution.id || operationId,
      eventType: `operation.${eventType}`,
      status: execution.status,
      occurredAt,
      receivedAt: occurredAt,
      payloadSha256: sha256(Buffer.from(payload, 'utf8')),
      signerEvidence: '[]',
      payload,
    });
  }

  private assertNonTerminalOperation(
    execution: AgreementExecution,
    operation: string,
  ): void {
    if (TERMINAL_STATUSES.has(execution.status)) {
      throw new Error(
        `Cannot ${operation} terminal AgreementExecution ${execution.id} in status '${execution.status}'`,
      );
    }
  }

  private result(
    execution: AgreementExecution,
    replayed: boolean,
  ): AgreementExecutionResult {
    return {
      executionId: execution.id ?? '',
      ...(execution.providerRequestId
        ? { providerRequestId: execution.providerRequestId }
        : {}),
      status: execution.status,
      replayed,
    };
  }

  private assertTenant(expected: string): void {
    this.assertTenantValue(requireTenantId(), expected, 'tenant context');
  }

  private assertTenantValue(
    actual: string | null | undefined,
    expected: string,
    context: string,
  ): void {
    if (actual !== expected) {
      throw new Error(
        `Agreement execution tenant mismatch for ${context}: expected '${expected}'`,
      );
    }
  }
}

interface StoredArtifactMetadata {
  assetId: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
  mediaType: string;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hashRequestIntent(
  input: CreateAgreementExecutionInput,
  provider: string,
  sourceSha256: string,
  effectiveFrom: Date | null,
  effectiveTo: Date | null,
): string {
  const sortedMetadata = Object.fromEntries(
    Object.entries(input.metadata ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return sha256(
    Buffer.from(
      JSON.stringify({
        provider,
        providerAccountRef: input.providerAccountRef ?? '',
        credentialRef: input.credentialRef ?? '',
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        sourceSha256,
        documentName: input.document.name,
        documentMediaType: input.document.mediaType,
        title: input.title,
        messageSha256: input.message
          ? sha256(Buffer.from(input.message, 'utf8'))
          : '',
        signers: input.signers.map((signer) => ({
          ...sanitizeSignerIntent([signer])[0],
          privateMessageSha256: signer.privateMessage
            ? sha256(Buffer.from(signer.privateMessage, 'utf8'))
            : '',
          phoneSha256: signer.authentication?.phone
            ? sha256(
                Buffer.from(
                  `${signer.authentication.phone.countryCode}:${signer.authentication.phone.number}`,
                  'utf8',
                ),
              )
            : '',
          identityVerification:
            signer.authentication?.identityVerification ?? null,
          fields: signer.fields.map((field) => ({
            id: field.id,
            type: field.type,
            page: field.page,
            bounds: field.bounds,
            required: field.required ?? true,
            valueSha256: field.value
              ? sha256(Buffer.from(field.value, 'utf8'))
              : '',
          })),
        })),
        signingOrder: input.signingOrder ?? false,
        expiresInDays: input.expiresInDays ?? null,
        effectiveFrom: effectiveFrom?.toISOString() ?? null,
        effectiveTo: effectiveTo?.toISOString() ?? null,
        supersedesExecutedAgreementId:
          input.supersedesExecutedAgreementId ?? '',
        metadata: sortedMetadata,
      }),
      'utf8',
    ),
  );
}

function normalizeOptionalAgreementDate(
  value: Date | string | number | null | undefined,
  label: string,
): Date | null {
  if (value == null) return null;
  const date = coerceAgreementDate(value);
  if (!date) throw new Error(`Agreement execution ${label} is invalid`);
  return date;
}

function normalizeRequiredAgreementDate(value: Date | string): Date {
  const date = coerceAgreementDate(value);
  if (!date) throw new Error('Agreement execution expiresAt is invalid');
  return date;
}

async function readByteSource(source: SignatureByteSource): Promise<Buffer> {
  if (source instanceof Uint8Array) return Buffer.from(source);
  if (isReadableStream(source)) return await readReadableStream(source);
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function readReadableStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function isReadableStream(
  value: SignatureByteSource,
): value is ReadableStream<Uint8Array> {
  return typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}

function summarizeError(
  error: unknown,
  requestMayHaveSucceededOverride?: boolean,
): string {
  const candidate = (error && typeof error === 'object' ? error : {}) as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    retryable?: unknown;
    requestMayHaveSucceeded?: unknown;
  };
  return JSON.stringify({
    name: typeof candidate.name === 'string' ? candidate.name : 'Error',
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.status === 'number'
      ? { status: candidate.status }
      : {}),
    ...(typeof candidate.retryable === 'boolean'
      ? { retryable: candidate.retryable }
      : {}),
    ...(requestMayHaveSucceededOverride !== undefined
      ? { requestMayHaveSucceeded: requestMayHaveSucceededOverride }
      : typeof candidate.requestMayHaveSucceeded === 'boolean'
        ? { requestMayHaveSucceeded: candidate.requestMayHaveSucceeded }
        : {}),
  });
}

function requestMayHaveSucceeded(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { requestMayHaveSucceeded?: unknown })
        .requestMayHaveSucceeded === true,
  );
}

function isPotentiallyUncertain(error: unknown): boolean {
  if (requestMayHaveSucceeded(error)) return true;
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { retryable?: unknown }).retryable === true,
  );
}

function canAdvanceStatus(
  current: AgreementExecution['status'],
  next: AgreementExecution['status'],
): boolean {
  if (current === next) return true;
  // `failed` is also used for local orchestration failures before a provider
  // request is adopted; an authoritative provider read may recover it.
  if (current === 'failed') return true;
  if (TERMINAL_STATUSES.has(current)) return false;
  if (TERMINAL_STATUSES.has(next)) return true;
  return (
    (STATUS_PROGRESS.get(next) ?? -1) >= (STATUS_PROGRESS.get(current) ?? -1)
  );
}

export default AgreementExecutionService;
