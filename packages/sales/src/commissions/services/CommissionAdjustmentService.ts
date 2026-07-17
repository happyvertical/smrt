/** Tenant-safe, idempotent creation of immutable commission adjustments. */

import { randomUUID } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  requireTenantId,
  TenantContextError,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionAdjustmentOperationCollection } from '../collections/CommissionAdjustmentOperationCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { CommissionAdjustment } from '../models/CommissionAdjustment.js';
import {
  COMMISSION_ADJUSTMENT_KINDS,
  type CommissionAdjustmentKind,
} from '../types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CommissionAdjustmentServiceDeps {
  commissions: CommissionCollection;
  adjustments: CommissionAdjustmentCollection;
  operations: CommissionAdjustmentOperationCollection;
  earners: EarnerCollection;
}

interface TransactionCapableDatabase extends DatabaseInterface {
  transaction?<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

/** One immutable operator correction intent. */
export interface CreateCommissionAdjustmentInput {
  /** Stable caller-supplied UUID; retries MUST reuse it. */
  operationId: string;
  tenantId: string;
  commissionId: string;
  /** Denormalized value, validated against the parent Commission. */
  earnerId: string;
  adjustmentKind: CommissionAdjustmentKind;
  /** Signed integer cents; zero is not an adjustment. */
  amountCents: number;
  /** ISO currency, validated against the parent Commission. */
  currency: string;
  reason: string;
  /** Cross-package Profile UUID identifying the operator/automation. */
  createdByProfileId: string;
  metadata?: Record<string, unknown>;
}

export interface CreateCommissionAdjustmentResult {
  adjustment: CommissionAdjustment;
  /** `true` only when this invocation persisted the row. */
  created: boolean;
}

export type CommissionAdjustmentReplayMismatchField =
  | 'tenantId'
  | 'commissionId'
  | 'earnerId'
  | 'adjustmentKind'
  | 'amountCents'
  | 'currency'
  | 'reason'
  | 'createdByProfileId'
  | 'metadata';

/** Typed fail-closed result for a reused operation UUID with another intent. */
export class CommissionAdjustmentReplayConflictError extends Error {
  readonly code = 'COMMISSION_ADJUSTMENT_REPLAY_CONFLICT' as const;

  constructor(
    readonly operationId: string,
    readonly mismatches: readonly CommissionAdjustmentReplayMismatchField[],
  ) {
    super(
      `Commission adjustment operation '${operationId}' was already used with ` +
        `different immutable ${mismatches.length === 1 ? 'field' : 'fields'}: ` +
        mismatches.join(', '),
    );
    this.name = 'CommissionAdjustmentReplayConflictError';
  }
}

export type CommissionAdjustmentValidationReason =
  | 'tenant_context_mismatch'
  | 'invalid_operation_id'
  | 'invalid_tenant_id'
  | 'invalid_commission_id'
  | 'invalid_earner_id'
  | 'invalid_operator_profile_id'
  | 'invalid_adjustment_kind'
  | 'invalid_amount'
  | 'invalid_currency'
  | 'invalid_metadata'
  | 'reason_required'
  | 'commission_not_found'
  | 'commission_tenant_mismatch'
  | 'earner_not_found'
  | 'earner_tenant_mismatch'
  | 'earner_mismatch'
  | 'currency_mismatch'
  | 'transaction_unavailable'
  | 'operation_adjustment_missing';

/** Actionable validation refusal raised before any adjustment is persisted. */
export class CommissionAdjustmentValidationError extends Error {
  readonly code = 'COMMISSION_ADJUSTMENT_VALIDATION_ERROR' as const;

  constructor(
    readonly reason: CommissionAdjustmentValidationReason,
    message: string,
  ) {
    super(message);
    this.name = 'CommissionAdjustmentValidationError';
  }
}

interface CanonicalAdjustmentIntent {
  operationId: string;
  tenantId: string;
  commissionId: string;
  earnerId: string;
  adjustmentKind: CommissionAdjustmentKind;
  amountCents: number;
  currency: string;
  reason: string;
  createdByProfileId: string;
  metadata: string;
}

export class CommissionAdjustmentService {
  private constructor(private readonly deps: CommissionAdjustmentServiceDeps) {}

  static async create(
    options: SmrtClassOptions = {},
  ): Promise<CommissionAdjustmentService> {
    return new CommissionAdjustmentService({
      commissions: await CommissionCollection.create(options),
      adjustments: await CommissionAdjustmentCollection.create(options),
      operations: await CommissionAdjustmentOperationCollection.create(options),
      earners: await EarnerCollection.create(options),
    });
  }

