/** Collection helpers for generic versioned agreements. */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { assertTenantReadAllowed } from '@happyvertical/smrt-tenancy';
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
    return await this.list({
      where: {
        kind,
        partyA: serializeAgreementParty(partyA),
        partyB: serializeAgreementParty(partyB),
      },
      orderBy: 'version DESC',
    });
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
    const candidates = await this.findGoverningCandidates(
      kind,
      partyAValue,
      partyBValue,
      tenantId,
    );
    const matches = candidates.filter(
      (agreement) =>
        agreement.status !== 'draft' && agreement.isEffectiveAt(at),
    );
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

      const versions = await agreements.findVersions(
        draft.kind,
        partyA,
        partyB,
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
      if (predecessor) {
        predecessor.effectiveTo = draft.effectiveFrom;
        predecessor.supersede();
        await predecessor.save();
      }
      draft.activate();
      await draft.save();
      return draft.id as string;
    });
    const activated = await this.get({ id: activatedId });
    if (!activated) throw new Error(`Agreement '${activatedId}' disappeared`);
    return activated;
  }

  private async findGoverningCandidates(
    kind: string,
    partyA: string,
    partyB: string,
    tenantId: string | null | undefined,
  ): Promise<Agreement[]> {
    if (tenantId === undefined) {
      return await this.list({
        where: { kind, partyA, partyB },
        orderBy: 'version DESC',
      });
    }
    if (tenantId === null) {
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
    if (tenantRows.length > 0) return tenantRows;
    return await this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id IS NULL AND kind = ? AND party_a = ? AND party_b = ? ORDER BY version DESC`,
      [kind, partyA, partyB],
      { allowRawOnTenantScoped: true },
    );
  }

  private async runTransaction<T>(
    fn: (agreements: AgreementCollection) => Promise<T>,
  ): Promise<T> {
    const db = this.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function') return await fn(this);
    return await db.transaction(async (tx) =>
      fn(await AgreementCollection.create({ db: tx })),
    );
  }
}

export default AgreementCollection;
