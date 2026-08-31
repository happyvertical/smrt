import {
  type CollectionCacheConfig,
  resolveListLimit,
  SmrtCollection,
  type SmrtListOptions,
  type SmrtSelectedRow,
  type SmrtSelectField,
  type SmrtWhereClause,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  assertCustomersBelongToTenant,
  normalizeUuid,
} from '../customer-scope.js';
import { Campaign } from '../models/Campaign.js';
import { calculateCampaignPacing } from '../services/pacing-calculation.js';
import type {
  CampaignChannelMixEntry,
  CampaignCustomerCursor,
  CampaignCustomerCursorInput,
  CampaignCustomerPage,
  CampaignCustomerSummary,
  CampaignMetricTotals,
  CampaignReportingPage,
  CampaignStatus,
  ListCampaignReportingByCustomerOptions,
  ListCampaignsByCustomerOptions,
} from '../types.js';
import { CampaignChannelCollection } from './CampaignChannelCollection.js';
import { CampaignMetricSnapshotCollection } from './CampaignMetricSnapshotCollection.js';

export const MAX_CAMPAIGN_CUSTOMER_PAGE_SIZE = 100;
export const MAX_CAMPAIGN_CUSTOMER_BATCH_SIZE = 100;

export class CampaignCollection extends SmrtCollection<Campaign> {
  static readonly _itemClass = Campaign;

  override async get(
    filter: string | SmrtWhereClause<Campaign>,
    options: { cache?: CollectionCacheConfig | false } = {},
  ): Promise<Campaign | null> {
    return withCanonicalActiveTenant(() =>
      super.get(normalizeCampaignGetFilter(filter), options),
    );
  }

  override async list<
    const Select extends readonly SmrtSelectField<Campaign>[],
  >(
    options: SmrtListOptions<Campaign> & { select: Select; include?: never },
  ): Promise<SmrtSelectedRow<Campaign, Select>[]>;
  override async list(
    options?: Omit<SmrtListOptions<Campaign>, 'select'> & {
      select?: undefined;
    },
  ): Promise<Campaign[]>;
  override async list(
    options: SmrtListOptions<Campaign> = {},
  ): Promise<Campaign[] | Record<string, unknown>[]> {
    return withCanonicalActiveTenant(
      () =>
        super.list(normalizeCampaignListOptions(options) as never) as Promise<
          Campaign[] | Record<string, unknown>[]
        >,
    );
  }

  async findByCampaignKey(
    campaignKey: string,
    tenantId?: string | null,
  ): Promise<Campaign | null> {
    if (!campaignKey) return null;
    const where: Record<string, unknown> = { campaignKey };
    if (tenantId !== undefined) where.tenantId = tenantId;
    const rows = await this.list({ where, limit: 1 });
    return rows[0] ?? null;
  }

  async findByStatus(status: CampaignStatus): Promise<Campaign[]> {
    return await this.list({
      where: { status },
      orderBy: 'start_at ASC',
    });
  }

  /**
   * List one tenant/customer lane newest-first using a stable UUID tiebreaker.
   * Null start times follow all scheduled rows on every supported database.
   */
  async listByCustomer(
    tenantId: string | null,
    customerId: string,
    options: ListCampaignsByCustomerOptions = {},
  ): Promise<CampaignCustomerPage> {
    const normalizedTenantId = normalizeTenantScope(
      tenantId,
      'CampaignCollection.listByCustomer',
    );
    const normalizedCustomerId = normalizeUuid(customerId, 'customerId');
    const limit = resolveListLimit(options.limit, {
      defaultValue: 50,
      maxValue: Number.MAX_SAFE_INTEGER,
      parameterName: 'campaign customer page limit',
    });
    if (limit > MAX_CAMPAIGN_CUSTOMER_PAGE_SIZE) {
      throw new Error(
        `Campaign customer page limit must not exceed ${MAX_CAMPAIGN_CUSTOMER_PAGE_SIZE}.`,
      );
    }
    if (limit < 1) {
      throw new Error('Campaign customer page limit must be at least 1.');
    }
    const cursor = normalizeCursor(options.after);
    return withCanonicalTenantContext(normalizedTenantId, () =>
      this.inCustomerReadTransaction(async (bound) =>
        bound.listByCustomerInTransaction(
          normalizedTenantId,
          normalizedCustomerId,
          limit,
          cursor,
          'CampaignCollection.listByCustomer',
        ),
      ),
    );
  }