  /**
   * Create exactly one immutable adjustment for `operationId`.
   *
   * The operation fence table's primary UUID is the serialization point. The
   * fence and adjustment are committed in one transaction. An exact replay
   * returns the persisted row; any changed immutable input raises
   * {@link CommissionAdjustmentReplayConflictError}. The claim primitive uses
   * `ON CONFLICT DO NOTHING`, so a losing PostgreSQL transaction remains
   * usable and can read/verify the committed winner rather than entering an
   * aborted transaction state.
   */
  async createAdjustment(
    input: CreateCommissionAdjustmentInput,
  ): Promise<CreateCommissionAdjustmentResult> {
    const intent = this.canonicalize(input);
    this.assertTenant(intent.tenantId);
    return await this.runTransaction(async (deps) => {
      const existingOperation = await deps.operations.findByOperationId(
        intent.operationId,
      );
      if (existingOperation) {
        return await this.replayFromOperation(deps, existingOperation, intent);
      }

      await this.assertParentAndEarner(deps, intent);
      const adjustmentId = randomUUID();
      const claimed = await deps.operations.claim({
        operationId: intent.operationId,
        tenantId: intent.tenantId,
        adjustmentId,
      });

      if (!claimed.operation) {
        // The operation UUID exists outside this tenant. Tenant-scoped reads
        // deliberately reveal no foreign row or payload; report only that the
        // caller's tenant is not the owner of the globally unique operation.
        throw new CommissionAdjustmentReplayConflictError(intent.operationId, [
          'tenantId',
        ]);
      }
      if (!claimed.claimed) {
        return await this.replayFromOperation(deps, claimed.operation, intent);
      }

      const { operationId: _operationId, ...adjustmentIntent } = intent;
      const adjustment = await deps.adjustments.create({
        id: adjustmentId,
        ...adjustmentIntent,
      });
      this.assertExactReplay(adjustment, intent);
      return { adjustment, created: true };
    });
  }

  private canonicalize(
    input: CreateCommissionAdjustmentInput,
  ): CanonicalAdjustmentIntent {
    this.assertUuid(input.operationId, 'invalid_operation_id', 'operationId');
    this.assertUuid(input.tenantId, 'invalid_tenant_id', 'tenantId');
    if (input.tenantId !== input.tenantId.toLowerCase()) {
      throw new CommissionAdjustmentValidationError(
        'invalid_tenant_id',
        'Commission adjustment tenantId must use canonical lowercase UUID casing',
      );
    }
    this.assertUuid(
      input.commissionId,
      'invalid_commission_id',
      'commissionId',
    );
    this.assertUuid(input.earnerId, 'invalid_earner_id', 'earnerId');
    this.assertUuid(
      input.createdByProfileId,
      'invalid_operator_profile_id',
      'createdByProfileId',
    );
    if (!COMMISSION_ADJUSTMENT_KINDS.includes(input.adjustmentKind)) {
      throw new CommissionAdjustmentValidationError(
        'invalid_adjustment_kind',
        `Unknown commission adjustment kind '${String(input.adjustmentKind)}'`,
      );
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents === 0) {
      throw new CommissionAdjustmentValidationError(
        'invalid_amount',
        'Commission adjustment amountCents must be a non-zero safe integer',
      );
    }
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new CommissionAdjustmentValidationError(
        'invalid_currency',
        'Commission adjustment currency must be a three-letter ISO code',
      );
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new CommissionAdjustmentValidationError(
        'reason_required',
        'Commission adjustment reason is required',
      );
    }

    return {
      operationId: input.operationId.toLowerCase(),
      tenantId: input.tenantId.toLowerCase(),
      commissionId: input.commissionId.toLowerCase(),
      earnerId: input.earnerId.toLowerCase(),
      adjustmentKind: input.adjustmentKind,
      amountCents: input.amountCents,
      currency,
      reason,
      createdByProfileId: input.createdByProfileId.toLowerCase(),
      metadata: this.canonicalMetadata(
        input.metadata === undefined ? {} : input.metadata,
      ),
    };
  }

  private assertTenant(tenantId: string): void {
    let activeTenantId: string;
    try {
      activeTenantId = requireTenantId();
    } catch (error) {
      if (!(error instanceof TenantContextError)) throw error;
      throw new CommissionAdjustmentValidationError(
        'tenant_context_mismatch',
        'Commission adjustment creation requires an active tenant context',
      );
    }
    if (
      activeTenantId !== activeTenantId.toLowerCase() ||
      activeTenantId !== tenantId
    ) {
      throw new CommissionAdjustmentValidationError(
        'tenant_context_mismatch',
        'Commission adjustment tenant must exactly match the canonical lowercase active tenant',
      );
    }
  }

