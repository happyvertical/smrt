/**
 * OpportunityConversion — idempotent link from a won deal to a downstream record.
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { OpportunityConversionOptions } from '../types.js';

/**
 * OpportunityConversion records that a WON opportunity materialized into a
 * downstream record — a client, project, contract, subscription, or any
 * caller-defined kind. The target is a generic `(targetKind, targetId)`
 * string pair: CRM never creates (or mutates) the downstream records
 * themselves and never touches referral or commission state.
 *
 * The natural key `(opportunity_id, target_kind, target_id)`
 * (`conflictColumns`) makes recording idempotent — use
 * `OpportunityConversionCollection.recordConversion()`, which enforces the
 * won-status precondition and reports whether the link already existed.
 * Links are append-only: the generated surfaces expose `list`/`get`/`create`
 * only (no update/delete).
 *
 * @example
 * ```typescript
 * const conversions = await OpportunityConversionCollection.create({ db });
 * const { conversion, created } = await conversions.recordConversion({
 *   opportunityId: opportunity.id ?? '',
 *   targetKind: 'contract',
 *   targetId: contractId,
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create'] }, // append-only — no update/delete
  mcp: { include: ['list', 'get'] },
  cli: false,
  conflictColumns: ['opportunity_id', 'target_kind', 'target_id'],
})
export class OpportunityConversion extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global conversions.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The won opportunity that converted. Required. */
  @foreignKey('Opportunity', { required: true })
  opportunityId: string = '';

  /**
   * Downstream record kind — OPEN string: `'client'`, `'project'`,
   * `'contract'`, `'subscription'`, … Required.
   */
  @field({ required: true })
  targetKind: string = '';

  /** Identifier of the downstream record within `targetKind`. Required. */
  @field({ required: true })
  targetId: string = '';

  /** Optional human-readable note about the conversion. */
  note: string = '';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: OpportunityConversionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.opportunityId !== undefined)
      this.opportunityId = options.opportunityId;
    if (options.targetKind !== undefined) this.targetKind = options.targetKind;
    if (options.targetId !== undefined) this.targetId = options.targetId;
    if (options.note !== undefined) this.note = options.note;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Parse the metadata JSON string; returns `{}` on malformed content. */
  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Serialize and store the metadata object. */
  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }

  /**
   * Save with the append-only guard: a fresh instance whose
   * `(opportunityId, targetKind, targetId)` natural key already belongs to
   * a DIFFERENT row is refused — the conflict-column upsert would replace
   * the existing conversion link (note and id) without the won-opportunity
   * validation. Idempotent linking goes through
   * `OpportunityConversionCollection.recordConversion()`, which finds
   * first and reports `{ created: false }`.
   */
  override async save(): Promise<this> {
    if (this.opportunityId && this.targetKind && this.targetId) {
      try {
        const res = await this.db.query(
          `SELECT id FROM ${this.tableName} WHERE opportunity_id = $1 AND target_kind = $2 AND target_id = $3`,
          this.opportunityId,
          this.targetKind,
          this.targetId,
        );
        const rows = Array.isArray(res)
          ? (res as Record<string, unknown>[])
          : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
        const taken = rows.find((row) => row.id !== this.id);
        if (taken) {
          throw new Error(
            `OpportunityConversion ${this.opportunityId}/${this.targetKind}/${this.targetId}: ` +
              'this conversion link already exists — conversion links are ' +
              'append-only. Use ' +
              'OpportunityConversionCollection.recordConversion() for ' +
              'idempotent linking.',
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('append-only')) {
          throw error;
        }
        // DB not ready / table absent — nothing persisted to collide with.
      }
    }
    return (await super.save()) as this;
  }
}

export default OpportunityConversion;
