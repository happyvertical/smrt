import { SmrtCollection } from '@happyvertical/smrt-core';
import { Campaign } from '../models/Campaign.js';
import type { CampaignStatus } from '../types.js';

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
}

export default CampaignCollection;