  private async assertParentAndEarner(
    deps: CommissionAdjustmentServiceDeps,
    intent: CanonicalAdjustmentIntent,
  ): Promise<void> {
    const commission = await deps.commissions.get({
      id: intent.commissionId,
    });
    if (!commission) {
      throw new CommissionAdjustmentValidationError(
        'commission_not_found',
        `Commission '${intent.commissionId}' was not found in the active tenant`,
      );
    }
    if (commission.tenantId?.toLowerCase() !== intent.tenantId) {
      throw new CommissionAdjustmentValidationError(
        'commission_tenant_mismatch',
        'Commission does not belong to the adjustment tenant',
      );
    }
    if (commission.earnerId.toLowerCase() !== intent.earnerId) {
      throw new CommissionAdjustmentValidationError(
        'earner_mismatch',
        `Adjustment earner '${intent.earnerId}' does not match Commission earner '${commission.earnerId}'`,
      );
    }
    if (commission.currency.toUpperCase() !== intent.currency) {
      throw new CommissionAdjustmentValidationError(
        'currency_mismatch',
        `Adjustment currency '${intent.currency}' does not match Commission currency '${commission.currency}'`,
      );
    }

    const earner = await deps.earners.get({ id: intent.earnerId });
    if (!earner) {
      throw new CommissionAdjustmentValidationError(
        'earner_not_found',
        `Earner '${intent.earnerId}' was not found in the active tenant`,
      );
    }
    if (earner.tenantId?.toLowerCase() !== intent.tenantId) {
      throw new CommissionAdjustmentValidationError(
        'earner_tenant_mismatch',
        'Earner does not belong to the adjustment tenant',
      );
    }
  }

  private assertExactReplay(
    existing: CommissionAdjustment,
    intent: CanonicalAdjustmentIntent,
  ): void {
    const mismatches: CommissionAdjustmentReplayMismatchField[] = [];
    if (existing.tenantId?.toLowerCase() !== intent.tenantId)
      mismatches.push('tenantId');
    if (existing.commissionId.toLowerCase() !== intent.commissionId)
      mismatches.push('commissionId');
    if (existing.earnerId.toLowerCase() !== intent.earnerId)
      mismatches.push('earnerId');
    if (existing.adjustmentKind !== intent.adjustmentKind)
      mismatches.push('adjustmentKind');
    if (existing.amountCents !== intent.amountCents)
      mismatches.push('amountCents');
    if (existing.currency.toUpperCase() !== intent.currency)
      mismatches.push('currency');
    if (existing.reason !== intent.reason) mismatches.push('reason');
    if (existing.createdByProfileId.toLowerCase() !== intent.createdByProfileId)
      mismatches.push('createdByProfileId');
    if (canonicalizePersistedJson(existing.metadata) !== intent.metadata)
      mismatches.push('metadata');
    if (mismatches.length > 0) {
      throw new CommissionAdjustmentReplayConflictError(
        intent.operationId,
        mismatches,
      );
    }
  }

  private assertUuid(
    value: string,
    reason: CommissionAdjustmentValidationReason,
    field: string,
  ): void {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new CommissionAdjustmentValidationError(
        reason,
        `Commission adjustment ${field} must be a UUID`,
      );
    }
  }

  private canonicalMetadata(metadata: Record<string, unknown>): string {
    try {
      if (!isPlainJsonObject(metadata)) {
        throw new TypeError('metadata must be a plain JSON object');
      }
      return stableJson(metadata);
    } catch (error) {
      throw new CommissionAdjustmentValidationError(
        'invalid_metadata',
        `Commission adjustment metadata must be JSON-serializable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async replayFromOperation(
    deps: CommissionAdjustmentServiceDeps,
    operation: { adjustmentId: string },
    intent: CanonicalAdjustmentIntent,
  ): Promise<CreateCommissionAdjustmentResult> {
    const adjustment = await deps.adjustments.get({
      id: operation.adjustmentId,
    });
    if (!adjustment) {
      throw new CommissionAdjustmentValidationError(
        'operation_adjustment_missing',
        `Commission adjustment operation '${intent.operationId}' has no visible adjustment`,
      );
    }
    this.assertExactReplay(adjustment, intent);
    return { adjustment, created: false };
  }

  private async runTransaction<T>(
    fn: (deps: CommissionAdjustmentServiceDeps) => Promise<T>,
  ): Promise<T> {
    const db = this.deps.adjustments.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function') {
      throw new CommissionAdjustmentValidationError(
        'transaction_unavailable',
        'Commission adjustment creation requires a transaction-capable database adapter',
      );
    }
    return await db.transaction(async (tx) =>
      fn({
        commissions: await CommissionCollection.create({ db: tx }),
        adjustments: await CommissionAdjustmentCollection.create({ db: tx }),
        operations: await CommissionAdjustmentOperationCollection.create({
          db: tx,
        }),
        earners: await EarnerCollection.create({ db: tx }),
      }),
    );
  }
}

function canonicalizePersistedJson(value: string): string {
  try {
    return stableJson(JSON.parse(value) as unknown);
  } catch {
    return value;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value, new Set<object>()));
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sortJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('metadata must be acyclic');
    ancestors.add(value);
    try {
      return value.map((item) => sortJsonValue(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('metadata objects must be plain JSON objects');
    }
    if (ancestors.has(value)) throw new TypeError('metadata must be acyclic');
    ancestors.add(value);
    try {
      const sorted = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) sorted[key] = sortJsonValue(item, ancestors);
      }
      return sorted;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError('metadata must contain only JSON values');
}

export default CommissionAdjustmentService;
