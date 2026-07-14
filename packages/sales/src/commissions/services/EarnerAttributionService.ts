/**
 * EarnerAttributionService — registration and indexed resolution of
 * {@link EarnerSourceAttribution} mappings.
 *
 * High-volume ingestion (e.g. billing events that must credit an earner per
 * ad-network property) resolves earners here: one indexed attribution query
 * plus one earner load per call, bounded by the REQUESTED keys — never a
 * scan of all active earners. Resolution is fail-closed: a key that cannot
 * be proven to map to exactly one active mapping and one active earner
 * resolves to nothing, with a typed reason.
 *
 * Registration is the idempotent write path (and the documented
 * metadata-migration backfill primitive — see the model doc): re-registering
 * a key updates the existing mapping in place and reports the displaced
 * earner instead of silently duplicating.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { EarnerSourceAttributionCollection } from '../collections/EarnerSourceAttributionCollection.js';
import type { Earner } from '../models/Earner.js';
import type { EarnerSourceAttribution } from '../models/EarnerSourceAttribution.js';
import type { EarnerSourceAttributionStatus } from '../types.js';

/** Collaborators for {@link EarnerAttributionService}. */
export interface EarnerAttributionServiceDeps {
  earners: EarnerCollection;
  attributions: EarnerSourceAttributionCollection;
}

/**
 * Why a source key did not resolve to an active earner. Every reason is
 * fail-closed — the key resolves to nothing rather than to a guess.
 *
 * - `no_mapping` — no attribution row for the key.
 * - `mapping_inactive` — row(s) exist but none is `active`.
 * - `ambiguous_mapping` — more than one ACTIVE row for the key (resolving
 *   without tenant context across tenants, or duplicate global rows minted
 *   outside the model layer — the unique index treats NULL tenants as
 *   distinct). Repair by deactivating/deleting the extras, then re-resolve.
 * - `earner_not_found` — the mapping's earner does not exist or is not
 *   visible in the current tenant scope.
 * - `earner_not_active` — the earner exists but is `pending`/`suspended`.
 */
export type EarnerSourceResolutionRefusal =
  | 'no_mapping'
  | 'mapping_inactive'
  | 'ambiguous_mapping'
  | 'earner_not_found'
  | 'earner_not_active';

/** Result of {@link EarnerAttributionService.resolveActiveEarnerBySource}. */
export interface ResolveActiveEarnerResult {
  /** The resolved ACTIVE earner, or `null` with a {@link reason}. */
  earner: Earner | null;
  /** The active mapping that resolved, when {@link earner} is set. */
  attribution: EarnerSourceAttribution | null;
  /** Why resolution failed — set exactly when {@link earner} is `null`. */
  reason?: EarnerSourceResolutionRefusal;
}

/** Result of {@link EarnerAttributionService.resolveActiveEarnersBySources}. */
export interface ResolveActiveEarnersBySourcesResult {
  /** Requested sourceId → resolved active earner (resolved keys only). */
  earnersBySourceId: Map<string, Earner>;
  /** Requested sourceId → the active mapping that resolved it. */
  attributionsBySourceId: Map<string, EarnerSourceAttribution>;
  /** Keys that did not resolve, each with its fail-closed reason. */
  unresolved: { sourceId: string; reason: EarnerSourceResolutionRefusal }[];
}

/** Input for {@link EarnerAttributionService.registerAttribution}. */
export interface RegisterAttributionInput {
  earnerId: string;
  sourceKind: string;
  sourceId: string;
  /**
   * Tenant for the mapping. Defaults to the earner's own `tenantId` so
   * registrations from operator/scheduled contexts land in the earner's
   * tenant. When given explicitly it MUST equal the earner's tenant — a
   * mapping lives in its earner's tenant (model save guard).
   */
  tenantId?: string | null;
  status?: EarnerSourceAttributionStatus;
  metadata?: string;
}

/** Result of {@link EarnerAttributionService.registerAttribution}. */
export interface RegisterAttributionResult {
  attribution: EarnerSourceAttribution;
  /** `true` when THIS call created the mapping (vs updating in place). */
  created: boolean;
  /** The earner the key previously mapped to, when re-pointed. */
  previousEarnerId: string | null;
}

