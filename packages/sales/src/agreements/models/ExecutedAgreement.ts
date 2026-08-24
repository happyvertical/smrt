/** Immutable accepted agreement version and its durable evidence artifacts. */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ExecutedAgreementOptions } from '../types.js';
import { coerceAgreementDate } from '../types.js';

const persistedAgreementState = new WeakMap<ExecutedAgreement, string>();

@TenantScoped({ mode: 'required' })
@smrt({
  conflictColumns: ['tenant_id', 'execution_id'],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
})
export class ExecutedAgreement extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('AgreementExecution', { required: true })
  executionId: string = '';

  @field({ required: true })
  sourceKind: string = '';

  @field({ required: true })
  sourceId: string = '';

  sourceVersion: number = 1;

  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  sourceAssetId: string = '';

  sourceSha256: string = '';
  sourceSizeBytes: number = 0;

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
  signerEvidence: string = '[]';
  acceptedAt: Date = new Date();
  effectiveFrom: Date | null = null;
  effectiveTo: Date | null = null;

  @foreignKey('ExecutedAgreement')
  supersedesExecutedAgreementId: string | null = null;

  metadata: string = '{}';

  constructor(options: ExecutedAgreementOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.executionId !== undefined)
      this.executionId = options.executionId;
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
    if (options.signerEvidence !== undefined)
      this.signerEvidence = options.signerEvidence;
    if (options.acceptedAt !== undefined)
      this.acceptedAt = coerceAgreementDate(options.acceptedAt) ?? new Date();
    if (options.effectiveFrom !== undefined)
      this.effectiveFrom = coerceAgreementDate(options.effectiveFrom);
    if (options.effectiveTo !== undefined)
      this.effectiveTo = coerceAgreementDate(options.effectiveTo);
    if (options.supersedesExecutedAgreementId !== undefined)
      this.supersedesExecutedAgreementId =
        options.supersedesExecutedAgreementId;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.acceptedAt = coerceAgreementDate(this.acceptedAt) ?? new Date();
    this.effectiveFrom = coerceAgreementDate(this.effectiveFrom);
    this.effectiveTo = coerceAgreementDate(this.effectiveTo);
    if (this.isPersisted)
      persistedAgreementState.set(this, this.serializeState());
    return this;
  }

  isEffectiveAt(at: Date): boolean {
    return !(
      (this.effectiveFrom && at < this.effectiveFrom) ||
      (this.effectiveTo && at > this.effectiveTo)
    );
  }

  override async save(): Promise<this> {
    const captured = persistedAgreementState.get(this);
    if (captured !== undefined && captured !== this.serializeState()) {
      throw new Error(
        `ExecutedAgreement ${this.id ?? '<new>'}: executed agreements are immutable; create a versioned amendment`,
      );
    }
    if (captured === undefined && !this.isPersisted) this.requireInsertOnSave();
    const result = (await super.save()) as this;
    persistedAgreementState.set(this, this.serializeState());
    return result;
  }

  private serializeState(): string {
    return JSON.stringify({
      tenantId: this.tenantId,
      executionId: this.executionId,
      sourceKind: this.sourceKind,
      sourceId: this.sourceId,
      sourceVersion: this.sourceVersion,
      sourceAssetId: this.sourceAssetId,
      sourceSha256: this.sourceSha256,
      sourceSizeBytes: this.sourceSizeBytes,
      signedDocumentAssetId: this.signedDocumentAssetId,
      signedDocumentSha256: this.signedDocumentSha256,
      signedDocumentSizeBytes: this.signedDocumentSizeBytes,
      signedDocumentMediaType: this.signedDocumentMediaType,
      signedDocumentFilename: this.signedDocumentFilename,
      auditTrailAssetId: this.auditTrailAssetId,
      auditTrailSha256: this.auditTrailSha256,
      auditTrailSizeBytes: this.auditTrailSizeBytes,
      auditTrailMediaType: this.auditTrailMediaType,
      auditTrailFilename: this.auditTrailFilename,
      signerEvidence: this.signerEvidence,
      acceptedAt: this.acceptedAt.toISOString(),
      effectiveFrom: this.effectiveFrom?.toISOString() ?? null,
      effectiveTo: this.effectiveTo?.toISOString() ?? null,
      supersedesExecutedAgreementId: this.supersedesExecutedAgreementId,
      metadata: this.metadata,
    });
  }
}

export default ExecutedAgreement;
