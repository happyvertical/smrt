/** Immutable period performance evidence for a campaign or campaign channel. */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { CampaignMetricSnapshotOptions } from '../types.js';
import { Campaign } from './Campaign.js';
import { CampaignChannel } from './CampaignChannel.js';

const persistedSnapshotState = new WeakMap<CampaignMetricSnapshot, string>();

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'campaign_metric_snapshots',
  // The ingest API takes an opaque caller key, so it is unique per tenant
  // (#3305 M2): two tenants may file the same key; global (NULL-tenant)
  // evidence stays unique through the null-aware upsert, and in the database
  // through NULLS NOT DISTINCT on PostgreSQL 15+.
  conflictColumns: ['tenant_id', 'dedupe_key'],
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { include: ['list', 'get', 'create'] },
})
export class CampaignMetricSnapshot extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ description: 'The campaign these results belong to.' })
  @foreignKey(Campaign, { required: true })
  campaignId: string = '';

  /** Null for campaign rollups; set for channel-scoped evidence. */
  @field({
    description:
      'The channel these results came from. Empty when they cover the whole campaign.',
  })
  @foreignKey(CampaignChannel, { nullable: true })
  campaignChannelId: string | null = null;

  @field({
    required: true,
    description: 'The first day of the period these results cover.',
  })
  periodStart: Date = new Date();

  @field({
    required: true,
    description: 'The last day of the period these results cover.',
  })
  periodEnd: Date = new Date();

  @field({ description: 'What was spent in the period, in cents.' })
  spendCents: number = 0;

  @field({ description: 'How many times the campaign was shown.' })
  impressions: number = 0;

  @field({ description: 'How many times someone clicked through.' })
  clicks: number = 0;

  @field({
    description: 'How many people did what the campaign asked, such as buying.',
  })
  conversions: number = 0;

  @field({ description: 'How many new leads came in.' })
  leads: number = 0;

  @field({
    type: 'integer',
    nullable: true,
    description: 'The sales brought in during the period, in cents, if known.',
  })
  revenueCents: number | null = null;

  /** Ingestion source such as `google_ads`, `meta`, or `rollup_job`. */
  @field({
    required: true,
    description: 'Where these results were reported from.',
  })
  source: string = '';

  @field({
    required: true,
    description:
      'The reference this result is filed under, so the same report is never counted twice.',
  })
  dedupeKey: string = '';

  constructor(options: CampaignMetricSnapshotOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.campaignId !== undefined) this.campaignId = options.campaignId;
    if (options.campaignChannelId !== undefined)
      this.campaignChannelId = options.campaignChannelId;
    if (options.periodStart !== undefined)
      this.periodStart =
        CampaignMetricSnapshot.coerceDate(options.periodStart) ??
        new Date(Number.NaN);
    if (options.periodEnd !== undefined)
      this.periodEnd =
        CampaignMetricSnapshot.coerceDate(options.periodEnd) ??
        new Date(Number.NaN);
    if (options.spendCents !== undefined) this.spendCents = options.spendCents;
    if (options.impressions !== undefined)
      this.impressions = options.impressions;
    if (options.clicks !== undefined) this.clicks = options.clicks;
    if (options.conversions !== undefined)
      this.conversions = options.conversions;
    if (options.leads !== undefined) this.leads = options.leads;
    if (options.revenueCents !== undefined)
      this.revenueCents = options.revenueCents;
    if (options.source !== undefined) this.source = options.source;
    if (options.dedupeKey !== undefined) this.dedupeKey = options.dedupeKey;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.periodStart =
      CampaignMetricSnapshot.coerceDate(this.periodStart) ??
      new Date(Number.NaN);
    this.periodEnd =
      CampaignMetricSnapshot.coerceDate(this.periodEnd) ?? new Date(Number.NaN);
    if (this.isPersisted) {
      persistedSnapshotState.set(this, this.serializeState());
    }
    return this;
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    this.assertMetrics();
    await this.assertChannelMatchesCampaign();
    const captured = persistedSnapshotState.get(this);
    if (captured !== undefined) {
      if (captured !== this.serializeState()) {
        throw new Error(
          `CampaignMetricSnapshot ${this.id ?? '<new>'}: metric snapshots ` +
            'are immutable evidence; ingest a correcting snapshot instead.',
        );
      }
    } else if (this.id && (await this.isSaved())) {
      throw new Error(
        `CampaignMetricSnapshot ${this.id}: refusing to overwrite an existing ` +
          'snapshot from a non-hydrated instance; snapshots are immutable evidence.',
      );
    } else if (this.dedupeKey) {
      try {
        // The key is tenant-local: guard the owner's key, which is this
        // row's tenant or, before the interceptor fills it in, the context's.
        // A system context with no tenant guards the global key.
        const row = await this.db.get(this.tableName, {
          tenant_id: this.tenantId || getCurrentTenant()?.tenantId || null,
          dedupe_key: this.dedupeKey,
        });
        if (row && row.id !== this.id) {
          throw new Error(
            `CampaignMetricSnapshot (dedupeKey '${this.dedupeKey}'): a ` +
              'snapshot with this dedupe key already exists; use ' +
              'MetricIngestionService for idempotent ingestion.',
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('idempotent ingestion')
        ) {
          throw error;
        }
        // DB not ready / table absent; there is no persisted row to protect.
      }
    }

    const result = (await super.save(options)) as this;
    persistedSnapshotState.set(this, this.serializeState());
    return result;
  }

  override async delete(): Promise<void> {
    throw new Error(
      `CampaignMetricSnapshot ${this.id ?? '<new>'}: metric snapshots are ` +
        'immutable evidence and cannot be deleted.',
    );
  }

  private assertMetrics(): void {
    if (
      Number.isNaN(this.periodStart.getTime()) ||
      Number.isNaN(this.periodEnd.getTime())
    ) {
      throw new Error(
        'CampaignMetricSnapshot periodStart and periodEnd must be valid dates.',
      );
    }
    if (this.periodEnd.getTime() < this.periodStart.getTime()) {
      throw new Error(
        'CampaignMetricSnapshot periodEnd must be on or after periodStart.',
      );
    }
    const integerMetrics: Array<[string, number]> = [
      ['spendCents', this.spendCents],
      ['impressions', this.impressions],
      ['clicks', this.clicks],
      ['conversions', this.conversions],
      ['leads', this.leads],
    ];
    for (const [name, value] of integerMetrics) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
      }
    }
    if (
      this.revenueCents !== null &&
      (!Number.isInteger(this.revenueCents) || this.revenueCents < 0)
    ) {
      throw new Error('revenueCents must be null or a non-negative integer.');
    }
  }

  private async assertChannelMatchesCampaign(): Promise<void> {
    if (!this.campaignChannelId) return;
    const channel = (await this.loadRelated(
      'campaignChannelId',
    )) as CampaignChannel;
    if (channel.campaignId !== this.campaignId) {
      throw new Error(
        `CampaignMetricSnapshot campaignChannelId '${this.campaignChannelId}' ` +
          `does not belong to campaignId '${this.campaignId}'.`,
      );
    }
  }

  private serializeState(): string {
    return JSON.stringify({
      tenantId: this.tenantId,
      campaignId: this.campaignId,
      campaignChannelId: this.campaignChannelId,
      periodStart: this.periodStart.toISOString(),
      periodEnd: this.periodEnd.toISOString(),
      spendCents: this.spendCents,
      impressions: this.impressions,
      clicks: this.clicks,
      conversions: this.conversions,
      leads: this.leads,
      revenueCents: this.revenueCents,
      source: this.source,
      dedupeKey: this.dedupeKey,
    });
  }

  private static coerceDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'number' || typeof value === 'string') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }
}

export default CampaignMetricSnapshot;