export class EarnerAttributionService {
  constructor(private readonly deps: EarnerAttributionServiceDeps) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<EarnerAttributionService> {
    return new EarnerAttributionService({
      earners: await EarnerCollection.create(classOptions),
      attributions:
        await EarnerSourceAttributionCollection.create(classOptions),
    });
  }

  /**
   * Register (or re-point) the mapping for one external key WITHIN ONE
   * TENANT. The registration's target tenant is `input.tenantId` when
   * given, else the earner's own `tenantId` — and the update-vs-create
   * decision considers only that tenant's rows, so an operator/scheduled
   * registration (no tenant context) can never re-point or re-tenant
   * ANOTHER tenant's mapping for the same key, and legitimate per-tenant
   * mappings of one key are never mistaken for duplicates. A mapping's
   * tenant is fixed at registration (re-tenanting is not supported).
   *
   * Idempotent: an existing target-tenant mapping is updated in place —
   * never duplicated — and the displaced earner is reported. Throws when
   * the earner does not exist, when the key is incomplete, or when the key
   * already holds MULTIPLE rows within the target tenant (duplicates
   * minted outside the model layer — repair before registering again).
   *
   * Two concurrent first registrations of the same key converge through the
   * natural-key upsert (the adapters' null-aware upsert covers NULL-tenant
   * keys too — last write wins). Should a duplicate global row still arrive
   * outside the model layer, the lookups fail closed on it until repaired.
   */
  async registerAttribution(
    input: RegisterAttributionInput,
  ): Promise<RegisterAttributionResult> {
    if (!input.earnerId || !input.sourceKind || !input.sourceId) {
      throw new Error(
        'EarnerAttributionService.registerAttribution: earnerId, sourceKind, and sourceId are required',
      );
    }
    const earner = await this.deps.earners.get({ id: input.earnerId });
    if (!earner) {
      throw new Error(
        `EarnerAttributionService: earner '${input.earnerId}' not found`,
      );
    }

    // '' and NULL both mean "no tenant" depending on dialect — normalize.
    const tenantOf = (value: string | null | undefined) => value || null;
    const targetTenant = tenantOf(
      input.tenantId !== undefined ? input.tenantId : earner.tenantId,
    );
    // Only the TARGET tenant's rows participate in the update-vs-create
    // decision. In tenant context the interceptor already narrows the
    // query; without context (operator/scheduled) this filter is what
    // keeps another tenant's mapping for the same key untouchable.
    const scoped = (
      await this.deps.attributions.findBySource(
        input.sourceKind,
        input.sourceId,
      )
    ).filter((row) => tenantOf(row.tenantId) === targetTenant);
    // Ambiguity means more than one ACTIVE row — inactive duplicates are
    // exactly what the documented repair (deactivation) produces, and they
    // must not keep blocking registration afterwards.
    const active = scoped.filter((row) => row.isActive());
    if (active.length > 1) {
      throw new Error(
        `EarnerAttributionService: source '${input.sourceKind}:${input.sourceId}' ` +
          `holds ${active.length} active mappings in the target tenant scope — deactivate the duplicates before registering`,
      );
    }

    // Prefer the single active row; with only inactive rows (a repaired
    // duplicate set), reuse the OLDEST deterministically instead of
    // inserting a sibling.
    const current = active[0] ?? scoped[0];
    if (current) {
      const previousEarnerId =
        current.earnerId !== input.earnerId ? current.earnerId : null;
      current.earnerId = input.earnerId;
      current.status = input.status ?? 'active';
      if (input.metadata !== undefined) current.metadata = input.metadata;
      await current.save();
      return { attribution: current, created: false, previousEarnerId };
    }

    const minted = await this.deps.attributions.create({
      tenantId: targetTenant,
      earnerId: input.earnerId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      status: input.status ?? 'active',
      metadata: input.metadata ?? '{}',
    });
    // Adopt the PERSISTED row: two workers racing the first registration
    // of one key both reach the natural-key upsert, and the loser's
    // in-memory instance carries an id the database no longer holds
    // (same convergence pattern as createPayoutBatch).
    const persisted = (
      await this.deps.attributions.findBySource(
        input.sourceKind,
        input.sourceId,
      )
    ).filter((row) => tenantOf(row.tenantId) === targetTenant);
    const attribution =
      persisted.length === 1 ? persisted[0] : (persisted[0] ?? minted);
    return { attribution, created: true, previousEarnerId: null };
  }

