import { SmrtCollection } from '@happyvertical/smrt-core';
import { ExecutedAgreement } from '../models/ExecutedAgreement.js';
import type { ExecutedAgreementOptions } from '../types.js';
import { coerceAgreementDate } from '../types.js';

export class ExecutedAgreementCollection extends SmrtCollection<ExecutedAgreement> {
  static readonly _itemClass = ExecutedAgreement;

  async findByExecution(
    executionId: string,
  ): Promise<ExecutedAgreement | null> {
    const rows = await this.list({ where: { executionId }, limit: 1 });
    return rows[0] ?? null;
  }

  async createImmutable(
    options: ExecutedAgreementOptions,
  ): Promise<{ agreement: ExecutedAgreement; created: boolean }> {
    if (!options.executionId) {
      throw new Error('ExecutedAgreement requires an executionId');
    }
    this.assertCompleteEvidence(options);
    const existing = await this.findByExecution(options.executionId);
    if (existing) {
      this.assertSameEvidence(existing, options);
      return { agreement: existing, created: false };
    }
    const { acceptedAt, effectiveFrom, effectiveTo, ...rest } = options;
    try {
      return {
        agreement: await this.create({
          ...rest,
          ...(acceptedAt !== undefined
            ? { acceptedAt: coerceAgreementDate(acceptedAt) ?? new Date() }
            : {}),
          ...(effectiveFrom !== undefined
            ? { effectiveFrom: coerceAgreementDate(effectiveFrom) }
            : {}),
          ...(effectiveTo !== undefined
            ? { effectiveTo: coerceAgreementDate(effectiveTo) }
            : {}),
          _insertOnly: true,
        }),
        created: true,
      };
    } catch (error) {
      const raced = await this.findByExecution(options.executionId);
      if (!raced) throw error;
      this.assertSameEvidence(raced, options);
      return { agreement: raced, created: false };
    }
  }

  private assertSameEvidence(
    existing: ExecutedAgreement,
    options: ExecutedAgreementOptions,
  ): void {
    const acceptedAt = coerceAgreementDate(options.acceptedAt);
    const effectiveFrom = coerceAgreementDate(options.effectiveFrom);
    const effectiveTo = coerceAgreementDate(options.effectiveTo);
    if (
      existing.sourceKind !== options.sourceKind ||
      existing.sourceId !== options.sourceId ||
      existing.sourceVersion !== options.sourceVersion ||
      existing.sourceAssetId !== options.sourceAssetId ||
      existing.sourceSha256 !== (options.sourceSha256 ?? '') ||
      existing.sourceSizeBytes !== options.sourceSizeBytes ||
      existing.signedDocumentAssetId !== options.signedDocumentAssetId ||
      existing.signedDocumentSha256 !== (options.signedDocumentSha256 ?? '') ||
      existing.signedDocumentSizeBytes !== options.signedDocumentSizeBytes ||
      existing.signedDocumentMediaType !== options.signedDocumentMediaType ||
      existing.signedDocumentFilename !== options.signedDocumentFilename ||
      existing.auditTrailAssetId !== options.auditTrailAssetId ||
      existing.auditTrailSha256 !== (options.auditTrailSha256 ?? '') ||
      existing.auditTrailSizeBytes !== options.auditTrailSizeBytes ||
      existing.auditTrailMediaType !== options.auditTrailMediaType ||
      existing.auditTrailFilename !== options.auditTrailFilename ||
      existing.signerEvidence !== options.signerEvidence ||
      existing.acceptedAt.toISOString() !== acceptedAt?.toISOString() ||
      (existing.effectiveFrom?.toISOString() ?? null) !==
        (effectiveFrom?.toISOString() ?? null) ||
      (existing.effectiveTo?.toISOString() ?? null) !==
        (effectiveTo?.toISOString() ?? null) ||
      existing.supersedesExecutedAgreementId !==
        (options.supersedesExecutedAgreementId ?? '') ||
      existing.metadata !== (options.metadata ?? '{}')
    ) {
      throw new Error(
        `ExecutedAgreement execution '${options.executionId}' collides with different immutable evidence`,
      );
    }
  }

  private assertCompleteEvidence(options: ExecutedAgreementOptions): void {
    for (const [label, value] of [
      ['sourceKind', options.sourceKind],
      ['sourceId', options.sourceId],
      ['sourceAssetId', options.sourceAssetId],
      ['sourceSha256', options.sourceSha256],
      ['signedDocumentAssetId', options.signedDocumentAssetId],
      ['signedDocumentSha256', options.signedDocumentSha256],
      ['signedDocumentMediaType', options.signedDocumentMediaType],
      ['signedDocumentFilename', options.signedDocumentFilename],
      ['auditTrailAssetId', options.auditTrailAssetId],
      ['auditTrailSha256', options.auditTrailSha256],
      ['auditTrailMediaType', options.auditTrailMediaType],
      ['auditTrailFilename', options.auditTrailFilename],
      ['signerEvidence', options.signerEvidence],
    ] as const) {
      if (typeof value !== 'string' || !value) {
        throw new Error(`ExecutedAgreement requires ${label}`);
      }
    }
    if (
      typeof options.sourceVersion !== 'number' ||
      !Number.isSafeInteger(options.sourceVersion) ||
      options.sourceVersion < 1
    ) {
      throw new Error('ExecutedAgreement requires a positive sourceVersion');
    }
    for (const [label, value] of [
      ['sourceSizeBytes', options.sourceSizeBytes],
      ['signedDocumentSizeBytes', options.signedDocumentSizeBytes],
      ['auditTrailSizeBytes', options.auditTrailSizeBytes],
    ] as const) {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 1
      ) {
        throw new Error(`ExecutedAgreement requires a positive ${label}`);
      }
    }
    if (!coerceAgreementDate(options.acceptedAt)) {
      throw new Error('ExecutedAgreement requires a valid acceptedAt');
    }
    try {
      const signers = JSON.parse(options.signerEvidence ?? '') as unknown;
      if (
        !Array.isArray(signers) ||
        signers.length === 0 ||
        signers.some(
          (signer) =>
            !signer ||
            typeof signer !== 'object' ||
            (signer as { status?: unknown }).status !== 'signed',
        )
      ) {
        throw new Error('incomplete');
      }
    } catch {
      throw new Error(
        'ExecutedAgreement requires non-empty signed signerEvidence',
      );
    }
  }

  async findVersionsBySource(
    sourceKind: string,
    sourceId: string,
  ): Promise<ExecutedAgreement[]> {
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: 'source_version DESC',
    });
  }

  async effectiveForSource(
    sourceKind: string,
    sourceId: string,
    at: Date = new Date(),
  ): Promise<ExecutedAgreement | null> {
    const versions = await this.findVersionsBySource(sourceKind, sourceId);
    return versions.find((agreement) => agreement.isEffectiveAt(at)) ?? null;
  }
}

export default ExecutedAgreementCollection;
