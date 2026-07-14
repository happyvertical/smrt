import { SmrtCollection } from '@happyvertical/smrt-core';
import { CampaignChannel } from '../models/CampaignChannel.js';

export class CampaignChannelCollection extends SmrtCollection<CampaignChannel> {
  static readonly _itemClass = CampaignChannel;

  async findByCampaign(campaignId: string): Promise<CampaignChannel[]> {
    return await this.list({
      where: { campaignId },
      orderBy: 'start_at ASC',
    });
  }

  async findByExecutionRef(
    channelKind: string,
    channelRef: string,
  ): Promise<CampaignChannel[]> {
    return await this.list({ where: { channelKind, channelRef } });
  }
}

export default CampaignChannelCollection;
