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
