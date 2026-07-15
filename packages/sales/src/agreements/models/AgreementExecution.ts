/** Mutable orchestration state for one tenant-scoped signature request. */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  AgreementExecutionOptions,
  AgreementExecutionStatus,
  AgreementSignerIntent,
} from '../types.js';
import { coerceAgreementDate } from '../types.js';

interface PersistedExecutionIdentity {
  intent: string;
  providerRequestId: string;
  providerRequestKey: string | null;
  signedDocumentEvidence: string;
  auditTrailEvidence: string;
}

const persistedExecutionIdentity = new WeakMap<
  AgreementExecution,
  PersistedExecutionIdentity
>();

@TenantScoped({ mode: 'required' })
@smrt({
  conflictColumns: ['tenant_id', 'idempotency_key'],
  api: false,
  mcp: false,
  cli: false,
})
export class AgreementExecution extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @field({ required: true })
  provider: string = '';

  /** Non-secret provider account/region reference used for operations. */
  providerAccountRef: string = '';

  /** SDK/SMRT secret-store reference only; never a credential value. */
  credentialRef: string = '';

  @field({ required: true })
  idempotencyKey: string = '';

  @field({ required: true })
  sourceKind: string = '';

  @field({ required: true })
  sourceId: string = '';

  sourceVersion: number = 1;

  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  sourceAssetId: string = '';

  sourceSha256: string = '';
  sourceSizeBytes: number = 0;
  requestIntentSha256: string = '';
  title: string = '';
  signerIntent: string = '[]';
  providerRequestId: string = '';

  /** Unique tenant/provider/request binding fence; derived, never a secret. */
  @field({ type: 'text', nullable: true, unique: true })
  providerRequestKey: string | null = null;

  status: AgreementExecutionStatus = 'prepared';
  expiresAt: Date | null = null;
  cancellationReason: string = '';
  lastProviderEventAt: Date | null = null;
  lastReconciledAt: Date | null = null;
  completedAt: Date | null = null;
  effectiveFrom: Date | null = null;
  effectiveTo: Date | null = null;

  @foreignKey('ExecutedAgreement')
  supersedesExecutedAgreementId: string = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  signedDocumentAssetId: string = '';

  signedDocumentSha256: string = '';
  signedDocumentSizeBytes: number = 0;
  signedDocumentMediaType: string = '';
  signedDocumentFilename: string = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  auditTrailAssetId: string = '';

  auditTrailSha256: string = '';
  auditTrailSizeBytes: number = 0;
  auditTrailMediaType: string = '';
  auditTrailFilename: string = '';
  attemptCount: number = 0;

  /** Operation id holding the current provider-create lease. */
  createLeaseId: string = '';

  /** A crashed create attempt stops fencing recovery after this instant. */
  createLeaseExpiresAt: Date | null = null;

  lastError: string = '';
  metadata: string = '{}';

  constructor(options: AgreementExecutionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.providerAccountRef !== undefined)
      this.providerAccountRef = options.providerAccountRef;
    if (options.credentialRef !== undefined)
      this.credentialRef = options.credentialRef;
    if (options.idempotencyKey !== undefined)
      this.idempotencyKey = options.idempotencyKey;
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.sourceVersion !== undefined)
      this.sourceVersion = options.sourceVersion;
    if (options.sourceAssetId !== undefined)
      this.sourceAssetId = options.sourceAssetId;
    if (options.sourceSha256 !== undefined)
      this.sourceSha256 = options.sourceSha256;
    if (options.sourceSizeBytes !== undefined)
      this.sourceSizeBytes = options.sourceSizeBytes;
    if (options.requestIntentSha256 !== undefined)
      this.requestIntentSha256 = options.requestIntentSha256;
    if (options.title !== undefined) this.title = options.title;
    if (options.signerIntent !== undefined)
      this.signerIntent = options.signerIntent;
    if (options.providerRequestId !== undefined)
      this.providerRequestId = options.providerRequestId;
    if (options.providerRequestKey !== undefined)
      this.providerRequestKey = options.providerRequestKey;
    this.syncProviderRequestKey();
    if (options.status !== undefined) this.status = options.status;
    if (options.expiresAt !== undefined)
      this.expiresAt = coerceAgreementDate(options.expiresAt);
    if (options.cancellationReason !== undefined)
      this.cancellationReason = options.cancellationReason;
    if (options.lastProviderEventAt !== undefined)
      this.lastProviderEventAt = coerceAgreementDate(
        options.lastProviderEventAt,
      );
    if (options.lastReconciledAt !== undefined)
      this.lastReconciledAt = coerceAgreementDate(options.lastReconciledAt);
    if (options.completedAt !== undefined)
      this.completedAt = coerceAgreementDate(options.completedAt);
    if (options.effectiveFrom !== undefined)
      this.effectiveFrom = coerceAgreementDate(options.effectiveFrom);
    if (options.effectiveTo !== undefined)
      this.effectiveTo = coerceAgreementDate(options.effectiveTo);
    if (options.supersedesExecutedAgreementId !== undefined)
      this.supersedesExecutedAgreementId =
        options.supersedesExecutedAgreementId;
    if (options.signedDocumentAssetId !== undefined)
      this.signedDocumentAssetId = options.signedDocumentAssetId;
    if (options.signedDocumentSha256 !== undefined)
      this.signedDocumentSha256 = options.signedDocumentSha256;
    if (options.signedDocumentSizeBytes !== undefined)
      this.signedDocumentSizeBytes = options.signedDocumentSizeBytes;
    if (options.signedDocumentMediaType !== undefined)
      this.signedDocumentMediaType = options.signedDocumentMediaType;
    if (options.signedDocumentFilename !== undefined)
      this.signedDocumentFilename = options.signedDocumentFilename;
    if (options.auditTrailAssetId !== undefined)
      this.auditTrailAssetId = options.auditTrailAssetId;
    if (options.auditTrailSha256 !== undefined)
      this.auditTrailSha256 = options.auditTrailSha256;
    if (options.auditTrailSizeBytes !== undefined)
      this.auditTrailSizeBytes = options.auditTrailSizeBytes;
    if (options.auditTrailMediaType !== undefined)
      this.auditTrailMediaType = options.auditTrailMediaType;
    if (options.auditTrailFilename !== undefined)
      this.auditTrailFilename = options.auditTrailFilename;
    if (options.attemptCount !== undefined)
      this.attemptCount = options.attemptCount;
    if (options.createLeaseId !== undefined)
      this.createLeaseId = options.createLeaseId;
    if (options.createLeaseExpiresAt !== undefined)
      this.createLeaseExpiresAt = coerceAgreementDate(
        options.createLeaseExpiresAt,
      );
    if (options.lastError !== undefined) this.lastError = options.lastError;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.expiresAt = coerceAgreementDate(this.expiresAt);
    this.lastProviderEventAt = coerceAgreementDate(this.lastProviderEventAt);
    this.lastReconciledAt = coerceAgreementDate(this.lastReconciledAt);
    this.completedAt = coerceAgreementDate(this.completedAt);
    this.effectiveFrom = coerceAgreementDate(this.effectiveFrom);
    this.effectiveTo = coerceAgreementDate(this.effectiveTo);
    this.createLeaseExpiresAt = coerceAgreementDate(this.createLeaseExpiresAt);
    if (this.isPersisted)
      persistedExecutionIdentity.set(this, this.captureIdentity());
    return this;
  }

  override async save(): Promise<this> {
    const captured = persistedExecutionIdentity.get(this);
    if (captured) {
      this.assertBoundValueUnchanged(
        'provider request',
        captured.providerRequestId,
        this.providerRequestId,
      );
    }
    this.syncProviderRequestKey();
    if (captured) {
      if (captured.intent !== this.serializeIntent()) {
        throw new Error(
          `AgreementExecution ${this.id ?? '<new>'}: execution identity is immutable`,
        );
      }
      this.assertBoundValueUnchanged(
        'provider request key',
        captured.providerRequestKey ?? '',
        this.providerRequestKey ?? '',
      );
      this.assertBoundValueUnchanged(
        'signed document evidence',
        captured.signedDocumentEvidence,
        this.serializeSignedDocumentEvidence(),
      );
      this.assertBoundValueUnchanged(
        'audit trail evidence',
        captured.auditTrailEvidence,
        this.serializeAuditTrailEvidence(),
      );
    }
    const saved = (await super.save()) as this;
    persistedExecutionIdentity.set(this, this.captureIdentity());
    return saved;
  }

  getSignerIntent(): AgreementSignerIntent[] {
    try {
      const value = JSON.parse(this.signerIntent) as unknown;
      return Array.isArray(value) ? (value as AgreementSignerIntent[]) : [];
    } catch {
      return [];
    }
  }

  private captureIdentity(): PersistedExecutionIdentity {
    return {
      intent: this.serializeIntent(),
      providerRequestId: this.providerRequestId,
      providerRequestKey: this.providerRequestKey,
      signedDocumentEvidence: this.serializeSignedDocumentEvidence(),
      auditTrailEvidence: this.serializeAuditTrailEvidence(),
    };
  }

  private serializeIntent(): string {
    return JSON.stringify({
      tenantId: this.tenantId,
      provider: this.provider,
      providerAccountRef: this.providerAccountRef,
      credentialRef: this.credentialRef,
      idempotencyKey: this.idempotencyKey,
      sourceKind: this.sourceKind,
      sourceId: this.sourceId,
      sourceVersion: this.sourceVersion,
      sourceAssetId: this.sourceAssetId,
      sourceSha256: this.sourceSha256,
      sourceSizeBytes: this.sourceSizeBytes,
      requestIntentSha256: this.requestIntentSha256,
      title: this.title,
      signerIntent: this.signerIntent,
      effectiveFrom: this.effectiveFrom?.toISOString() ?? null,
      effectiveTo: this.effectiveTo?.toISOString() ?? null,
      supersedesExecutedAgreementId: this.supersedesExecutedAgreementId,
      metadata: this.metadata,
    });
  }

  private serializeSignedDocumentEvidence(): string {
    if (!this.signedDocumentAssetId) return '';
    return JSON.stringify({
      assetId: this.signedDocumentAssetId,
      sha256: this.signedDocumentSha256,
      sizeBytes: this.signedDocumentSizeBytes,
      mediaType: this.signedDocumentMediaType,
      filename: this.signedDocumentFilename,
    });
  }

  private serializeAuditTrailEvidence(): string {
    if (!this.auditTrailAssetId) return '';
    return JSON.stringify({
      assetId: this.auditTrailAssetId,
      sha256: this.auditTrailSha256,
      sizeBytes: this.auditTrailSizeBytes,
      mediaType: this.auditTrailMediaType,
      filename: this.auditTrailFilename,
    });
  }

  private assertBoundValueUnchanged(
    label: string,
    captured: string,
    current: string,
  ): void {
    if (captured && captured !== current) {
      throw new Error(
        `AgreementExecution ${this.id ?? '<new>'}: ${label} is immutable once bound`,
      );
    }
  }

  private syncProviderRequestKey(): void {
    if (!this.providerRequestId) {
      this.providerRequestKey = null;
      return;
    }
    if (!this.tenantId || !this.provider) {
      throw new Error(
        'AgreementExecution provider request binding requires tenant and provider',
      );
    }
    const expected = `${this.tenantId}:${this.provider}:${this.providerRequestId}`;
    if (this.providerRequestKey && this.providerRequestKey !== expected) {
      throw new Error(
        `AgreementExecution ${this.id ?? '<new>'}: provider request key does not match its binding`,
      );
    }
    this.providerRequestKey = expected;
  }
}

export default AgreementExecution;
