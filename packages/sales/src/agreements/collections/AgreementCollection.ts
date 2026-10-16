/** Collection helpers for generic versioned agreements. */

import {
  invalidateCollectionCache,
  resolveDbCacheKey,
  SmrtCollection,
} from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  getCurrentTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { Agreement, serializeAgreementParty } from '../models/Agreement.js';
import type { AgreementParty } from '../types.js';

export interface AgreementAmendmentChanges {
  terms?: Record<string, unknown>;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  executedAgreementId?: string | null;
  metadata?: Record<string, unknown>;
}

interface TransactionCapableDatabase extends DatabaseInterface {
  transaction?<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

/**
 * Versioned rows for one ordered `(kind, partyA, partyB)` relationship.
 * Party order is intentional: a host-to-tenant agreement is distinct from a
 * tenant-to-host agreement unless the consumer models them as the same kind.
 */
export class AgreementCollection extends SmrtCollection<Agreement> {
  static readonly _itemClass = Agreement;

  async findVersions(
    kind: string,
    partyA: AgreementParty,
    partyB: AgreementParty,
  ): Promise<Agreement[]> {
    return await this.findGoverningCandidates(
      kind,
      serializeAgreementParty(partyA),
      serializeAgreementParty(partyB),
      this.ambientTenantId(),
    );
  }

  /**
   * Resolves the sole version governing `at`. This is a historical query:
   * a superseded or terminated row can still govern before its exclusive
   * `effectiveTo`; today's lifecycle status alone is never used to answer a
   * record-date lookup. Drafts never govern.
   *
   * Generated amendments are non-overlapping because the predecessor ends at
   * the successor's inclusive start. If imported or manually-created rows do
   * overlap, this helper throws instead of silently selecting a version.
   */
  async activeFor(
    kind: string,
    partyA: AgreementParty,
    partyB: AgreementParty,
    at: Date = new Date(),
    tenantId?: string | null,
  ): Promise<Agreement | null> {
    const partyAValue = serializeAgreementParty(partyA);
    const partyBValue = serializeAgreementParty(partyB);
    const lane = tenantId === undefined ? this.ambientTenantId() : tenantId;
    const governs = (agreement: Agreement) =>
      agreement.status !== 'draft' &&
      agreement.status !== 'cancelled' &&
      agreement.isEffectiveAt(at);
    const candidates = await this.findGoverningCandidates(
      kind,
      partyAValue,
      partyBValue,
      lane,
      false,
    );
    let matches = candidates.filter(governs);
    // Global defaults apply only before this tenant lane first governed.
    // An ended tenant relationship must never silently resume global fees.
    const laneHasBegun = candidates.some(
      (agreement) =>
        agreement.status !== 'draft' &&
        agreement.status !== 'cancelled' &&
        (!agreement.effectiveFrom || agreement.effectiveFrom <= at),
    );
    if (matches.length === 0 && lane != null && !laneHasBegun) {
      matches = (
        await this.findGoverningCandidates(
          kind,
          partyAValue,
          partyBValue,
          null,
          false,
        )
      ).filter(governs);
    }
    if (matches.length > 1) {
      throw new Error(
        `Agreement overlap for '${kind}' parties at ${at.toISOString()}; resolve the conflicting effective intervals before using these terms`,
      );
    }
    return matches[0] ?? null;
  }

  /** Creates the next unsigned/draft version without changing prior history. */
  async createAmendment(
    kind: string,
    partyA: AgreementParty,
    partyB: AgreementParty,
    changes: AgreementAmendmentChanges = {},
  ): Promise<Agreement> {
    const versions = await this.findVersions(kind, partyA, partyB);
    const latest = versions[0];
    if (!latest) {
      throw new Error(
        `AgreementCollection.createAmendment: no versions exist for '${kind}' parties — create the initial agreement first`,
      );
    }
    if (latest.tenantId !== (this.ambientTenantId() ?? null)) {
      throw new Error(
        'Create an initial tenant agreement before amending global terms',
      );
    }
    if (changes.terms !== undefined && Array.isArray(changes.terms)) {
      throw new Error('Agreement amendment terms must be a JSON object');
    }
    return await this.create({
      tenantId: latest.tenantId,
      kind,
      partyA: serializeAgreementParty(partyA),
      partyB: serializeAgreementParty(partyB),
      version: latest.version + 1,
      status: 'draft',
      terms:
        changes.terms !== undefined
          ? JSON.stringify(changes.terms)
          : latest.terms,
      effectiveFrom:
        changes.effectiveFrom !== undefined
          ? changes.effectiveFrom
          : latest.effectiveFrom,
      effectiveTo:
        changes.effectiveTo !== undefined
          ? changes.effectiveTo
          : latest.effectiveTo,
      // Execution evidence belongs to exact terms and cannot be copied.
      executedAgreementId: changes.executedAgreementId ?? null,
      metadata:
        changes.metadata !== undefined
          ? JSON.stringify(changes.metadata)
          : latest.metadata,
    });
  }

