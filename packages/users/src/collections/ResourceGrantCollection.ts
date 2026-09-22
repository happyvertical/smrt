/** Collection helpers for exact resource grants. @packageDocumentation */
import { SmrtCollection } from '@happyvertical/smrt-core';
import { ResourceGrant } from '../models/ResourceGrant.js';

export class ResourceGrantCollection extends SmrtCollection<ResourceGrant> {
  static readonly _itemClass = ResourceGrant;
  async findExact(
    tenantId: string,
    userId: string,
    resourceType: string,
    resourceId: string,
    permission: string,
  ): Promise<ResourceGrant[]> {
    return this.list({
      where: { tenantId, userId, resourceType, resourceId, permission },
    });
  }
  async findChildren(parentGrantId: string): Promise<ResourceGrant[]> {
    return this.list({ where: { parentGrantId } });
  }
}
