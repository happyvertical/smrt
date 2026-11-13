/**
 * DnsZoneCollection - Collection manager for DnsZone objects
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { DnsZone } from '../models/DnsZone';

export class DnsZoneCollection extends SmrtCollection<DnsZone> {
  static readonly _itemClass = DnsZone;

  /** Find a zone by apex name */
  async findByName(name: string): Promise<DnsZone | null> {
    const results = await this.list({ where: { name } });
    return results[0] ?? null;
  }
}
