import { SmrtCollection } from '@happyvertical/smrt-core';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import { AgreementExecution } from '../models/AgreementExecution.js';

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

  async findBySource(
    sourceKind: string,
    sourceId: string,
  ): Promise<AgreementExecution[]> {
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: 'source_version DESC',
    });
  }
}

export default AgreementExecutionCollection;
