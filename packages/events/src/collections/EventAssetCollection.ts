import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  getOwnedAssetsFromCollection,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { EventAsset } from '../models/EventAsset';
import type { EventCollection } from './EventCollection';

export interface EventAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class EventAssetCollection extends SmrtJunction<EventAsset> {
  static readonly _itemClass = EventAsset;
  protected leftField = 'eventId';
  protected rightField = 'assetId';

  private eventCollectionPromise: Promise<EventCollection> | null = null;

  private async getEventCollection(): Promise<EventCollection> {
    if (!this.eventCollectionPromise) {
      const { EventCollection } = await import('./EventCollection');
      this.eventCollectionPromise = EventCollection.create({ db: this.db });
    }

    return this.eventCollectionPromise;
  }

  async getAssets(eventId: string, relationship?: string): Promise<Asset[]> {
    return getOwnedAssetsFromCollection(
      await this.getEventCollection(),
      eventId,
      relationship,
    );
  }

  async addAsset(
    eventId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    await addOwnedAssetFromCollection(
      await this.getEventCollection(),
      'Event',
      eventId,
      asset,
      relationship,
      sortOrder,
    );
  }

  async removeAsset(
    eventId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await removeOwnedAssetFromCollection(
      await this.getEventCollection(),
      'Event',
      eventId,
      assetId,
      relationship,
    );
  }
}
