import { SmrtCollection } from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { PromptOverride } from '../models/PromptOverride.js';

export class PromptOverrideCollection extends SmrtCollection<PromptOverride> {
  static readonly _itemClass = PromptOverride;

  async listForKey(
    key: string,
    options: { excludeId?: string } = {},
  ): Promise<PromptOverride[]> {
    return withSystemContext(async () => {
      const items = await this.list({ where: { key } });
      return items.filter((item) =>
        options.excludeId ? item.id !== options.excludeId : true,
      );
    });
  }

  async getAppOverride(
    key: string,
    options: { excludeId?: string } = {},
  ): Promise<PromptOverride | null> {
    const items = await this.listForKey(key, options);
    return items.find((item) => item.tenantId === null) ?? null;
  }

  async getTenantOverride(
    key: string,
    tenantId: string,
    options: { excludeId?: string } = {},
  ): Promise<PromptOverride | null> {
    const items = await this.listForKey(key, options);
    return items.find((item) => item.tenantId === tenantId) ?? null;
  }

  async getResolutionLayers(
    key: string,
    tenantId?: string | null,
    options: { excludeId?: string } = {},
  ): Promise<{ app: PromptOverride | null; tenant: PromptOverride | null }> {
    const items = await this.listForKey(key, options);

    return {
      app: items.find((item) => item.tenantId === null) ?? null,
      tenant:
        tenantId != null
          ? (items.find((item) => item.tenantId === tenantId) ?? null)
          : null,
    };
  }
}
