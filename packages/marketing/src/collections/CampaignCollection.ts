import { resolveListLimit, SmrtCollection } from '@happyvertical/smrt-core';
import { assertTenantReadAllowed } from '@happyvertical/smrt-tenancy';
import { assertCustomersBelongToTenant } from '../customer-scope.js';
import { Campaign } from '../models/Campaign.js';
import type {
  CampaignCustomerCursor,
  CampaignCustomerCursorInput,
  CampaignCustomerPage,
  CampaignCustomerSummary,
  CampaignStatus,
  ListCampaignsByCustomerOptions,
} from '../types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const MAX_CAMPAIGN_CUSTOMER_PAGE_SIZE = 100;
export const MAX_CAMPAIGN_CUSTOMER_BATCH_SIZE = 100;

export class CampaignCollection extends SmrtCollection<Campaign> {
  static readonly _itemClass = Campaign;

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
    tenantId: string,
    customerId: string,
    options: ListCampaignsByCustomerOptions = {},
  ): Promise<CampaignCustomerPage> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(customerId, 'customerId');
    assertTenantReadAllowed(tenantId, 'CampaignCollection.listByCustomer');
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
    await assertCustomersBelongToTenant(
      this.options,
      tenantId,
      [customerId],
      'CampaignCollection.listByCustomer',
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
    tenantId: string,
    customerIds: string[],
  ): Promise<CampaignCustomerSummary[]> {
    assertUuid(tenantId, 'tenantId');
    assertTenantReadAllowed(
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
    const uniqueIds = [...new Set(customerIds)];
    for (const customerId of uniqueIds) assertUuid(customerId, 'customerId');
    if (uniqueIds.length === 0) return [];

    await assertCustomersBelongToTenant(
      this.options,
      tenantId,
      uniqueIds,
      'CampaignCollection.summarizeByCustomers',
    );
    const db = requireDatabase(this.options);
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const result = await db.query(
      `SELECT customer_id,
              COUNT(*) AS total_count,
              SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS active_count,
              MAX(start_at) AS latest_start_at
       FROM ${this.tableName}
       WHERE tenant_id = ? AND customer_id IN (${placeholders})
       GROUP BY customer_id
       ORDER BY customer_id ASC
       LIMIT ?`,
      'active',
      tenantId,
      ...uniqueIds,
      uniqueIds.length,
    );
    const byCustomer = new Map(
      result.rows.map((row) => [String(row.customer_id), row]),
    );
    return customerIds.map((customerId) => {
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

  private async listScheduledLane(
    tenantId: string,
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
    tenantId: string,
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

function requireDatabase(options: { db?: unknown }): QueryDatabase {
  const db = options.db;
  if (!db || typeof db !== 'object' || !('query' in db)) {
    throw new Error(
      'Campaign customer summaries require an initialized database connection.',
    );
  }
  return db as QueryDatabase;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a canonical UUID.`);
  }
}

function coerceDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
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
  assertUuid(cursor.id, 'campaign customer cursor id');
  if (cursor.startAt === null) return { id: cursor.id, startAt: null };
  const startAt = coerceDate(cursor.startAt);
  if (!startAt) throw new Error('campaign customer cursor startAt is invalid.');
  return { id: cursor.id, startAt };
}

function cursorFromCampaign(
  campaign: Campaign | undefined,
): CampaignCustomerCursor | null {
  if (!campaign?.id) return null;
  return { id: campaign.id, startAt: campaign.startAt };
}

export default CampaignCollection;
