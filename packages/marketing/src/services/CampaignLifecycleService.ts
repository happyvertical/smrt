import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { CampaignCollection } from '../collections/CampaignCollection.js';
import type { Campaign } from '../models/Campaign.js';
import type { CampaignStatus } from '../types.js';

/** Single authoritative write path for Campaign lifecycle changes. */
export class CampaignLifecycleService {
  constructor(private readonly campaigns: CampaignCollection) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<CampaignLifecycleService> {
    return new CampaignLifecycleService(
      await CampaignCollection.create(classOptions),
    );
  }

  async transition(
    campaignId: string,
    next: CampaignStatus,
  ): Promise<Campaign> {
    const campaign = await this.campaigns.get({ id: campaignId });
    if (!campaign) throw new Error(`Campaign '${campaignId}' was not found.`);
    campaign.transitionTo(next);
    await campaign.save();
    return campaign;
  }

  async schedule(campaignId: string): Promise<Campaign> {
    return await this.transition(campaignId, 'scheduled');
  }

  async activate(campaignId: string): Promise<Campaign> {
    return await this.transition(campaignId, 'active');
  }

  async pause(campaignId: string): Promise<Campaign> {
    return await this.transition(campaignId, 'paused');
  }

  async resume(campaignId: string): Promise<Campaign> {
    return await this.transition(campaignId, 'active');
  }

  async complete(campaignId: string): Promise<Campaign> {
    return await this.transition(campaignId, 'completed');
  }

  async archive(campaignId: string): Promise<Campaign> {
    return await this.transition(campaignId, 'archived');
  }
}

export default CampaignLifecycleService;
