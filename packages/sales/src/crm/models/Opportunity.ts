/**
 * Opportunity — a qualified engagement moving through a pipeline.
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { OpportunityOptions, OpportunityStatus } from '../types.js';

/**
 * Legal status transitions for an Opportunity, keyed by the prior persisted
 * status. A status re-saved unchanged (no-op) and a brand-new row are always
 * permitted; this map governs *changes* only.
 *
 * Flow: `open → won|lost`; `won` and `lost` are terminal. Guards against raw
 * mass-assignment re-opening a closed deal (commerce Contract pattern).
 */
const OPPORTUNITY_STATUS_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  open: ['won', 'lost'],
  won: [],
  lost: [],
};

/**
 * Module-scoped record of the status each Opportunity instance was loaded
 * with, for the save-time transition guard. WeakMap keeps it out of the
 * schema and GCs with the instance.
 */
const loadedOpportunityStatus = new WeakMap<Opportunity, OpportunityStatus>();

/**
 * Opportunity is a qualified engagement: a deal with an expected value moving
 * through the stages of a PipelineDefinition.
 *
 * Money is integer cents (`expectedValueCents`, INTEGER) with an ISO 4217
 * `currency`; `probability` is a decimal in `0`–`1` (DECIMAL). Stage
 * movement goes through `OpportunityCollection.moveToStage()`, which
 * validates the stage belongs to the opportunity's pipeline, adopts the
 * stage's probability, closes the deal on terminal stages, and writes a
 * `stage_change` SalesActivity. `sourceKind`/`sourceId` are copied from the
 * originating Lead at qualification time so reporting can attribute won
 * revenue without joining back through leads.
 *
 * @example
 * ```typescript
 * const opportunities = await OpportunityCollection.create({ db });
 * const moved = await opportunities.moveToStage({
 *   opportunityId: opportunity.id ?? '',
 *   stageId: proposalStage.id ?? '',
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Opportunity extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global opportunities.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Deal name shown on boards and lists. Required. */
  @field({ required: true })
  name: string = '';

  /** Originating lead (empty for opportunities created directly). */
  @foreignKey('Lead')
  leadId: string = '';

  /** Owning sales rep. */
  @foreignKey('SalesRepresentative')
  ownerRepId: string = '';

  /** Pipeline the deal moves through. */
  @foreignKey('PipelineDefinition')
  pipelineId: string = '';

  /** Current stage within the pipeline. */
  @foreignKey('PipelineStage')
  stageId: string = '';

  /** Expected deal value in integer cents (INTEGER column). */
  expectedValueCents: number = 0;

  /** ISO 4217 currency code for `expectedValueCents`. */
  currency: string = 'USD';

  /**
   * Win probability (`0`–`1`, DECIMAL). Adopted from the current stage's
   * default on stage moves unless explicitly overridden.
   */
  probability: number = 0.0;

  /** Forecasted close date. */
  expectedCloseAt: Date | null = null;

  /** Lifecycle status; `open → won|lost` is save-guarded, terminal after. */
  status: OpportunityStatus = 'open';

  /**
   * Human-readable outcome note — conventionally the loss reason
   * (`'budget cut'`) or a win annotation.
   */
  outcomeReason: string = '';

  /** When the deal closed as won. */
  wonAt: Date | null = null;

  /** When the deal closed as lost. */
  lostAt: Date | null = null;

  /**
   * Acquisition source copied from the originating lead at qualification
   * time (open string), kept denormalized for reporting.
   */
  sourceKind: string = '';

  /** Identifier within the `sourceKind` namespace (copied from the lead). */
  sourceId: string = '';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: OpportunityOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.leadId !== undefined) this.leadId = options.leadId;
    if (options.ownerRepId !== undefined) this.ownerRepId = options.ownerRepId;
    if (options.pipelineId !== undefined) this.pipelineId = options.pipelineId;
    if (options.stageId !== undefined) this.stageId = options.stageId;
    if (options.expectedValueCents !== undefined)
      this.expectedValueCents = options.expectedValueCents;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.probability !== undefined)
      this.probability = options.probability;
    if (options.expectedCloseAt !== undefined)
      this.expectedCloseAt = options.expectedCloseAt;
    if (options.status !== undefined) this.status = options.status;
    if (options.outcomeReason !== undefined)
      this.outcomeReason = options.outcomeReason;
    if (options.wonAt !== undefined) this.wonAt = options.wonAt;
    if (options.lostAt !== undefined) this.lostAt = options.lostAt;
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether the deal is still in play. */
  isOpen(): boolean {
    return this.status === 'open';
  }

  /** Whether the deal closed (won or lost). */
  isClosed(): boolean {
    return this.status !== 'open';
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
   * Capture the status the row was loaded with so the save-time transition
   * guard can reject illegal status flips made via raw field assignment.
   * Only persisted rows carry a prior status.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedOpportunityStatus.set(this, this.status);
    }
    return this;
  }

  /**
   * Validate the status transition before persisting, then save. A forged
   * `status` (e.g. re-opening a lost deal) is rejected here regardless of
   * how the instance was constructed.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertOpportunityStatusTransition(prior);
    const result = (await super.save()) as this;
    loadedOpportunityStatus.set(this, this.status);
    return result;
  }

  /**
   * Reject an illegal status flip done via raw assignment. No-op transitions
   * and brand-new rows are always allowed.
   */
  protected assertOpportunityStatusTransition(
    prior: OpportunityStatus | undefined,
  ): void {
    if (prior === undefined) return; // new row — any starting status is fine
    if (prior === this.status) return; // no-op re-save
    const allowed = OPPORTUNITY_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Opportunity ${this.name || this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
      );
    }
  }

  /**
   * Resolve the AUTHORITATIVE prior status (commerce Contract pattern): when
   * this instance carries an `id`, re-read the persisted row and use its
   * `status` as the prior — a create-onto-existing is an update, and an
   * un-hydrated instance must not bypass the guard. Falls back to the
   * load-time WeakMap (empty for truly new rows → `undefined` = new).
   */
  protected async resolvePriorStatus(): Promise<OpportunityStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as OpportunityStatus;
        }
      } catch {
        // DB not ready / table absent — fall through to the in-memory record.
      }
    }
    return loadedOpportunityStatus.get(this);
  }
}

export default Opportunity;
