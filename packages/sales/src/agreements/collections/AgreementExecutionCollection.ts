import { SmrtCollection } from '@happyvertical/smrt-core';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import { AgreementExecution } from '../models/AgreementExecution.js';
import type { AgreementExecutionStatus } from '../types.js';

export interface ClaimAgreementCreateAttemptInput {
  tenantId: string;
  executionId: string;
  expectedAttemptCount: number;
  expectedLeaseId: string;
  expectedStatus: string;
  expectedLastError: string;
  operationId: string;
  leaseExpiresAt: Date;
  now: Date;
}

export interface CompleteAgreementCreateAttemptInput {
  tenantId: string;
  executionId: string;
  operationId: string;
  provider: string;
  providerRequestId: string;
  status: AgreementExecutionStatus;
  expiresAt: Date | null;
}

export interface FailAgreementCreateAttemptInput {
  tenantId: string;
  executionId: string;
  operationId: string;
  lastError: string;
}

export interface BindAgreementProviderRequestInput {
  tenantId: string;
  executionId: string;
  provider: string;
  providerRequestId: string;
}

export interface CompareAndSetAgreementLifecycleInput {
  tenantId: string;
  executionId: string;
  expectedStatus: AgreementExecutionStatus;
  status: AgreementExecutionStatus;
  expiresAt: Date | null;
  cancellationReason: string;
  lastProviderEventAt: Date;
  lastReconciledAt: Date | null;
  completedAt: Date | null;
}

export interface UpdateAgreementExecutionErrorInput {
  tenantId: string;
  executionId: string;
  lastError: string;
}

export type AgreementEvidenceArtifactKind = 'signed_document' | 'audit_trail';

export interface BindAgreementEvidenceArtifactInput {
  tenantId: string;
  executionId: string;
  kind: AgreementEvidenceArtifactKind;
  assetId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  filename: string;
}

export class AgreementExecutionCollection extends SmrtCollection<AgreementExecution> {
  static readonly _itemClass = AgreementExecution;

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AgreementExecution | null> {
    const rows = await this.list({ where: { idempotencyKey }, limit: 1 });
    return rows[0] ?? null;
  }

  async findByProviderRequest(
    provider: string,
    providerRequestId: string,
  ): Promise<AgreementExecution | null> {
    const rows = await this.list({
      where: { provider, providerRequestId },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * Atomically claim an expired or cleared provider-create lease.
   *
   * The explicit tenant predicate and expected-state predicates make the raw
   * compare-and-swap fail closed across workers. `RETURNING id` is used
   * because not every database adapter reports affected-row counts reliably.
   */
  async claimCreateAttempt(
    input: ClaimAgreementCreateAttemptInput,
  ): Promise<AgreementExecution | null> {
    const ambientTenantId = requireTenantId();
    if (ambientTenantId !== input.tenantId) {
      throw new Error('AgreementExecution create-lease tenant mismatch');
    }
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET attempt_count = attempt_count + 1,
              status = ?,
              last_error = '',
              create_lease_id = ?,
              create_lease_expires_at = ?
        WHERE id = ?
          AND tenant_id = ?
          AND attempt_count = ?
          AND status = ?
          AND COALESCE(last_error, '') = ?
          AND COALESCE(create_lease_id, '') = ?
          AND (provider_request_id IS NULL OR provider_request_id = '')
          AND (create_lease_expires_at IS NULL OR create_lease_expires_at <= ?)
        RETURNING id`,
      'prepared',
      input.operationId,
      input.leaseExpiresAt.toISOString(),
      input.executionId,
      input.tenantId,
      input.expectedAttemptCount,
      input.expectedStatus,
      input.expectedLastError,
      input.expectedLeaseId,
      input.now.toISOString(),
    );
    const claimed = (result.rows as Array<{ id?: unknown }>)[0];
    if (typeof claimed?.id !== 'string') return null;
    return await this.get({ id: claimed.id });
  }

  /**
   * Persist a provider-create result only while the caller still owns its
   * lease. This prevents a slow, expired attempt from overwriting a newer
   * recovery attempt after returning from the provider.
   */
  async completeCreateAttempt(
    input: CompleteAgreementCreateAttemptInput,
  ): Promise<AgreementExecution | null> {
    this.assertCreateAttemptTenant(input.tenantId);
    const providerRequestKey = `${input.tenantId}:${input.provider}:${input.providerRequestId}`;
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET provider_request_id = ?,
              provider_request_key = ?,
              status = ?,
              expires_at = ?,
              last_error = '',
              create_lease_id = '',
              create_lease_expires_at = NULL
        WHERE id = ?
          AND tenant_id = ?
          AND provider = ?
          AND COALESCE(create_lease_id, '') = ?
          AND (provider_request_id IS NULL OR provider_request_id = '')
        RETURNING id`,
      input.providerRequestId,
      providerRequestKey,
      input.status,
      input.expiresAt?.toISOString() ?? null,
      input.executionId,
      input.tenantId,
      input.provider,
      input.operationId,
    );
    return await this.getReturnedExecution(result);
  }

  /** Record a create failure only while the caller still owns its lease. */
  async failCreateAttempt(
    input: FailAgreementCreateAttemptInput,
  ): Promise<AgreementExecution | null> {
    this.assertCreateAttemptTenant(input.tenantId);
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET status = ?,
              last_error = ?,
              create_lease_id = '',
              create_lease_expires_at = NULL
        WHERE id = ?
          AND tenant_id = ?
          AND COALESCE(create_lease_id, '') = ?
          AND (provider_request_id IS NULL OR provider_request_id = '')
        RETURNING id`,
      'failed',
      input.lastError,
      input.executionId,
      input.tenantId,
      input.operationId,
    );
    return await this.getReturnedExecution(result);
  }

  /** Bind an adopted provider request without saving a stale object snapshot. */
  async bindProviderRequest(
    input: BindAgreementProviderRequestInput,
  ): Promise<AgreementExecution | null> {
    this.assertCreateAttemptTenant(input.tenantId);
    const providerRequestKey = `${input.tenantId}:${input.provider}:${input.providerRequestId}`;
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET provider_request_id = ?,
              provider_request_key = ?
        WHERE id = ?
          AND tenant_id = ?
          AND provider = ?
          AND (provider_request_id IS NULL OR provider_request_id = '' OR provider_request_id = ?)
        RETURNING id`,
      input.providerRequestId,
      providerRequestKey,
      input.executionId,
      input.tenantId,
      input.provider,
      input.providerRequestId,
    );
    return await this.getReturnedExecution(result);
  }

  /**
   * Apply provider lifecycle state only while status still matches the
   * caller's snapshot and the candidate observation is not older than the
   * persisted provider event. Service retries re-read the winner before
   * deciding whether the candidate state remains monotonic.
   */
  async compareAndSetLifecycle(
    input: CompareAndSetAgreementLifecycleInput,
  ): Promise<AgreementExecution | null> {
    this.assertCreateAttemptTenant(input.tenantId);
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET status = ?,
              expires_at = ?,
              cancellation_reason = ?,
              last_provider_event_at = ?,
              last_reconciled_at = ?,
              completed_at = ?,
              last_error = ''
        WHERE id = ?
          AND tenant_id = ?
          AND status = ?
          AND (last_provider_event_at IS NULL OR last_provider_event_at <= ?)
        RETURNING id`,
      input.status,
      input.expiresAt?.toISOString() ?? null,
      input.cancellationReason,
      input.lastProviderEventAt.toISOString(),
      input.lastReconciledAt?.toISOString() ?? null,
      input.completedAt?.toISOString() ?? null,
      input.executionId,
      input.tenantId,
      input.expectedStatus,
      input.lastProviderEventAt.toISOString(),
    );
    return await this.getReturnedExecution(result);
  }

  /** Increment audit attempts without writing any lifecycle columns. */
  async incrementAttemptCount(
    tenantId: string,
    executionId: string,
  ): Promise<AgreementExecution> {
    this.assertCreateAttemptTenant(tenantId);
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET attempt_count = attempt_count + 1
        WHERE id = ?
          AND tenant_id = ?
        RETURNING id`,
      executionId,
      tenantId,
    );
    const execution = await this.getReturnedExecution(result);
    if (!execution) {
      throw new Error(`AgreementExecution '${executionId}' was not found`);
    }
    return execution;
  }

