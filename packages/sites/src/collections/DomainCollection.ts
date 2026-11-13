/**
 * DomainCollection - Collection manager for Domain objects
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Domain } from '../models/Domain';

export class DomainCollection extends SmrtCollection<Domain> {
  static readonly _itemClass = Domain;

  /** Find a domain by hostname */
  async findByHostname(hostname: string): Promise<Domain | null> {
    const results = await this.list({ where: { hostname } });
    return results[0] ?? null;
  }

  /** All domains under a zone */
  async findByZone(zoneId: string): Promise<Domain[]> {
    return this.list({ where: { zoneId } });
  }
}
