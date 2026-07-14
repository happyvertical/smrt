/** Generic links from a campaign to cross-package channel execution rows. */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  CampaignChannelOptions,
  CampaignChannelStatus,
} from '../types.js';
import { CAMPAIGN_CHANNEL_STATUSES } from '../types.js';
import { Campaign } from './Campaign.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'campaign_channels',
  conflictColumns: ['campaign_id', 'channel_kind', 'channel_ref'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
export class CampaignChannel extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey(Campaign, { required: true })
  campaignId: string = '';

  /** Open kind vocabulary; recommended values live in CAMPAIGN_CHANNEL_KINDS. */
  @field({ required: true })
  channelKind: string = '';

  /** Opaque identifier in the namespace named by channelKind. */
  @field({ required: true })
  channelRef: string = '';

  allocatedBudgetCents: number = 0;

  /** Optional execution-specific override of the Campaign start. */
  startAt: Date | null = null;

  /** Optional execution-specific override of the Campaign end. */
  endAt: Date | null = null;

  status: CampaignChannelStatus = 'planned';

  constructor(options: CampaignChannelOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.campaignId !== undefined) this.campaignId = options.campaignId;
    if (options.channelKind !== undefined)
      this.channelKind = options.channelKind;
    if (options.channelRef !== undefined) this.channelRef = options.channelRef;
    if (options.allocatedBudgetCents !== undefined)
      this.allocatedBudgetCents = options.allocatedBudgetCents;
    if (options.startAt !== undefined)
      this.startAt = CampaignChannel.coerceDate(options.startAt);
    if (options.endAt !== undefined)
      this.endAt = CampaignChannel.coerceDate(options.endAt);
    if (options.status !== undefined) this.status = options.status;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.startAt = CampaignChannel.coerceDate(this.startAt);
    this.endAt = CampaignChannel.coerceDate(this.endAt);
    return this;
  }

  override async save(): Promise<this> {
    if (!CAMPAIGN_CHANNEL_STATUSES.includes(this.status)) {
      throw new Error(
        `CampaignChannel ${this.channelRef || this.id}: unknown status '${this.status}'.`,
      );
    }
    if (
      !Number.isInteger(this.allocatedBudgetCents) ||
      this.allocatedBudgetCents < 0
    ) {
      throw new Error(
        'CampaignChannel allocatedBudgetCents must be a non-negative integer.',
      );
    }
    if (
      this.startAt &&
      this.endAt &&
      this.endAt.getTime() < this.startAt.getTime()
    ) {
      throw new Error('CampaignChannel endAt must be on or after startAt.');
    }
    return (await super.save()) as this;
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

export default CampaignChannel;
