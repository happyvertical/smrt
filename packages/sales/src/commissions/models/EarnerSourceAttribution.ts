/**
 * EarnerSourceAttribution — indexed external attribution mapping for an
 * {@link Earner}.
 *
 * Maps a generic external key `(sourceKind, sourceId)` — an ad-network
 * property, a marketplace storefront, a partner account, any
 * application-defined attribution surface — to the Earner credited for it.
 * High-volume ingestion resolves earners through the indexed lookups on
 * `EarnerSourceAttributionCollection` / `EarnerAttributionService` instead of
 * scanning every active earner's JSON metadata.
 *
 * The kind space is the CONSUMER's to define. It may — but need not —
 * coincide with the `(sourceKind, sourceId)` earning-source pairs recorded on
 * EarningEvents and Commissions: an application can attribute earners by
 * property while its earning events carry the network as their source.
 *
 * ## Uniqueness and tenancy
 *
 * Natural key `(tenant_id, source_kind, source_id)` (`conflictColumns`): one
 * mapping per external key per tenant. A `create` for an existing key
 * UPSERTS — it re-points the mapping to the new `earnerId` (idempotent
 * registration; use `EarnerAttributionService.registerAttribution` to observe
 * whether a call created or re-pointed). The adapters' null-aware upsert
 * dedups NULL-tenant (global) keys too, but the unique INDEX itself treats
 * NULLs as distinct, so duplicate global rows can still arrive outside the
 * model layer (raw-SQL imports, pre-null-aware data) — the lookups treat
 * more than one ACTIVE row for a key as ambiguous and fail closed instead
 * of picking one.
 *
 * With an active tenant context, lookups resolve within that tenant only
 * (global rows are invisible). Without tenant context (`optional` mode)
 * lookups see every row, so operator-level resolution across tenants can
 * surface an ambiguity that per-tenant resolution would not — tenant-scoped
 * applications should resolve inside `withTenant()`.
 *
 * ## Migrating metadata-based associations
 *
 * Consumers that previously stashed the association in `Earner.metadata`
 * migrate with a one-time loop — `registerAttribution` is the idempotent
 * backfill primitive (re-running the loop upserts, never duplicates):
 *
 * ```typescript
 * const service = await EarnerAttributionService.create({ db });
 * for (const earner of await earners.list({})) {
 *   const propertyIds = (earner.getMetadata().propertyIds ?? []) as string[];
 *   for (const propertyId of propertyIds) {
 *     await service.registerAttribution({
 *       earnerId: earner.id!,
 *       sourceKind: 'ad_network_property',
 *       sourceId: propertyId,
 *       tenantId: earner.tenantId,
 *     });
 *   }
 * }
 * // Verify via resolveActiveEarnersBySources(), then drop the metadata key.
 * ```
 *
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type {
  EarnerSourceAttributionOptions,
  EarnerSourceAttributionStatus,
} from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  // One mapping per external key per tenant — a retried registration
  // upserts (re-points) instead of duplicating. NULL-tenant rows opt out of
  // dedup (see the class doc); the lookups fail closed on the resulting
  // ambiguity.
  conflictColumns: ['tenant_id', 'source_kind', 'source_id'],
  // Configuration rows: full read plus create/update (deactivate via
  // status). No generated delete on ANY surface — deactivation preserves
  // the audit trail of who was credited for a surface (a bare `cli: true`
  // would regenerate the delete verb this contract closes).
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { include: ['list', 'get', 'create', 'update'] },
})
export class EarnerSourceAttribution extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global mappings). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The {@link Earner} credited for this external key. Required. */
  @foreignKey('Earner', { required: true })
  earnerId: string = '';

  /**
   * Consumer-defined attribution kind (`ad_network_property`,
   * `marketplace_storefront`, …). Required.
   */
  @field({ required: true })
  sourceKind: string = '';

  /**
   * External identifier within {@link sourceKind}. Required. Indexed so
   * batched ingestion lookups stay bounded by the requested ids even
   * without a tenant predicate (the natural-key index is led by
   * `tenant_id`, which tenant-context lookups use).
   */
  @field({ required: true, indexed: true })
  sourceId: string = '';

  /**
   * Mapping lifecycle: only `active` rows resolve through the lookups.
   * `inactive` retains the row for audit.
   */
  status: EarnerSourceAttributionStatus = 'active';

  /** Additional metadata as a JSON string. */
  metadata: string = '{}';

  constructor(options: EarnerSourceAttributionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.earnerId !== undefined) this.earnerId = options.earnerId;
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  /** Parse {@link metadata}; returns `{}` on empty/invalid JSON. */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      const parsed = JSON.parse(this.metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Serialize and store {@link metadata}. */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data ?? {});
  }

  /**
   * Save with two guards:
   *
   * 1. **Completeness** — a mapping without an earner or a full external
   *    key can never resolve, so it must never persist.
   * 2. **Tenant coherence** — the mapping's tenant must equal its earner's
   *    tenant (both normalized; `''` and `NULL` mean "no tenant"). A tenant
   *    A mapping crediting a tenant B earner would be unresolvable in
   *    tenant scope yet credit across tenants in operator scope — fail
   *    closed at the model boundary, for the generated create/update
   *    surface as much as the service. The earner row is read RAW (no
   *    tenant interception) because the guard must see the earner's true
   *    tenant even when saving from another tenant's context.
   */
  override async save(): Promise<this> {
    if (!this.earnerId || !this.sourceKind || !this.sourceId) {
      throw new Error(
        `EarnerSourceAttribution ${this.id ?? '<new>'}: earnerId, ` +
          'sourceKind, and sourceId are all required.',
      );
    }
    await this.assertEarnerTenantCoherence();
    return (await super.save()) as this;
  }

  private async assertEarnerTenantCoherence(): Promise<void> {
    let earnerRow: Record<string, unknown> | null = null;
    try {
      earnerRow = await this.db.get('earners', { id: this.earnerId });
    } catch {
      // DB not ready / earners table absent — nothing to compare against
      // (the FK layer owns pure existence).
      return;
    }
    if (!earnerRow) {
      throw new Error(
        `EarnerSourceAttribution ${this.id ?? '<new>'}: earner ` +
          `'${this.earnerId}' does not exist.`,
      );
    }
    const tenantOf = (value: unknown) => (value ? String(value) : null);
    const earnerTenant = tenantOf(earnerRow.tenant_id);
    // Compare against the EFFECTIVE tenant: an unset tenantId is
    // auto-stamped from the active tenant context by the tenancy
    // interceptor during save, after this guard runs.
    const mappingTenant =
      tenantOf(this.tenantId) ?? tenantOf(getCurrentTenant()?.tenantId);
    if (earnerTenant !== mappingTenant) {
      throw new Error(
        `EarnerSourceAttribution ${this.id ?? '<new>'}: mapping tenant ` +
          `'${mappingTenant ?? 'global'}' does not match earner tenant ` +
          `'${earnerTenant ?? 'global'}' — a mapping must live in its ` +
          "earner's tenant.",
      );
    }
  }
}

export default EarnerSourceAttribution;
