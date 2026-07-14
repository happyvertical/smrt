/** Campaign identity, budget, schedule, and guarded lifecycle. */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  CAMPAIGN_STATUSES,
  type CampaignOptions,
  type CampaignStatus,
} from '../types.js';

const CAMPAIGN_STATUS_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['scheduled'],
  scheduled: ['active'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: ['archived'],
  archived: [],
};

const loadedCampaignStatus = new WeakMap<Campaign, CampaignStatus>();

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'campaigns',
  conflictColumns: ['tenant_id', 'campaign_key'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: { include: ['list', 'get', 'create', 'update'] },
})
export class Campaign extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Stable caller-defined key used by CRM/referral systems. */
  @field({ required: true })
  campaignKey: string = '';

  @field({ required: true })
  name: string = '';

  /** Open objective key such as `awareness` or `demand_generation`. */
  objective: string = '';

  status: CampaignStatus = 'draft';

  startAt: Date | null = null;

  endAt: Date | null = null;

  /** Total campaign budget in integer cents. */
  budgetCents: number = 0;

  /** ISO 4217 currency for every campaign/channel amount. */
  currency: string = 'USD';

  metadata: string = '{}';

  constructor(options: CampaignOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.campaignKey !== undefined)
      this.campaignKey = options.campaignKey;
    if (options.name !== undefined) this.name = options.name;
    if (options.objective !== undefined) this.objective = options.objective;
    if (options.status !== undefined) this.status = options.status;
    if (options.startAt !== undefined)
      this.startAt = Campaign.coerceDate(options.startAt);
    if (options.endAt !== undefined)
      this.endAt = Campaign.coerceDate(options.endAt);
    if (options.budgetCents !== undefined)
      this.budgetCents = options.budgetCents;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.startAt = Campaign.coerceDate(this.startAt);
    this.endAt = Campaign.coerceDate(this.endAt);
    if (await this.isSaved()) {
      loadedCampaignStatus.set(this, this.status);
    }
    return this;
  }

  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    this.assertSchedule();
    const result = (await super.save()) as this;
    loadedCampaignStatus.set(this, this.status);
    return result;
  }

  /** Apply one legal transition in memory; callers choose the save boundary. */
  transitionTo(next: CampaignStatus): this {
    if (next === this.status) return this;
    const allowed = CAMPAIGN_STATUS_TRANSITIONS[this.status] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(
        `Campaign ${this.campaignKey || this.id}: cannot transition ` +
          `'${this.status}' → '${next}'.`,
      );
    }
    this.status = next;
    return this;
  }

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

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata ?? {});
  }

  private assertSchedule(): void {
    if (
      this.startAt &&
      this.endAt &&
      this.endAt.getTime() < this.startAt.getTime()
    ) {
      throw new Error('Campaign endAt must be on or after startAt.');
    }
    if (!Number.isInteger(this.budgetCents) || this.budgetCents < 0) {
      throw new Error('Campaign budgetCents must be a non-negative integer.');
    }
  }

  private async resolvePriorStatus(): Promise<CampaignStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) return row.status as CampaignStatus;
      } catch {
        // DB not ready / table absent; fall through to the hydrated state.
      }
    }
    return loadedCampaignStatus.get(this);
  }

  private assertStatusTransition(prior: CampaignStatus | undefined): void {
    if (!CAMPAIGN_STATUSES.includes(this.status)) {
      throw new Error(
        `Campaign ${this.campaignKey || this.id}: unknown status '${this.status}'.`,
      );
    }
    if (prior === undefined || prior === this.status) return;
    const allowed = CAMPAIGN_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Campaign ${this.campaignKey || this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
      );
    }
  }

  private static coerceDate(value: unknown): Date | null {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number' || typeof value === 'string') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }
}

export default Campaign;
