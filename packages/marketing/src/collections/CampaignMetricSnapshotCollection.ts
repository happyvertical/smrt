import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import { CampaignMetricSnapshot } from '../models/CampaignMetricSnapshot.js';
import type { CampaignMetricSnapshotOptions } from '../types.js';

export class CampaignMetricSnapshotCollection extends SmrtCollection<CampaignMetricSnapshot> {
  static readonly _itemClass = CampaignMetricSnapshot;

  /**
   * The tenant a dedupe key resolves in (#3305 M2): an explicit `tenantId`,
   * else the active tenant context, else none (global evidence). This is the
   * owner the tenancy interceptor gives a new row, so the replay lookup, the
   * create and the race re-read agree. A system context carries no tenant,
   * so an administrative ingest names its tenant.
   */
  private resolveOwner(tenantId: string | null | undefined): string | null {
    const context = getCurrentTenant()?.tenantId;
    const owner = tenantId || context || null;
    // A tenant context reads only its own evidence. The class does not opt
    // into super-admin bypass, so the bypass flag does not widen this.
    if (owner && context && owner.toLowerCase() !== context.toLowerCase()) {
      throw new TenantIsolationError(
        `Tenant isolation violation in CampaignMetricSnapshotCollection: context tenant is '${context}' but the lookup requested '${owner}'`,
        { tenantId: context, attemptedTenantId: owner },
      );
    }
    return owner;
  }

  /**
   * The snapshot filed under `dedupeKey` by one owner: `options.tenantId`,
   * else the active context; without either, global evidence only. Keys are
   * tenant-local, so another tenant's snapshot is never returned, and an
   * active context cannot read another tenant's by passing its id.
   */
  async findByDedupeKey(
    dedupeKey: string,
    options: { tenantId?: string | null } = {},
  ): Promise<CampaignMetricSnapshot | null> {
    if (!dedupeKey) return null;
    const tenantId = this.resolveOwner(options.tenantId);
    const rows = (await this.query(
      tenantId
        ? `SELECT * FROM ${this.tableName} WHERE dedupe_key = ? AND tenant_id = ? ORDER BY created_at, id`
        : `SELECT * FROM ${this.tableName} WHERE dedupe_key = ? AND tenant_id IS NULL ORDER BY created_at, id`,
      tenantId ? [dedupeKey, tenantId] : [dedupeKey],
      { allowRawOnTenantScoped: true },
    )) as CampaignMetricSnapshot[];
    const wanted = tenantId?.toLowerCase() ?? null;
    return (
      rows.find((row) =>
        wanted
          ? String(row.tenantId ?? '').toLowerCase() === wanted
          : !row.tenantId,
      ) ?? null
    );
  }

  async getOrCreateByDedupeKey(
    options: CampaignMetricSnapshotOptions,
  ): Promise<{ snapshot: CampaignMetricSnapshot; created: boolean }> {
    const dedupeKey = options.dedupeKey ?? '';
    if (!dedupeKey) {
      throw new Error(
        'CampaignMetricSnapshotCollection.getOrCreateByDedupeKey requires a dedupeKey.',
      );
    }
    // Replay lookup, create and race re-read all use one owner, so a retry
    // finds what it filed and never another tenant's evidence.
    const tenantId = this.resolveOwner(options.tenantId);
    const existing = await this.findByDedupeKey(dedupeKey, { tenantId });
    if (existing) return { snapshot: existing, created: false };

    try {
      const snapshot = await this.create({
        ...options,
        tenantId,
        // Keep runtime values uncoerced so the model rejects null/invalid
        // periods instead of allowing Date(null) to become the Unix epoch.
        periodStart: options.periodStart as Date | undefined,
        periodEnd: options.periodEnd as Date | undefined,
        _insertOnly: true,
      });
      return { snapshot, created: true };
    } catch (error) {
      // A concurrent ingest may have won the unique dedupe-key insert after
      // our initial read. Re-read the immutable winner instead of allowing a
      // natural-key upsert to replace its evidence in place.
      const concurrent = await this.findByDedupeKey(dedupeKey, { tenantId });
      if (concurrent) return { snapshot: concurrent, created: false };
      throw error;
    }
  }

  async findByCampaign(campaignId: string): Promise<CampaignMetricSnapshot[]> {
    return await this.list({
      where: { campaignId },
      orderBy: 'period_start ASC',
    });
  }

  async findByChannel(
    campaignChannelId: string,
  ): Promise<CampaignMetricSnapshot[]> {
    return await this.list({
      where: { campaignChannelId },
      orderBy: 'period_start ASC',
    });
  }
}

export default CampaignMetricSnapshotCollection;