  /**
   * Return one bounded customer page with its complete read-only reporting
   * projection. Channels and immutable evidence are aggregated in two grouped
   * reads, independent of page size; no campaign callback or lazy load runs.
   */
  async listReportingByCustomer(
    tenantId: string | null,
    customerId: string,
    options: ListCampaignReportingByCustomerOptions = {},
  ): Promise<CampaignReportingPage> {
    const normalizedTenantId = normalizeTenantScope(
      tenantId,
      'CampaignCollection.listReportingByCustomer',
    );
    const normalizedCustomerId = normalizeUuid(customerId, 'customerId');
    const limit = resolveListLimit(options.limit, {
      defaultValue: 50,
      maxValue: Number.MAX_SAFE_INTEGER,
      parameterName: 'campaign reporting page limit',
    });
    if (limit > MAX_CAMPAIGN_CUSTOMER_PAGE_SIZE) {
      throw new Error(
        `Campaign reporting page limit must not exceed ${MAX_CAMPAIGN_CUSTOMER_PAGE_SIZE}.`,
      );
    }
    if (limit < 1) {
      throw new Error('Campaign reporting page limit must be at least 1.');
    }
    const cursor = normalizeCursor(options.after);
    const at = normalizeReportingAt(options.at);

    return withCanonicalTenantContext(normalizedTenantId, () =>
      this.inCustomerReadTransaction(async (bound) => {
        const page = await bound.listByCustomerInTransaction(
          normalizedTenantId,
          normalizedCustomerId,
          limit,
          cursor,
          'CampaignCollection.listReportingByCustomer',
        );
        return bound.projectReportingPage(normalizedTenantId, page, at);
      }),
    );
  }

