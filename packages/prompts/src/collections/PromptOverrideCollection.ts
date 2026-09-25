import { SmrtCollection } from '@happyvertical/smrt-core';
import { PromptOverride } from '../models/PromptOverride.js';
import type { PromptOverrideScopeType } from '../types.js';

export class PromptOverrideCollection extends SmrtCollection<PromptOverride> {
  static readonly _itemClass = PromptOverride;

  private excludeOverrideId(
    items: PromptOverride[],
    excludeId?: string,
  ): PromptOverride[] {
    return items.filter((item) => (excludeId ? item.id !== excludeId : true));
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

  /** The override row for a scope request, in the vocabulary used at the write boundary. */
  async findByScope(
    key: string,
    scopeType: PromptOverrideScopeType,
    scopeId: string,
  ): Promise<PromptOverride | null> {
    return scopeType === 'app'
      ? this.getAppOverride(key)
      : this.getTenantOverride(key, scopeId);
  }

  /**
   * Set (or clear, with `template: null`) the `template` field of the override
   * row for one scope, creating the row if it did not exist. Other fields
   * (`profile`, `model`, `params`) on an existing row are left untouched, per
   * this package's field-by-field inheritance model.
   */
  async setTemplateOverride(
    key: string,
    scopeType: PromptOverrideScopeType,
    scopeId: string,
    template: string | null,
  ): Promise<PromptOverride> {
    const existing = await this.findByScope(key, scopeType, scopeId);

    if (existing) {
      existing.template = template;
      await existing.save();
      return existing;
    }

    const created = await this.create({
      key,
      tenantId: scopeType === 'app' ? null : scopeId,
      template,
    });
    await created.save();
    return created;
  }

  /** Remove the override row for one scope entirely, if one exists. */
  async removeOverride(
    key: string,
    scopeType: PromptOverrideScopeType,
    scopeId: string,
  ): Promise<boolean> {
    const existing = await this.findByScope(key, scopeType, scopeId);
    if (!existing) {
      return false;
    }

    await existing.delete();
    return true;
  }
}
