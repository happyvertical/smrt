import { SmrtCollection } from '@happyvertical/smrt-core';
import { PlaybookOverride } from '../models/PlaybookOverride.js';

export class PlaybookOverrideCollection extends SmrtCollection<PlaybookOverride> {
  static readonly _itemClass = PlaybookOverride;

  private excludeOverrideId(
    items: PlaybookOverride[],
    excludeId?: string,
  ): PlaybookOverride[] {
    return items.filter((item) => (excludeId ? item.id !== excludeId : true));
  }

  async getAppOverride(
    key: string,
    options: { excludeId?: string } = {},
  ): Promise<PlaybookOverride | null> {
    const items = await this.list({ where: { key, tenantId: null } });
    return this.excludeOverrideId(items, options.excludeId)[0] ?? null;
  }

  async getTenantOverride(
    key: string,
    tenantId: string,
    options: { excludeId?: string } = {},
  ): Promise<PlaybookOverride | null> {
    const items = await this.list({ where: { key, tenantId } });
    return this.excludeOverrideId(items, options.excludeId)[0] ?? null;
  }

  async getResolutionLayers(
    key: string,
    tenantId?: string | null,
    options: { excludeId?: string } = {},
  ): Promise<{
    app: PlaybookOverride | null;
    tenant: PlaybookOverride | null;
  }> {
    const [app, tenant] = await Promise.all([
      this.getAppOverride(key, options),
      tenantId != null
        ? this.getTenantOverride(key, tenantId, options)
        : Promise.resolve(null),
    ]);

    return { app, tenant };
  }
}
