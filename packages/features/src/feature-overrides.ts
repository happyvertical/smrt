import { SmrtCollection } from '@happyvertical/smrt-core';
import { FeatureOverride } from './feature-override.js';
import {
  type FeatureOverrideEffect,
  type FeatureScopeType,
  GLOBAL_FEATURE_SCOPE_ID,
} from './types.js';

export class FeatureOverrideCollection extends SmrtCollection<FeatureOverride> {
  static readonly _itemClass = FeatureOverride;

  async findByFeatureKey(featureKey: string): Promise<FeatureOverride[]> {
    return this.list({
      where: { featureKey },
    });
  }

  async findByFeatureAndScope(
    featureKey: string,
    scopeType: FeatureScopeType,
    scopeId: string,
  ): Promise<FeatureOverride | null> {
    const results = await this.list({
      where: { featureKey, scopeType, scopeId },
      limit: 1,
    });
    return results[0] ?? null;
  }

  async getGlobalOverride(featureKey: string): Promise<FeatureOverride | null> {
    return this.findByFeatureAndScope(
      featureKey,
      'global',
      GLOBAL_FEATURE_SCOPE_ID,
    );
  }

  async getTenantOverride(
    featureKey: string,
    tenantId: string,
  ): Promise<FeatureOverride | null> {
    return this.findByFeatureAndScope(featureKey, 'tenant', tenantId);
  }

  async getOverrideMap(
    featureKey: string,
    scopeType: FeatureScopeType,
    scopeIds: string[],
  ): Promise<Map<string, FeatureOverride>> {
    const result = new Map<string, FeatureOverride>();
    if (scopeIds.length === 0) {
      return result;
    }

    const overrides = await this.list({
      where: { featureKey, scopeType, scopeId: scopeIds },
    });

    for (const override of overrides) {
      result.set(override.scopeId, override);
    }

    return result;
  }

  async setOverride(
    featureKey: string,
    scopeType: FeatureScopeType,
    scopeId: string,
    effect: FeatureOverrideEffect,
  ): Promise<FeatureOverride> {
    const existing = await this.findByFeatureAndScope(
      featureKey,
      scopeType,
      scopeId,
    );

    if (existing) {
      existing.effect = effect;
      await existing.save();
      return existing;
    }

    const created = await this.create({
      featureKey,
      scopeType,
      scopeId,
      effect,
    });
    await created.save();
    return created;
  }

  async setGlobalOverride(
    featureKey: string,
    effect: FeatureOverrideEffect,
  ): Promise<FeatureOverride> {
    return this.setOverride(
      featureKey,
      'global',
      GLOBAL_FEATURE_SCOPE_ID,
      effect,
    );
  }

  async setTenantOverride(
    featureKey: string,
    tenantId: string,
    effect: FeatureOverrideEffect,
  ): Promise<FeatureOverride> {
    return this.setOverride(featureKey, 'tenant', tenantId, effect);
  }

  async removeOverride(
    featureKey: string,
    scopeType: FeatureScopeType,
    scopeId: string,
  ): Promise<boolean> {
    const existing = await this.findByFeatureAndScope(
      featureKey,
      scopeType,
      scopeId,
    );

    if (!existing) {
      return false;
    }

    await existing.delete();
    return true;
  }
}
