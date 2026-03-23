import type { Asset } from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { EventAsset } from '../models/EventAsset';

export interface EventAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class EventAssetCollection extends SmrtCollection<EventAsset> {
  static readonly _itemClass = EventAsset;

  async getForEvent(
    eventId: string,
    relationship?: string,
  ): Promise<EventAsset[]> {
    const where = relationship ? { eventId, relationship } : { eventId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as EventAsset[];
  }

  async getForAsset(assetId: string): Promise<EventAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as EventAsset[];
  }

  async attach(
    eventId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<EventAsset> {
    return (await this.create({
      eventId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    })) as EventAsset;
  }

  async detach(
    eventId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const where: Record<string, string> = { eventId, assetId };
    if (relationship) {
      where.relationship = relationship;
    }

    const links = (await this.list({ where })) as EventAsset[];
    for (const link of links) {
      await link.delete();
    }
  }

  async getAssets(eventId: string, relationship?: string): Promise<Asset[]> {
    const { EventCollection } = await import('./EventCollection');
    const events = await EventCollection.create({ db: this.db });
    return events.getAssets(eventId, relationship);
  }

  async addAsset(
    eventId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    const { EventCollection } = await import('./EventCollection');
    const events = await EventCollection.create({ db: this.db });
    await events.addAsset(eventId, asset, relationship, sortOrder);
  }

  async removeAsset(
    eventId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const { EventCollection } = await import('./EventCollection');
    const events = await EventCollection.create({ db: this.db });
    await events.removeAsset(eventId, assetId, relationship);
  }
}
