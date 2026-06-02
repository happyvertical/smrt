/**
 * InventoryLocationCollection — query helpers for {@link InventoryLocation}.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { InventoryLocation } from '../models/InventoryLocation.js';
import type { InventoryLocationKind } from '../types.js';

export class InventoryLocationCollection extends SmrtCollection<InventoryLocation> {
  static readonly _itemClass = InventoryLocation;

  /**
   * Look up a location by its tenant-scoped `code`. Returns `null` when
   * no row matches.
   */
  async findByCode(code: string): Promise<InventoryLocation | null> {
    const matches = await this.list({ where: { code }, limit: 1 });
    return matches[0] ?? null;
  }

  /**
   * Find every location classified as the given kind (`'warehouse'`,
   * `'factory'`, `'retail'`, `'in_transit'`, …).
   */
  async findByKind(kind: InventoryLocationKind): Promise<InventoryLocation[]> {
    return this.list({ where: { kind }, orderBy: 'code ASC' });
  }

  /**
   * Find every location linked to a particular `Place.id` from
   * `@happyvertical/smrt-places`. Returns an empty array when no row
   * references the place.
   */
  async findByPlace(placeId: string): Promise<InventoryLocation[]> {
    if (!placeId) return [];
    return this.list({ where: { placeId }, orderBy: 'code ASC' });
  }

  /** Find every active location, optionally narrowed by kind. */
  async findActive(kind?: InventoryLocationKind): Promise<InventoryLocation[]> {
    const where: Record<string, unknown> = { active: true };
    if (kind) where.kind = kind;
    return this.list({ where, orderBy: 'code ASC' });
  }
}