  /** Update failure diagnostics without writing a stale lifecycle snapshot. */
  async updateLastError(
    input: UpdateAgreementExecutionErrorInput,
  ): Promise<AgreementExecution> {
    this.assertCreateAttemptTenant(input.tenantId);
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET last_error = ?
        WHERE id = ?
          AND tenant_id = ?
        RETURNING id`,
      input.lastError,
      input.executionId,
      input.tenantId,
    );
    const execution = await this.getReturnedExecution(result);
    if (!execution) {
      throw new Error(
        `AgreementExecution '${input.executionId}' was not found`,
      );
    }
    return execution;
  }

  /**
   * Bind one immutable evidence artifact with a tenant-fenced compare-and-swap.
   * Concurrent finalizers can only publish one asset identity for each kind.
   */
  async bindEvidenceArtifact(
    input: BindAgreementEvidenceArtifactInput,
  ): Promise<AgreementExecution | null> {
    this.assertCreateAttemptTenant(input.tenantId);
    const columns =
      input.kind === 'signed_document'
        ? {
            assetId: 'signed_document_asset_id',
            sha256: 'signed_document_sha256',
            sizeBytes: 'signed_document_size_bytes',
            mediaType: 'signed_document_media_type',
            filename: 'signed_document_filename',
          }
        : {
            assetId: 'audit_trail_asset_id',
            sha256: 'audit_trail_sha256',
            sizeBytes: 'audit_trail_size_bytes',
            mediaType: 'audit_trail_media_type',
            filename: 'audit_trail_filename',
          };
    const result = await this._db.query(
      `UPDATE ${this.tableName}
          SET ${columns.assetId} = ?,
              ${columns.sha256} = ?,
              ${columns.sizeBytes} = ?,
              ${columns.mediaType} = ?,
              ${columns.filename} = ?
        WHERE id = ?
          AND tenant_id = ?
          AND provider_request_id IS NOT NULL
          AND provider_request_id <> ''
          AND ${columns.assetId} IS NULL
        RETURNING id`,
      input.assetId,
      input.sha256,
      input.sizeBytes,
      input.mediaType,
      input.filename,
      input.executionId,
      input.tenantId,
    );
    return await this.getReturnedExecution(result);
  }

  async findBySource(
    sourceKind: string,
    sourceId: string,
  ): Promise<AgreementExecution[]> {
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: 'source_version DESC',
    });
  }

  private assertCreateAttemptTenant(tenantId: string): void {
    if (requireTenantId() !== tenantId) {
      throw new Error('AgreementExecution create-lease tenant mismatch');
    }
  }

  private async getReturnedExecution(result: {
    rows?: unknown;
  }): Promise<AgreementExecution | null> {
    const returned = (result.rows as Array<{ id?: unknown }> | undefined)?.[0];
    if (typeof returned?.id !== 'string') return null;
    return await this.get({ id: returned.id });
  }
}

export default AgreementExecutionCollection;
