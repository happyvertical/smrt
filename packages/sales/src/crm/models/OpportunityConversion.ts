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
}

export default OpportunityConversion;