  /**
   * Activates an amendment and closes any currently governing predecessor at
   * the new version's start. The interval is `[from, to)`, so equal boundary
   * timestamps do not overlap. A future-dated amendment may be activated in
   * advance; record-date lookup still selects its predecessor until `from`.
   */
  async activateAmendment(id: string): Promise<Agreement> {
    const activatedId = await this.runTransaction(async (agreements) => {
      const draft = await agreements.get({ id });
      if (!draft) throw new Error(`Agreement '${id}' was not found`);
      if (!draft.isDraft()) {
        throw new Error('Only a draft Agreement amendment can be activated');
      }
      if (!draft.effectiveFrom) {
        throw new Error('Agreement amendment requires effectiveFrom');
      }
      const partyA = draft.getPartyA();
      const partyB = draft.getPartyB();
      if (!partyA || !partyB) throw new Error('Agreement has invalid parties');

      // Mutation follows the loaded draft's owner, never a global fallback.
      const versions = await agreements.findGoverningCandidates(
        draft.kind,
        serializeAgreementParty(partyA),
        serializeAgreementParty(partyB),
        draft.tenantId,
        false,
      );
      const predecessors = versions.filter(
        (version) =>
          version.id !== draft.id &&
          version.status === 'active' &&
          version.version < draft.version &&
          version.isEffectiveAt(draft.effectiveFrom as Date),
      );
      if (predecessors.length > 1) {
        throw new Error(
          'Agreement amendment has overlapping active predecessors',
        );
      }
      const predecessor = predecessors[0];
      // Validate the resulting intervals before mutating either persisted row.
      // Later activation and backdating must fail here, not corrupt read history.
      const overlaps = versions.some((version) => {
        if (
          version.id === draft.id ||
          version.id === predecessor?.id ||
          version.status === 'draft' ||
          version.status === 'cancelled'
        )
          return false;
        return (
          (!draft.effectiveTo ||
            !version.effectiveFrom ||
            version.effectiveFrom < draft.effectiveTo) &&
          (!version.effectiveTo ||
            version.effectiveTo > (draft.effectiveFrom as Date))
        );
      });
      if (overlaps)
        throw new Error('Agreement amendment would overlap governing history');
      if (
        predecessor?.effectiveFrom &&
        predecessor.effectiveFrom >= draft.effectiveFrom
      ) {
        throw new Error(
          'Agreement amendment would overlap the predecessor start',
        );
      }
      const originalEnd = predecessor?.effectiveTo ?? null;
      if (predecessor) {
        predecessor.effectiveTo = draft.effectiveFrom;
        predecessor.supersede();
        await predecessor.save();
      }
      draft.activate();
      await draft.save();
      // Only this operation writes restoration provenance, from the persisted
      // predecessor it actually closed. Ordinary model writes reject it.
      if (predecessor) {
        await claimLifecycleRevision(draft);
        const recorded = await agreements.db.query(
          `UPDATE ${agreements.tableName} SET amendment_predecessor_id = $1, amendment_predecessor_end = $2 WHERE id = $3 AND status = 'active' RETURNING id`,
          predecessor.id,
          originalEnd?.toISOString() ?? null,
          draft.id,
        );
        if (returnedRows(recorded).length !== 1)
          throw new Error('Agreement activation changed concurrently');
        await draft.refreshAfterLifecycleTransition();
      }
      return draft.id as string;
    });
    invalidateCollectionCache(resolveDbCacheKey(this.db), this.tableName);
    const activated = await this.get({ id: activatedId });
    if (!activated) throw new Error(`Agreement '${activatedId}' disappeared`);
    return activated;
  }

