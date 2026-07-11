/**
 * EarningEvent — immutable commercial-event evidence.
 *
 * An EarningEvent records that something commission-worthy happened: a
 * conversion, an agreement execution, an invoice payment, collected revenue,
 * recognized margin, a milestone — or any application-defined kind
 * (`eventKind` is an open string; see `EARNING_EVENT_KINDS` for the
 * recommended vocabulary). The source is a generic `(sourceKind, sourceId)`
 * string pair — this module never assumes advertising, Referral, Lead, or
 * Opportunity semantics.
 *
 * Immutability contract: events are evidence. The generated surface exposes
 * `create`/`list`/`get` only (no update, no delete), and application code
 * must treat persisted rows as append-only — commissions reference an
 * event's amounts in their calculation traces, so rewriting an event would
 * silently orphan the audit trail. Corrections are modelled as NEW events
 * (e.g. a `refund`-kind event) or as `CommissionAdjustment` rows.
 *
 * Idempotent ingestion: `dedupeKey` is the natural key
 * (`conflictColumns: ['dedupe_key']`). Callers embed tenant and source
 * identity in the key — e.g.
 * `` `${tenantId}:${sourceKind}:${sourceId}:${eventKind}:${occurrence}` `` —
 * so a retried ingest resolves to the existing row (see
 * `EarningEventCollection.getOrCreateByDedupeKey`).
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { EarningEventOptions } from '../types.js';

/**
 * Serialized state of each persisted instance, for the save-time
 * immutability guard (WeakMap keeps it out of the schema and GCs with the
 * instance — the ReferralTermSnapshot pattern).
 */
const persistedEventState = new WeakMap<EarningEvent, string>();

