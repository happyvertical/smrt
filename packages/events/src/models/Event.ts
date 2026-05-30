/**
 * Event model - Hierarchical event instances
 *
 * Infinitely nestable: Game → Period → Goal → Assist
 */

import type { Asset } from '@happyvertical/smrt-assets';
import {
  assertValidOwnedAssetRelationship,
  assertValidOwnedAssetSortOrder,
  resolveOwnedAssetsById,
} from '@happyvertical/smrt-assets';
import {
  crossPackageRef,
  foreignKey,
  SmrtHierarchical,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { EventOptions, EventStatus } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Event extends SmrtHierarchical {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  name: string = '';
  @foreignKey('EventSeries')
  seriesId = ''; // FK to EventSeries (nullable for standalone events)
  // parentId inherited from SmrtHierarchical (self-reference to parent Event)
  @foreignKey('EventType')
  typeId = ''; // FK to EventType
  @crossPackageRef('@happyvertical/smrt-places:Place')
  placeId = ''; // FK to Place (from @happyvertical/smrt-places)
  description = '';
  startDate: Date | null = null;
  endDate: Date | null = null;
  status: EventStatus = 'scheduled';
  round: number | null = null; // Sequence/round number in series
  metadata = ''; // JSON metadata (stored as text)
  externalId = ''; // External system identifier
  source = ''; // Source system

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EventOptions = {}) {
    super(options);

    if (options.seriesId !== undefined) this.seriesId = options.seriesId;
    if (options.parentId !== undefined)
      this.parentId = options.parentId ?? null;
    if (options.typeId) this.typeId = options.typeId;
    if (options.placeId !== undefined) this.placeId = options.placeId;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.startDate !== undefined)
      this.startDate = options.startDate || null;
    if (options.endDate !== undefined) this.endDate = options.endDate || null;
    if (options.status !== undefined) this.status = options.status;
    if (options.round !== undefined) this.round = options.round;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.source !== undefined) this.source = options.source;

    // Handle metadata - can be object or JSON string
    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }

    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get metadata as parsed object
   *
   * @returns Parsed metadata object or empty object
   */
  getMetadata(): Record<string, any> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   *
   * @param data - Metadata object to store
   */
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   *
   * @param updates - Partial metadata to merge
   */
  updateMetadata(updates: Record<string, any>): void {
    const current = this.getMetadata();
    this.setMetadata({ ...current, ...updates });
  }

  /**
   * Update event status
   *
   * @param newStatus - New status to set
   */
  async updateStatus(newStatus: EventStatus): Promise<void> {
    this.status = newStatus;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Get the series for this event
   *
   * @returns EventSeries instance or null
   */
  async getSeries() {
    if (!this.seriesId) return null;

    const { EventSeriesCollection } = await import(
      '../collections/EventSeriesCollection'
    );
    const collection = await (EventSeriesCollection as any).create(
      this.options,
    );

    return await collection.get({ id: this.seriesId });
  }

  /**
   * Get the event type
   *
   * @returns EventType instance or null
   */
  async getType() {
    if (!this.typeId) return null;

    const { EventTypeCollection } = await import(
      '../collections/EventTypeCollection'
    );
    const collection = await (EventTypeCollection as any).create(this.options);

    return await collection.get({ id: this.typeId });
  }

  /**
   * Get the place for this event
   *
   * @returns Place instance or null
   */
  async getPlace() {
    if (!this.placeId) return null;

    try {
      const { PlaceCollection } = await import('@happyvertical/smrt-places');
      const collection = await (PlaceCollection as any).create(this.options);

      return await collection.get({ id: this.placeId });
    } catch {
      // @happyvertical/smrt-places not available
      return null;
    }
  }

  // Hierarchy traversal (getParent / getChildren / getAncestors /
  // getDescendants / getHierarchy / moveTo) provided by SmrtHierarchical.

  /**
   * Get the root event (top-level ancestor) of this event's hierarchy.
   *
   * @returns Root event instance — `this` when already root
   */
  async getRootEvent(): Promise<Event> {
    const ancestors = await this.getAncestors();
    return (ancestors.length > 0 ? ancestors[0] : this) as Event;
  }

  /**
   * Get all participants for this event
   *
   * @returns Array of EventParticipant instances
   */
  async getParticipants() {
    const { EventParticipantCollection } = await import(
      '../collections/EventParticipantCollection'
    );
    const collection = await (EventParticipantCollection as any).create(
      this.options,
    );

    return await collection.list({ where: { eventId: this.id } });
  }

  private async getEventAssetCollection() {
    const { EventAssetCollection } = await import(
      '../collections/EventAssetCollection'
    );
    return EventAssetCollection.create({ db: this.db });
  }
  async getAssets(relationship?: string): Promise<Asset[]> {
    if (!this.id) {
      return [];
    }

    const eventAssets = await this.getEventAssetCollection();
    const linkedAssets = await eventAssets.byLeft(
      this.id,
      relationship ? { relationship } : {},
    );

    return resolveOwnedAssetsById(
      this.db,
      linkedAssets.map((link) => link.assetId),
      this.tenantId,
    );
  }

  async addAsset(
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    if (!this.id || !asset.id) {
      throw new Error('Cannot associate unsaved event or asset');
    }

    assertValidOwnedAssetRelationship(relationship);
    assertValidOwnedAssetSortOrder(sortOrder);

    const eventAssets = await this.getEventAssetCollection();
    await eventAssets.attach(this.id, asset.id, {
      relationship,
      sortOrder,
      tenantId: this.tenantId,
    });
  }

  async removeAsset(assetId: string, relationship?: string): Promise<void> {
    if (!this.id) {
      return;
    }

    const eventAssets = await this.getEventAssetCollection();
    await eventAssets.detach(
      this.id,
      assetId,
      relationship ? { relationship } : {},
    );
  }

  /**
   * Check if event is currently in progress
   *
   * @returns True if current time is between start and end
   */
  isInProgress(): boolean {
    if (this.status !== 'in_progress') return false;

    const now = new Date();
    if (this.startDate && now < this.startDate) return false;
    if (this.endDate && now > this.endDate) return false;

    return true;
  }

  /**
   * Check if event is a root event (no parent)
   *
   * @returns True if parentId is null/empty
   */
  isRoot(): boolean {
    return !this.parentId;
  }
}