  /**
   * Resolve the ACTIVE earner for one external key. Exactly two queries
   * regardless of how many earners exist. Fail-closed: `earner` is `null`
   * with a typed {@link ResolveActiveEarnerResult.reason} unless the key
   * maps unambiguously to one active mapping whose earner is active.
   */
  async resolveActiveEarnerBySource(input: {
    sourceKind: string;
    sourceId: string;
  }): Promise<ResolveActiveEarnerResult> {
    const batched = await this.resolveActiveEarnersBySources({
      sourceKind: input.sourceKind,
      sourceIds: [input.sourceId],
    });
    const earner = batched.earnersBySourceId.get(input.sourceId) ?? null;
    if (earner) {
      return {
        earner,
        attribution: batched.attributionsBySourceId.get(input.sourceId) ?? null,
      };
    }
    return {
      earner: null,
      attribution: null,
      reason: batched.unresolved[0]?.reason ?? 'no_mapping',
    };
  }

  /**
   * Resolve the ACTIVE earners for a batch of external keys sharing one
   * kind. Query work is bounded by the REQUESTED ids — one indexed
   * attribution `IN` query plus one earner load for the mapped ids — never
   * a scan of all active earners. Duplicate/empty requested ids are
   * deduped; every requested id comes back either in
   * `earnersBySourceId` or in `unresolved` with its fail-closed reason.
   */
  async resolveActiveEarnersBySources(input: {
    sourceKind: string;
    sourceIds: string[];
  }): Promise<ResolveActiveEarnersBySourcesResult> {
    if (!input.sourceKind) {
      throw new Error(
        'EarnerAttributionService.resolveActiveEarnersBySources: sourceKind is required',
      );
    }
    const requested = [...new Set(input.sourceIds.filter(Boolean))];
    const result: ResolveActiveEarnersBySourcesResult = {
      earnersBySourceId: new Map(),
      attributionsBySourceId: new Map(),
      unresolved: [],
    };
    if (requested.length === 0) return result;

    const rows = await this.deps.attributions.findBySources(
      input.sourceKind,
      requested,
    );
    const rowsBySourceId = new Map<string, EarnerSourceAttribution[]>();
    for (const row of rows) {
      const bucket = rowsBySourceId.get(row.sourceId);
      if (bucket) {
        bucket.push(row);
      } else {
        rowsBySourceId.set(row.sourceId, [row]);
      }
    }

    // Classify each requested key down to its single active mapping (or a
    // fail-closed reason) before touching the earners table.
    const activeBySourceId = new Map<string, EarnerSourceAttribution>();
    for (const sourceId of requested) {
      const bucket = rowsBySourceId.get(sourceId) ?? [];
      if (bucket.length === 0) {
        result.unresolved.push({ sourceId, reason: 'no_mapping' });
        continue;
      }
      const active = bucket.filter((row) => row.isActive());
      if (active.length === 0) {
        result.unresolved.push({ sourceId, reason: 'mapping_inactive' });
        continue;
      }
      if (active.length > 1) {
        result.unresolved.push({ sourceId, reason: 'ambiguous_mapping' });
        continue;
      }
      activeBySourceId.set(sourceId, active[0]);
    }
    if (activeBySourceId.size === 0) return result;

    const earnerIds = [
      ...new Set(
        [...activeBySourceId.values()]
          .map((row) => row.earnerId)
          .filter(Boolean),
      ),
    ];
    const earners = await this.deps.earners.listByIds(earnerIds);
    const earnerById = new Map<string, Earner>();
    for (const earner of earners) {
      if (earner.id) earnerById.set(earner.id, earner);
    }

    for (const [sourceId, attribution] of activeBySourceId) {
      const earner = earnerById.get(attribution.earnerId);
      if (!earner) {
        result.unresolved.push({ sourceId, reason: 'earner_not_found' });
        continue;
      }
      if (!earner.isActive()) {
        result.unresolved.push({ sourceId, reason: 'earner_not_active' });
        continue;
      }
      result.earnersBySourceId.set(sourceId, earner);
      result.attributionsBySourceId.set(sourceId, attribution);
    }
    return result;
  }
}

export default EarnerAttributionService;
