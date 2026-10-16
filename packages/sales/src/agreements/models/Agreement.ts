/** Generic versioned, effective-dated commercial terms. */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type AgreementOptions,
  type AgreementParty,
  type AgreementStatus,
  coerceAgreementDate,
} from '../types.js';

const STATUS_TRANSITIONS: Record<AgreementStatus, AgreementStatus[]> = {
  draft: ['active', 'cancelled'],
  cancelled: [],
  active: ['superseded', 'terminated'],
  superseded: [],
  terminated: [],
};

const loadedStatus = new WeakMap<Agreement, AgreementStatus>();
const frozenTerms = new WeakMap<Agreement, string>();
const frozenEnd = new WeakMap<Agreement, number | null>();

/** Validates and canonically serializes a public counterparty descriptor. */
export function serializeAgreementParty(party: AgreementParty): string {
  if (
    !party ||
    typeof party !== 'object' ||
    typeof party.kind !== 'string' ||
    !party.kind.trim() ||
    typeof party.id !== 'string' ||
    !party.id.trim()
  ) {
    throw new Error('Agreement party requires non-empty kind and id');
  }
  return JSON.stringify({ kind: party.kind, id: party.id });
}

/** Parses an agreement party, rejecting corrupt persisted values when active. */
export function parseAgreementParty(value: string): AgreementParty | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as AgreementParty).kind === 'string' &&
      (parsed as AgreementParty).kind.trim() &&
      typeof (parsed as AgreementParty).id === 'string' &&
      (parsed as AgreementParty).id.trim()
    ) {
      return {
        kind: (parsed as AgreementParty).kind,
        id: (parsed as AgreementParty).id,
      };
    }
  } catch {
    // Invalid values are handled by the activation/save guard.
  }
  return null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  conflictColumns: ['tenant_id', 'kind', 'party_a', 'party_b', 'version'],
  // Versions are rows: generated callers can create drafts but cannot edit
  // active terms through a broad update endpoint.
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Agreement extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Open application-defined agreement kind, e.g. `revenue_share`. */
  @field({ required: true })
  kind: string = '';

  /** Canonical JSON {@link AgreementParty}; order is semantically meaningful. */
  @field({ required: true })
  partyA: string = '';

  /** Canonical JSON {@link AgreementParty}; order is semantically meaningful. */
  @field({ required: true })
  partyB: string = '';

  /** Monotonic version within tenant, kind, and ordered counterparties. */
  version: number = 1;

  status: AgreementStatus = 'draft';

  /** JSON object containing consumer-defined, frozen commercial terms. */
  terms: string = '{}';

  /** Inclusive start of the effective interval; null means no lower bound. */
  effectiveFrom: Date | null = null;

  /**
   * Exclusive end of the effective interval; null means no upper bound.
   * It is the one lifecycle-derived field: `AgreementCollection.activateAmendment`
   * closes a predecessor at the new version's start in the same transition.
   */
  effectiveTo: Date | null = null;

  /** Optional immutable e-sign evidence for this exact agreement version. */
  @foreignKey('ExecutedAgreement')
  executedAgreementId: string | null = null;

  /** Activation provenance used only for withdrawing a not-yet-effective amendment. */
  @foreignKey('Agreement')
  amendmentPredecessorId: string | null = null;

  amendmentPredecessorEnd: Date | null = null;

  metadata: string = '{}';

  constructor(options: AgreementOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.partyA !== undefined) this.partyA = options.partyA;
    if (options.partyB !== undefined) this.partyB = options.partyB;
    if (options.version !== undefined) this.version = options.version;
    if (options.status !== undefined) this.status = options.status;
    if (options.terms !== undefined) this.terms = options.terms;
    if (options.effectiveFrom !== undefined)
      this.effectiveFrom = coerceAgreementDate(options.effectiveFrom);
    if (options.effectiveTo !== undefined)
      this.effectiveTo = coerceAgreementDate(options.effectiveTo);
    if (options.executedAgreementId !== undefined)
      this.executedAgreementId = options.executedAgreementId;
    if (options.amendmentPredecessorId !== undefined)
      this.amendmentPredecessorId = options.amendmentPredecessorId;
    if (options.amendmentPredecessorEnd !== undefined)
      this.amendmentPredecessorEnd = coerceAgreementDate(
        options.amendmentPredecessorEnd,
      );
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.effectiveFrom = coerceAgreementDate(this.effectiveFrom);
    this.effectiveTo = coerceAgreementDate(this.effectiveTo);
    this.amendmentPredecessorEnd = coerceAgreementDate(
      this.amendmentPredecessorEnd,
    );
    if (this.isPersisted) {
      loadedStatus.set(this, this.status);
      if (this.status !== 'draft') {
        frozenTerms.set(this, this.serializeFrozenTerms());
        frozenEnd.set(this, this.effectiveTo?.getTime() ?? null);
      }
    }
    return this;
  }

  isDraft(): boolean {
    return this.status === 'draft';
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * Tests the half-open effective interval `[effectiveFrom, effectiveTo)`.
   * This makes an amendment starting at `T` and its predecessor ending at
   * `T` non-overlapping. Lifecycle status is intentionally not considered.
   */
  isEffectiveAt(at: Date): boolean {
    return !(
      (this.effectiveFrom && at < this.effectiveFrom) ||
      (this.effectiveTo && at >= this.effectiveTo)
    );
  }

  getPartyA(): AgreementParty | null {
    return parseAgreementParty(this.partyA);
  }

  getPartyB(): AgreementParty | null {
    return parseAgreementParty(this.partyB);
  }

  setPartyA(party: AgreementParty): void {
    this.partyA = serializeAgreementParty(party);
  }

  setPartyB(party: AgreementParty): void {
    this.partyB = serializeAgreementParty(party);
  }

  getTerms(): Record<string, unknown> {
    return parseObject(this.terms) ?? {};
  }

  setTerms(terms: Record<string, unknown>): void {
    if (!terms || typeof terms !== 'object' || Array.isArray(terms)) {
      throw new Error('Agreement terms must be a JSON object');
    }
    this.terms = JSON.stringify(terms);
  }

  activate(): void {
    if (this.status !== 'draft') {
      throw new Error(
        `Agreement: cannot activate from status '${this.status}'`,
      );
    }
    this.assertValidTerms();
    this.status = 'active';
  }

  supersede(): void {
    if (this.status !== 'active') {
      throw new Error(
        `Agreement: cannot supersede from status '${this.status}'`,
      );
    }
    this.status = 'superseded';
  }

  terminate(at: Date = new Date()): void {
    if (this.status !== 'draft' && this.status !== 'active') {
      throw new Error(
        `Agreement: cannot terminate from status '${this.status}'`,
      );
    }
    if (
      this.status === 'active' &&
      (!this.effectiveTo || this.effectiveTo > at)
    ) {
      this.effectiveTo = at;
    }
    this.status = this.status === 'draft' ? 'cancelled' : 'terminated';
  }

  override async save(): Promise<this> {
    // Natural identity is semantic JSON, never caller property order/spacing.
    const partyA = this.getPartyA();
    const partyB = this.getPartyB();
    if (partyA) this.partyA = serializeAgreementParty(partyA);
    if (partyB) this.partyB = serializeAgreementParty(partyB);
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    this.assertEffectiveIntervalUnchanged(prior);
    this.assertFrozenTermsUnchanged();
    await this.assertNaturalKeyNotTaken();
    if (this.status !== 'draft' && this.status !== 'cancelled')
      this.assertValidTerms();
    const result = (await super.save()) as this;
    loadedStatus.set(this, this.status);
    if (this.status !== 'draft' && !frozenTerms.has(this)) {
      frozenTerms.set(this, this.serializeFrozenTerms());
    }
    if (this.status !== 'draft') {
      frozenEnd.set(this, this.effectiveTo?.getTime() ?? null);
    }
    return result;
  }

  private assertEffectiveIntervalUnchanged(
    prior: AgreementStatus | undefined,
  ): void {
    const captured = frozenEnd.get(this);
    const current = this.effectiveTo?.getTime() ?? null;
    if (captured === undefined || captured === current) return;
    const closing =
      prior === 'active' &&
      (this.status === 'superseded' || this.status === 'terminated');
    if (
      !closing ||
      current === null ||
      (captured !== null && current > captured)
    ) {
      throw new Error(
        'Agreement effective interval is immutable except for lifecycle closure',
      );
    }
  }

  private assertValidTerms(): void {
    if (!this.kind.trim()) throw new Error('Agreement kind is required');
    if (
      !parseAgreementParty(this.partyA) ||
      !parseAgreementParty(this.partyB)
    ) {
      throw new Error('Agreement requires valid partyA and partyB descriptors');
    }
    if (!parseObject(this.terms))
      throw new Error('Agreement terms must be a JSON object');
    if (!Number.isSafeInteger(this.version) || this.version < 1) {
      throw new Error('Agreement version must be a positive integer');
    }
    if (
      this.effectiveFrom &&
      this.effectiveTo &&
      this.effectiveTo <= this.effectiveFrom
    ) {
      throw new Error('Agreement effectiveTo must be after effectiveFrom');
    }
  }

  private async assertNaturalKeyNotTaken(): Promise<void> {
    if (!this.kind || !this.partyA || !this.partyB) return;
    try {
      const res = await this.db.query(
        `SELECT id, tenant_id FROM ${this.tableName} WHERE kind = $1 AND party_a = $2 AND party_b = $3 AND version = $4`,
        this.kind,
        this.partyA,
        this.partyB,
        this.version,
      );
      const rows = Array.isArray(res)
        ? (res as Record<string, unknown>[])
        : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
      if (
        rows.some(
          (row) =>
            (row.tenant_id ?? null) === (this.tenantId ?? null) &&
            row.id !== this.id,
        )
      ) {
        throw new Error(
          `Agreement ${this.kind}@${this.version}: this immutable version already exists; create an amendment instead`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('immutable version')
      ) {
        throw error;
      }
    }
  }

  private async resolvePriorStatus(): Promise<AgreementStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row?.status != null) return row.status as AgreementStatus;
      } catch {
        // Fall back to the loaded state when storage is unavailable.
      }
    }
    return loadedStatus.get(this);
  }

  private assertStatusTransition(prior: AgreementStatus | undefined): void {
    if (prior === undefined || prior === this.status) return;
    if (!(STATUS_TRANSITIONS[prior] ?? []).includes(this.status)) {
      throw new Error(
        `Agreement: illegal status transition '${prior}' → '${this.status}'`,
      );
    }
  }

  private assertFrozenTermsUnchanged(): void {
    const captured = frozenTerms.get(this);
    if (captured && captured !== this.serializeFrozenTerms()) {
      throw new Error(
        'Agreement terms are immutable once active; create an amendment instead',
      );
    }
  }

  private serializeFrozenTerms(): string {
    return JSON.stringify({
      kind: this.kind,
      partyA: this.partyA,
      partyB: this.partyB,
      version: this.version,
      terms: this.terms,
      effectiveFrom: this.effectiveFrom?.toISOString() ?? null,
      executedAgreementId: this.executedAgreementId,
      amendmentPredecessorId: this.amendmentPredecessorId,
      amendmentPredecessorEnd:
        this.amendmentPredecessorEnd?.toISOString() ?? null,
    });
  }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export default Agreement;
