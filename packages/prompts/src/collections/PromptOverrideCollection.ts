import { SmrtCollection } from '@happyvertical/smrt-core';
import { PromptOverride } from '../models/PromptOverride.js';

export class PromptOverrideCollection extends SmrtCollection<PromptOverride> {
  static readonly _itemClass = PromptOverride;

  private excludeOverrideId(
    items: PromptOverride[],
    excludeId?: string,
  ): PromptOverride[] {
    return items.filter((item) => (excludeId ? item.id !== excludeId : true));
  }

  async listForKey(
    key: string,
    options: { excludeId?: string } = {},
  ): Promise<PromptOverride[]> {
    const items = await this.list({ where: { key } });
    return this.excludeOverrideId(items, options.excludeId);
  }

  async getAppOverride(
    key: string,
    options: { excludeId?: string } = {},
  ): Promise<PromptOverride | null> {
    const items = await this.list({ where: { key, tenantId: null } });
    return this.excludeOverrideId(items, options.excludeId)[0] ?? null;
  }

  async getTenantOverride(
    key: string,
    tenantId: string,
    options: { excludeId?: string } = {},
  ): Promise<PromptOverride | null> {
    const items = await this.list({ where: { key, tenantId } });
    return this.excludeOverrideId(items, options.excludeId)[0] ?? null;
  }

  async getResolutionLayers(
    key: string,
    tenantId?: string | null,
    options: { excludeId?: string } = {},
  ): Promise<{ app: PromptOverride | null; tenant: PromptOverride | null }> {
    const [app, tenant] = await Promise.all([
      this.getAppOverride(key, options),
      tenantId != null
        ? this.getTenantOverride(key, tenantId, options)
        : Promise.resolve(null),
    ]);

    return {
      app,
      tenant,
    };
  }
}