  private async projectReportingPage(
    tenantId: string | null,
    page: CampaignCustomerPage,
    at: Date,
  ): Promise<CampaignReportingPage> {
    const campaignIds = page.items.map((campaign) => {
      if (!campaign.id) {
        throw new Error('Campaign reporting requires persisted Campaign rows.');
      }
      return normalizeUuid(campaign.id, 'campaign id');
    });
    if (campaignIds.length === 0) {
      return { items: [], nextCursor: page.nextCursor };
    }

    const channelRows = await this.loadChannelMixRows(tenantId, campaignIds);
    const metricRows = await this.loadMetricRows(tenantId, campaignIds);
    const channelsByCampaign = groupChannelMix(channelRows);
    const metricsByCampaign = groupMetricTotals(metricRows);

    return {
      items: page.items.map((campaign) => {
        const campaignId = campaign.id ?? '';
        const channelMix = channelsByCampaign.get(campaignId) ?? [];
        const metrics =
          metricsByCampaign.get(campaignId) ?? emptyMetricTotals();
        return {
          campaign,
          channelCount: channelMix.reduce(
            (sum, entry) =>
              checkedAdd(sum, entry.count, 'Campaign channel count'),
            0,
          ),
          channelMix,
          metricTotals: metrics.totals,
          pacing: calculateCampaignPacing(
            campaign,
            {
              spendCents: metrics.totals.spendCents,
              snapshotCount: metrics.snapshotCount,
              usedCampaignRollups: metrics.usedCampaignRollups,
            },
            at,
          ),
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  private async loadChannelMixRows(
    tenantId: string | null,
    campaignIds: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const channels = await CampaignChannelCollection.create({
      ...this.options,
      db: this.db,
      defaultListLimit: undefined,
      maxListLimit: undefined,
    });
    const db = requireDatabase(this.options);
    const placeholders = campaignIds.map(() => '?').join(', ');
    const tenantPredicate =
      tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
    const tenantParams = tenantId === null ? [] : [tenantId];
    const result = await db.query(
      `SELECT campaign_id, channel_kind, COUNT(*) AS channel_count
       FROM ${channels.tableName}
       WHERE ${tenantPredicate} AND campaign_id IN (${placeholders})
       GROUP BY campaign_id, channel_kind
       ORDER BY campaign_id ASC, channel_kind ASC`,
      ...tenantParams,
      ...campaignIds,
    );
    return result.rows;
  }

  private async loadMetricRows(
    tenantId: string | null,
    campaignIds: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const snapshots = await CampaignMetricSnapshotCollection.create({
      ...this.options,
      db: this.db,
      defaultListLimit: undefined,
      maxListLimit: undefined,
    });
    const db = requireDatabase(this.options);
    const placeholders = campaignIds.map(() => '?').join(', ');
    const tenantPredicate =
      tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
    const tenantParams = tenantId === null ? [] : [tenantId];
    const result = await db.query(
      `WITH scoped_snapshots AS (
         SELECT campaign_id,
                campaign_channel_id,
                period_start,
                period_end,
                spend_cents,
                impressions,
                clicks,
                conversions,
                leads,
                revenue_cents
         FROM ${snapshots.tableName}
         WHERE ${tenantPredicate} AND campaign_id IN (${placeholders})
       ), rollup_periods AS (
         SELECT DISTINCT campaign_id, period_start, period_end
         FROM scoped_snapshots
         WHERE campaign_channel_id IS NULL
       ), selected_snapshots AS (
         SELECT s.*
         FROM scoped_snapshots s
         LEFT JOIN rollup_periods r
           ON r.campaign_id = s.campaign_id
          AND r.period_start = s.period_start
          AND r.period_end = s.period_end
         WHERE s.campaign_channel_id IS NULL OR r.campaign_id IS NULL
       )
       SELECT campaign_id,
              COUNT(*) AS snapshot_count,
              MAX(CASE WHEN campaign_channel_id IS NULL THEN 1 ELSE 0 END)
                AS used_campaign_rollups,
              SUM(spend_cents) AS spend_cents,
              SUM(impressions) AS impressions,
              SUM(clicks) AS clicks,
              SUM(conversions) AS conversions,
              SUM(leads) AS leads,
              SUM(COALESCE(revenue_cents, 0)) AS revenue_cents
       FROM selected_snapshots
       GROUP BY campaign_id
       ORDER BY campaign_id ASC`,
      ...tenantParams,
      ...campaignIds,
    );
    return result.rows;
  }

  private async listByCustomerInTransaction(
    tenantId: string | null,
    customerId: string,
    limit: number,
    cursor: CampaignCustomerCursor | null,
    operation: string,
  ): Promise<CampaignCustomerPage> {
    await assertCustomersBelongToTenant(
      this.options,
      tenantId,
      [customerId],
      operation,
      'share',
    );
    const items =
      cursor?.startAt === null
        ? await this.listNullStartLane(tenantId, customerId, limit + 1, cursor)
        : await this.listScheduledLane(tenantId, customerId, limit, cursor);
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    return {
      items: pageItems,
      nextCursor: hasMore
        ? cursorFromCampaign(pageItems[pageItems.length - 1])
        : null,
    };
  }

  /**
   * Summarize a bounded customer batch with one scope check and one grouped
   * aggregate query. Every requested customer receives a row, including zeros.
   */
  async summarizeByCustomers(
    tenantId: string | null,
    customerIds: string[],
  ): Promise<CampaignCustomerSummary[]> {
    const normalizedTenantId = normalizeTenantScope(
      tenantId,
      'CampaignCollection.summarizeByCustomers',
    );
    if (!Array.isArray(customerIds)) {
      throw new Error(
        'Campaign customer summary customerIds must be an array.',
      );
    }
    if (customerIds.length > MAX_CAMPAIGN_CUSTOMER_BATCH_SIZE) {
      throw new Error(
        `Campaign customer summary accepts at most ${MAX_CAMPAIGN_CUSTOMER_BATCH_SIZE} customerIds.`,
      );
    }
    const normalizedCustomerIds = customerIds.map((customerId) =>
      normalizeUuid(customerId, 'customerId'),
    );
    const uniqueIds = [...new Set(normalizedCustomerIds)];
    if (uniqueIds.length === 0) return [];

    return withCanonicalTenantContext(normalizedTenantId, () =>
      this.inCustomerReadTransaction(async (bound) =>
        bound.summarizeByCustomersInTransaction(
          normalizedTenantId,
          normalizedCustomerIds,
          uniqueIds,
        ),
      ),
    );
  }

  private async summarizeByCustomersInTransaction(
    tenantId: string | null,
    requestedCustomerIds: string[],
    uniqueIds: string[],
  ): Promise<CampaignCustomerSummary[]> {
    await assertCustomersBelongToTenant(
      this.options,
      tenantId,
      uniqueIds,
      'CampaignCollection.summarizeByCustomers',
      'share',
    );
    const db = requireDatabase(this.options);
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const tenantPredicate =
      tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
    const tenantParams = tenantId === null ? [] : [tenantId];
    const result = await db.query(
      `SELECT customer_id,
              COUNT(*) AS total_count,
              SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS active_count,
              MAX(start_at) AS latest_start_at
       FROM ${this.tableName}
       WHERE ${tenantPredicate} AND customer_id IN (${placeholders})
       GROUP BY customer_id
       ORDER BY customer_id ASC
       LIMIT ?`,
      'active',
      ...tenantParams,
      ...uniqueIds,
      uniqueIds.length,
    );
    const byCustomer = new Map(
      result.rows.map((row) => [String(row.customer_id).toLowerCase(), row]),
    );
    return requestedCustomerIds.map((customerId) => {
      const row = byCustomer.get(customerId);
      return {
        customerId,
        totalCount: row
          ? toSafeCount(row.total_count, 'Campaign customer total count')
          : 0,
        activeCount: row
          ? toSafeCount(row.active_count, 'Campaign customer active count')
          : 0,
        latestStartAt: row ? coerceDate(row.latest_start_at) : null,
      };
    });
  }

  private async inCustomerReadTransaction<T>(
    operation: (bound: CampaignCollection) => Promise<T>,
  ): Promise<T> {
    const db = this.db as DatabaseInterface;
    if (typeof db.transaction !== 'function') {
      throw new Error(
        'Campaign customer reads require a database adapter with transaction support.',
      );
    }
    return db.transaction(async (transactionDb) => {
      const bound = await CampaignCollection.create({
        ...this.options,
        db: transactionDb,
        defaultListLimit: undefined,
        maxListLimit: undefined,
      });
      return operation(bound);
    });
  }

  private async listScheduledLane(
    tenantId: string | null,
    customerId: string,
    limit: number,
    cursor: CampaignCustomerCursor | null,
  ): Promise<Campaign[]> {
    const base = [{ tenantId }, { customerId }, { 'startAt !=': null }];
    const where = cursor
      ? [
          [...base, { 'startAt <': cursor.startAt }],
          [...base, { startAt: cursor.startAt }, { 'id <': cursor.id }],
        ]
      : { tenantId, customerId, 'startAt !=': null };
    const scheduled = await this.list({
      where,
      orderBy: ['start_at DESC', 'id DESC'],
      limit: limit + 1,
    });
    if (scheduled.length > limit) return scheduled;
    const nullRows = await this.listNullStartLane(
      tenantId,
      customerId,
      limit - scheduled.length + 1,
      null,
    );
    return [...scheduled, ...nullRows];
  }

  private async listNullStartLane(
    tenantId: string | null,
    customerId: string,
    limit: number,
    cursor: CampaignCustomerCursor | null,
  ): Promise<Campaign[]> {
    return this.list({
      where: {
        tenantId,
        customerId,
        startAt: null,
        ...(cursor ? { 'id <': cursor.id } : {}),
      },
      orderBy: 'id DESC',
      limit,
    });
  }
}

interface QueryDatabase {
  query(
    sql: string,
    ...params: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface GroupedMetricTotals {
  totals: CampaignMetricTotals;
  snapshotCount: number;
  usedCampaignRollups: boolean;
}

function groupChannelMix(
  rows: Array<Record<string, unknown>>,
): Map<string, CampaignChannelMixEntry[]> {
  const grouped = new Map<string, CampaignChannelMixEntry[]>();
  for (const row of rows) {
    const campaignId = normalizeUuid(String(row.campaign_id), 'campaign id');
    const channelKind = String(row.channel_kind);
    if (!channelKind) throw new Error('Campaign channel kind is empty.');
    const entry = {
      channelKind,
      count: toSafeCount(row.channel_count, 'Campaign channel count'),
    };
    const entries = grouped.get(campaignId) ?? [];
    entries.push(entry);
    grouped.set(campaignId, entries);
  }
  return grouped;
}

function groupMetricTotals(
  rows: Array<Record<string, unknown>>,
): Map<string, GroupedMetricTotals> {
  return new Map(
    rows.map((row) => {
      const campaignId = normalizeUuid(String(row.campaign_id), 'campaign id');
      return [
        campaignId,
        {
          totals: {
            spendCents: toSafeCount(row.spend_cents, 'Campaign spend total'),
            impressions: toSafeCount(
              row.impressions,
              'Campaign impression total',
            ),
            clicks: toSafeCount(row.clicks, 'Campaign click total'),
            conversions: toSafeCount(
              row.conversions,
              'Campaign conversion total',
            ),
            leads: toSafeCount(row.leads, 'Campaign lead total'),
            revenueCents: toSafeCount(
              row.revenue_cents,
              'Campaign revenue total',
            ),
          },
          snapshotCount: toSafeCount(
            row.snapshot_count,
            'Campaign snapshot count',
          ),
          usedCampaignRollups: toBooleanFlag(row.used_campaign_rollups),
        },
      ];
    }),
  );
}

function emptyMetricTotals(): GroupedMetricTotals {
  return {
    totals: {
      spendCents: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      leads: 0,
      revenueCents: 0,
    },
    snapshotCount: 0,
    usedCampaignRollups: false,
  };
}

function toBooleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function checkedAdd(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new Error(`${label} is outside the safe integer range.`);
  }
  return sum;
}

function requireDatabase(options: { db?: unknown }): QueryDatabase {
  const db = options.db;
  if (!db || typeof db !== 'object' || !('query' in db)) {
    throw new Error(
      'Campaign reporting and summaries require an initialized database connection.',
    );
  }
  return db as QueryDatabase;
}

function coerceDate(value: unknown): Date | null {
  if (value == null) return null;
  const date =
    value instanceof Date
      ? value
      : new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toSafeCount(value: unknown, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} is outside the safe integer range.`);
  }
  return count;
}

function normalizeCursor(
  cursor: CampaignCustomerCursorInput | undefined,
): CampaignCustomerCursor | null {
  if (!cursor) return null;
  const id = normalizeUuid(cursor.id, 'campaign customer cursor id');
  if (cursor.startAt === null) return { id, startAt: null };
  const startAt = coerceDate(cursor.startAt);
  if (!startAt) throw new Error('campaign customer cursor startAt is invalid.');
  return { id, startAt };
}

function normalizeReportingAt(value: Date | string | number | undefined): Date {
  if (value === undefined) return new Date();
  const at = coerceDate(value);
  if (!at) throw new Error('campaign reporting at is invalid.');
  return at;
}

function cursorFromCampaign(
  campaign: Campaign | undefined,
): CampaignCustomerCursor | null {
  if (!campaign?.id) return null;
  return { id: campaign.id, startAt: campaign.startAt };
}

function normalizeTenantScope(
  tenantId: string | null,
  label: string,
): string | null {
  if (tenantId !== null) {
    const normalized = normalizeUuid(tenantId, 'tenantId');
    const tenantContext = getCurrentTenant();
    if (tenantContext && !isSuperAdminBypass()) {
      const contextTenantId = normalizeUuid(tenantContext.tenantId, 'tenantId');
      if (normalized !== contextTenantId) {
        throw new TenantIsolationError(
          `Tenant isolation violation in ${label}.`,
          { tenantId: contextTenantId, attemptedTenantId: normalized },
        );
      }
    }
    return normalized;
  }
  const tenantContext = getCurrentTenant();
  if (tenantContext && !isSuperAdminBypass() && !isSystemContext()) {
    throw new TenantIsolationError(
      `Tenant isolation violation in ${label}: tenant context cannot read global Campaign rows.`,
      { tenantId: tenantContext.tenantId, attemptedTenantId: 'global' },
    );
  }
  return null;
}

function withCanonicalTenantContext<T>(
  tenantId: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  const tenantContext = getCurrentTenant();
  return tenantId !== null &&
    tenantContext &&
    !isSuperAdminBypass() &&
    !isSystemContext()
    ? withTenant({ ...tenantContext, tenantId }, operation)
    : operation();
}

function withCanonicalActiveTenant<T>(operation: () => Promise<T>): Promise<T> {
  const tenantContext = getCurrentTenant();
  if (!tenantContext || isSuperAdminBypass() || isSystemContext()) {
    return operation();
  }
  const normalizedTenantId = normalizeUuid(tenantContext.tenantId, 'tenantId');
  return normalizedTenantId === tenantContext.tenantId
    ? operation()
    : withTenant({ ...tenantContext, tenantId: normalizedTenantId }, operation);
}

function normalizeCampaignGetFilter(
  filter: string | SmrtWhereClause<Campaign>,
): string | SmrtWhereClause<Campaign> {
  if (typeof filter !== 'string') return normalizeCampaignUuidWhere(filter);
  try {
    return normalizeUuid(filter, 'campaign id');
  } catch {
    return filter;
  }
}

function normalizeCampaignListOptions(
  options: SmrtListOptions<Campaign>,
): SmrtListOptions<Campaign> {
  return options.where === undefined
    ? options
    : { ...options, where: normalizeCampaignUuidWhere(options.where) };
}

function normalizeCampaignUuidWhere<T>(where: T): T {
  if (Array.isArray(where)) {
    return where.map((entry) => normalizeCampaignUuidWhere(entry)) as T;
  }
  if (!where || typeof where !== 'object') return where;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    const field = key.trim().split(/\s+/u)[0];
    const label =
      field === 'id'
        ? 'campaign id'
        : field === 'customerId'
          ? 'customerId'
          : field === 'tenantId'
            ? 'tenantId'
            : null;
    if (!label) {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = value.map((uuid) =>
        typeof uuid === 'string' ? normalizeUuid(uuid, label) : uuid,
      );
    } else {
      normalized[key] =
        typeof value === 'string' ? normalizeUuid(value, label) : value;
    }
  }
  return normalized as T;
}

export default CampaignCollection;
