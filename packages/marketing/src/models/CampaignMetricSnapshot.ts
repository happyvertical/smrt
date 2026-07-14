/** Immutable period performance evidence for a campaign or campaign channel. */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { CampaignMetricSnapshotOptions } from '../types.js';
import { Campaign } from './Campaign.js';
import { CampaignChannel } from './CampaignChannel.js';

const persistedSnapshotState = new WeakMap<CampaignMetricSnapshot, string>();

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'campaign_metric_snapshots',
  conflictColumns: ['dedupe_key'],
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { include: ['list', 'get', 'create'] },
})
export class CampaignMetricSnapshot extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey(Campaign, { required: true })
  campaignId: string = '';

  /** Null for campaign rollups; set for channel-scoped evidence. */
  @foreignKey(CampaignChannel, { nullable: true })
  campaignChannelId: string | null = null;

  @field({ required: true })
  periodStart: Date = new Date();

  @field({ required: true })
  periodEnd: Date = new Date();

  spendCents: number = 0;

  impressions: number = 0;

  clicks: number = 0;

  conversions: number = 0;

  leads: number = 0;

  @field({ type: 'integer', nullable: true })
  revenueCents: number | null = null;

  /** Ingestion source such as `google_ads`, `meta`, or `rollup_job`. */
  @field({ required: true })
  source: string = '';

  @field({ required: true })
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

  override async save(): Promise<this> {
    this.assertMetrics();
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
        const row = await this.db.get(this.tableName, {
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

    const result = (await super.save()) as this;
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