  /** Withdraw a scheduled successor before it has ever governed.
   * Restores only its persisted predecessor boundary, in the same transaction.
   * Repeated/concurrent withdrawal refuses rather than applying recovery twice.
   */
  async withdrawAmendment(id: string): Promise<Agreement> {
    const db = this.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function')
      throw new Error('Agreement withdrawal requires transaction support');
    await db.transaction(async (tx) => {
      const agreements = await AgreementCollection.create({ db: tx });
      const successor = await agreements.get({ id });
      const now = new Date();
      if (
        !successor ||
        successor.status !== 'active' ||
        !successor.effectiveFrom ||
        successor.effectiveFrom <= now ||
        !successor.amendmentPredecessorId
      )
        throw new Error(
          'Only a scheduled active amendment with predecessor provenance can be withdrawn',
        );
      const predecessor = await agreements.get({
        id: successor.amendmentPredecessorId,
      });
      if (
        !predecessor ||
        predecessor.tenantId !== successor.tenantId ||
        predecessor.kind !== successor.kind ||
        predecessor.partyA !== successor.partyA ||
        predecessor.partyB !== successor.partyB ||
        predecessor.version >= successor.version ||
        predecessor.status !== 'superseded' ||
        predecessor.effectiveTo?.getTime() !== successor.effectiveFrom.getTime()
      )
        throw new Error(
          'Agreement withdrawal predecessor no longer matches activation provenance',
        );
      const restoredEnd = successor.amendmentPredecessorEnd;
      if (restoredEnd && restoredEnd <= successor.effectiveFrom)
        throw new Error(
          'Agreement withdrawal has invalid predecessor boundary provenance',
        );
      const versions = await agreements.findGoverningCandidates(
        successor.kind,
        successor.partyA,
        successor.partyB,
        successor.tenantId,
        false,
      );
      if (
        versions.some(
          (row) =>
            row.id !== successor.id &&
            row.id !== predecessor.id &&
            row.status !== 'draft' &&
            row.status !== 'cancelled' &&
            (!restoredEnd ||
              !row.effectiveFrom ||
              row.effectiveFrom < restoredEnd) &&
            (!row.effectiveTo || row.effectiveTo > successor.effectiveFrom!),
        )
      )
        throw new Error('Agreement withdrawal would overlap governing history');
      // The first compare-and-set serializes duplicate withdrawals. The second
      // protects the exact boundary being restored; any failure rolls both back.
      await claimLifecycleRevision(successor);
      const cancelled = await tx.query(
        `UPDATE ${agreements.tableName} SET status = 'cancelled' WHERE id = $1 AND status = 'active' AND effective_from > $2 RETURNING id`,
        id,
        new Date().toISOString(),
      );
      if (returnedRows(cancelled).length !== 1)
        throw new Error(
          'Agreement withdrawal lost its scheduled active transition',
        );
      await claimLifecycleRevision(predecessor);
      const restored = await tx.query(
        `UPDATE ${agreements.tableName} SET status = 'active', effective_to = $1 WHERE id = $2 AND status = 'superseded' AND effective_to = $3 RETURNING id`,
        restoredEnd?.toISOString() ?? null,
        predecessor.id,
        successor.effectiveFrom.toISOString(),
      );
      if (returnedRows(restored).length !== 1)
        throw new Error(
          'Agreement withdrawal predecessor changed concurrently',
        );
      await successor.refreshAfterLifecycleTransition();
      await predecessor.refreshAfterLifecycleTransition();
    });
    invalidateCollectionCache(resolveDbCacheKey(this.db), this.tableName);
    const withdrawn = await this.get({ id });
    if (!withdrawn) throw new Error(`Agreement '${id}' disappeared`);
    return withdrawn;
  }

  private async findGoverningCandidates(
    kind: string,
    partyA: string,
    partyB: string,
    tenantId: string | null | undefined,
    includeGlobalFallback = true,
  ): Promise<Agreement[]> {
    // With no ambient or explicit tenant this is an operator/global lookup;
    // never let optional tenancy turn it into an unscoped cross-tenant read.
    if (tenantId === null) {
      return await this.query(
        `SELECT * FROM ${this.tableName} WHERE tenant_id IS NULL AND kind = ? AND party_a = ? AND party_b = ? ORDER BY version DESC`,
        [kind, partyA, partyB],
        { allowRawOnTenantScoped: true },
      );
    }
    if (tenantId === undefined) {
      return await this.query(
        `SELECT * FROM ${this.tableName} WHERE tenant_id IS NULL AND kind = ? AND party_a = ? AND party_b = ? ORDER BY version DESC`,
        [kind, partyA, partyB],
        { allowRawOnTenantScoped: true },
      );
    }
    assertTenantReadAllowed(tenantId, 'AgreementCollection.activeFor');
    const tenantRows = await this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? AND kind = ? AND party_a = ? AND party_b = ? ORDER BY version DESC`,
      [tenantId, kind, partyA, partyB],
      { allowRawOnTenantScoped: true },
    );
    if (tenantRows.length > 0 || !includeGlobalFallback) return tenantRows;
    return await this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id IS NULL AND kind = ? AND party_a = ? AND party_b = ? ORDER BY version DESC`,
      [kind, partyA, partyB],
      { allowRawOnTenantScoped: true },
    );
  }

  private ambientTenantId(): string | undefined {
    return getCurrentTenant()?.tenantId;
  }

  private async runTransaction<T>(
    fn: (agreements: AgreementCollection) => Promise<T>,
  ): Promise<T> {
    const db = this.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function')
      throw new Error(
        'Agreement amendment activation requires transaction support',
      );
    return await db.transaction(async (tx) =>
      fn(await AgreementCollection.create({ db: tx })),
    );
  }
}

export default AgreementCollection;

function returnedRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: unknown[] })?.rows ?? [];
}

/** Use core's dialect-aware CAS, tenant write guards, revision and change feed. */
async function claimLifecycleRevision(agreement: Agreement): Promise<void> {
  if (!agreement.updated_at)
    throw new Error('Agreement has no persisted revision');
  await agreement.claimRevision(agreement.updated_at);
}
