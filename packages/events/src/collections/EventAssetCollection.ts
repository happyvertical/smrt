import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  createOwnedAssetLink,
  deleteOwnedAssetLinks,
  getOwnedAssetsFromCollection,
  listOwnedAssetLinks,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { EventAsset } from '../models/EventAsset';
import type { EventCollection } from './EventCollection';

export interface EventAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class EventAssetCollection extends SmrtCollection<EventAsset> {
  static readonly _itemClass = EventAsset;
  private eventCollectionPromise: Promise<EventCollection> | null = null;

  private async getEventCollection(): Promise<EventCollection> {
    if (!this.eventCollectionPromise) {
      const { EventCollection } = await import('./EventCollection');
      this.eventCollectionPromise = EventCollection.create({ db: this.db });
    }

    return this.eventCollectionPromise;
  }

  async getForEvent(
    eventId: string,
    relationship?: string,
  ): Promise<EventAsset[]> {
    return listOwnedAssetLinks(this, 'eventId', eventId, relationship);
  }

  async getForAsset(assetId: string): Promise<EventAsset[]> {
    return listOwnedAssetLinks(this, 'assetId', assetId);
  }

  async attach(
    eventId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<EventAsset> {
    return createOwnedAssetLink(this, {
      eventId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    });
  }

  async detach(
    eventId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await deleteOwnedAssetLinks(
      this,
      'eventId',
      eventId,
      assetId,
      relationship,
    );
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