@TenantScoped({ mode: 'optional' })
@smrt({
  // Natural key for idempotent ingestion — a retried create with the same
  // dedupeKey upserts instead of duplicating.
  conflictColumns: ['dedupe_key'],
  // Immutable evidence: create/list/get only — no update or delete on any
  // generated surface.
  api: { include: ['create', 'list', 'get'] },
  mcp: { include: ['list', 'create'] },
  // High-volume evidence rows are not useful from the CLI.
  cli: false,
})
export class EarningEvent extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global events). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * What kind of commercial event this is. Open string — see
   * `EARNING_EVENT_KINDS` for the recommended vocabulary. Plan components
   * match on this via their `trigger`.
   */
  @field({ required: true })
  eventKind: string = '';

  /** When the commercial event occurred (not when it was ingested). */
  occurredAt: Date = new Date();

  /**
   * Generic earning-source discriminator (`referral`, `opportunity`,
   * `subscription`, `ad_event`, …). Free-form; this module attaches no
   * semantics to it.
   */
  sourceKind: string = '';

  /** Id of the source record named by {@link sourceKind}. */
  sourceId: string = '';

  /** Gross amount of the event in integer cents. */
  grossAmountCents: number = 0;

  /**
   * Net amount in integer cents, when the ingesting system defines one.
   * `null` means "net is not defined for this event" — `net`-basis
   * components then SKIP rather than falling back to gross (net is never
   * derived).
   */
  @field({ type: 'integer', nullable: true })
  netAmountCents: number | null = null;

  /**
   * Recognized margin in integer cents, when defined. `null` skips
   * `margin`-basis components — margin is never derived.
   */
  @field({ type: 'integer', nullable: true })
  marginCents: number | null = null;

  /** ISO 4217 currency of the event's amounts. */
  currency: string = 'USD';

  /**
   * JSON map of `basisKey → integer cents` for `custom`-basis plan
   * components. Use {@link getCustomBases}/{@link setCustomBases}.
   */
  customBases: string = '{}';

  /**
   * Idempotency natural key. Required. Callers embed tenant/source identity
   * (see the class doc) — the framework does not synthesize it.
   */
  @field({ required: true })
  dedupeKey: string = '';

  /** Additional metadata as a JSON string. */
  metadata: string = '{}';

  constructor(options: EarningEventOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.eventKind !== undefined) this.eventKind = options.eventKind;
    if (options.occurredAt !== undefined)
      this.occurredAt =
        EarningEvent.coerceDate(options.occurredAt) ?? new Date();
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.grossAmountCents !== undefined)
      this.grossAmountCents = options.grossAmountCents;
    if (options.netAmountCents !== undefined)
      this.netAmountCents = options.netAmountCents;
    if (options.marginCents !== undefined)
      this.marginCents = options.marginCents;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.customBases !== undefined)
      this.customBases = options.customBases;
    if (options.dedupeKey !== undefined) this.dedupeKey = options.dedupeKey;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce {@link occurredAt} after the framework reapplies raw option /
   * hydrated row values (SQLite hands back ISO strings), and capture the
   * persisted state for the immutability guard when this instance hydrated
   * an existing row.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.occurredAt = EarningEvent.coerceDate(this.occurredAt) ?? new Date();
    if (await this.isSaved()) {
      persistedEventState.set(this, this.serializeState());
    }
    return this;
  }

  /**
   * Save with the evidence-immutability guard. EarningEvents are immutable
   * commercial evidence; three write vectors are closed:
   *
   * - a HYDRATED persisted row must serialize identically to its captured
   *   state (no-op re-saves pass, any change throws);
   * - an instance carrying an existing id WITHOUT having hydrated it
   *   (`create({ id, _skipLoad: true })`) is rejected outright;
   * - a NEW instance whose `dedupeKey` already belongs to another row is
   *   refused outright: the natural-key upsert would not only rewrite the
   *   evidence values but ROTATE the row's id (orphaning any Commission
   *   whose `earningEventId` points at it). Idempotent ingestion goes
   *   through `EarningEventCollection.getOrCreateByDedupeKey()`, which
   *   finds first and never upserts.
   */
  override async save(): Promise<this> {
    const captured = persistedEventState.get(this);
    if (captured !== undefined) {
      if (captured !== this.serializeState()) {
        throw new Error(
          `EarningEvent ${this.id ?? '<new>'}: earning events are immutable ` +
            'evidence — record a correcting event (or a CommissionAdjustment ' +
            'downstream) instead of editing this row.',
        );
      }
    } else if (this.id && (await this.isSaved())) {
      throw new Error(
        `EarningEvent ${this.id}: refusing to overwrite an existing event ` +
          'row from a non-hydrated instance — earning events are immutable ' +
          'evidence.',
      );
    } else if (this.dedupeKey) {
      // Fresh instance (create() pre-assigns an id, so key off "no captured
      // state and not a persisted id" rather than a missing id): its
      // natural key may collide with existing evidence via the upsert.
      try {
        const row = await this.db.get(this.tableName, {
          dedupe_key: this.dedupeKey,
        });
        if (row && row.id !== this.id) {
          throw new Error(
            `EarningEvent (dedupeKey '${this.dedupeKey}'): an event with ` +
              'this dedupe key already exists — earning events are ' +
              'immutable evidence, and the natural-key upsert would rotate ' +
              "the existing row's id (orphaning commissions that reference " +
              'it). Use EarningEventCollection.getOrCreateByDedupeKey() ' +
              'for idempotent ingestion, or record a new event under its ' +
              'own dedupe key.',
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('immutable evidence')
        ) {
          throw error;
        }
        // DB not ready / table absent — nothing persisted to protect yet.
      }
    }
    const result = (await super.save()) as this;
    persistedEventState.set(this, this.serializeState());
    return result;
  }

  private serializeState(): string {
    // Stable key ordering so a no-op re-serialization matches.
    return JSON.stringify({
      tenantId: this.tenantId,
      eventKind: this.eventKind,
      occurredAt: this.occurredAt.toISOString(),
      sourceKind: this.sourceKind,
      sourceId: this.sourceId,
      grossAmountCents: this.grossAmountCents,
      netAmountCents: this.netAmountCents,
      marginCents: this.marginCents,
      currency: this.currency,
      customBases: this.customBases,
      dedupeKey: this.dedupeKey,
      metadata: this.metadata,
    });
  }

  /**
   * Parse {@link customBases} into a `basisKey → cents` map; non-numeric
   * values are dropped. Returns `{}` on empty/invalid JSON.
   */
  getCustomBases(): Record<string, number> {
    if (!this.customBases) return {};
    try {
      const parsed = JSON.parse(this.customBases) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          out[key] = value;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Serialize and store {@link customBases}. */
  setCustomBases(bases: Record<string, number>): void {
    this.customBases = JSON.stringify(bases ?? {});
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

  private static coerceDate(value: unknown): Date | null {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number' || typeof value === 'string') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
}

export default EarningEvent;
