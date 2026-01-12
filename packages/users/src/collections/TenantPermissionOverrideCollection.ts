/**
 * TenantPermissionOverrideCollection - Collection manager for TenantPermissionOverride objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { TenantPermissionOverride } from '../models/TenantPermissionOverride.js';
import { TenantPermissionEffect } from '../types/index.js';

/**
 * Result of resolving tenant permission overrides
 */
export interface TenantPermissionOverrideResult {
  /** Permission IDs explicitly granted at this tenant level */
  grantedPermissionIds: string[];
  /** Permission IDs explicitly denied at this tenant level */
  deniedPermissionIds: string[];
  /** Permission IDs set to inherit from parent */
  inheritedPermissionIds: string[];
}

/**
 * Collection for managing TenantPermissionOverride objects.
 *
 * Provides methods for setting and querying tenant-level permission overrides
 * used in hierarchical tenant permission inheritance.
 */
export class TenantPermissionOverrideCollection extends SmrtCollection<TenantPermissionOverride> {
  static readonly _itemClass = TenantPermissionOverride;

  /**
   * Find all overrides for a tenant
   */
  async findByTenant(tenantId: string): Promise<TenantPermissionOverride[]> {
    return await this.list({
      where: { tenantId },
    });
  }

  /**
   * Find grant overrides for a tenant
   */
  async findGrants(tenantId: string): Promise<TenantPermissionOverride[]> {
    return await this.list({
      where: { tenantId, effect: TenantPermissionEffect.GRANT },
    });
  }

  /**
   * Find deny overrides for a tenant
   */
  async findDenies(tenantId: string): Promise<TenantPermissionOverride[]> {
    return await this.list({
      where: { tenantId, effect: TenantPermissionEffect.DENY },
    });
  }

  /**
   * Find inherit overrides for a tenant
   */
  async findInherits(tenantId: string): Promise<TenantPermissionOverride[]> {
    return await this.list({
      where: { tenantId, effect: TenantPermissionEffect.INHERIT },
    });
  }

  /**
   * Get granted permission IDs for a tenant
   */
  async getGrantedPermissionIds(tenantId: string): Promise<string[]> {
    const grants = await this.findGrants(tenantId);
    return grants.map((o) => o.permissionId as string);
  }

  /**
   * Get denied permission IDs for a tenant
   */
  async getDeniedPermissionIds(tenantId: string): Promise<string[]> {
    const denies = await this.findDenies(tenantId);
    return denies.map((o) => o.permissionId as string);
  }

  /**
   * Get all overrides for a tenant, organized by effect
   */
  async getOverridesByEffect(
    tenantId: string,
  ): Promise<TenantPermissionOverrideResult> {
    const overrides = await this.findByTenant(tenantId);

    const result: TenantPermissionOverrideResult = {
      grantedPermissionIds: [],
      deniedPermissionIds: [],
      inheritedPermissionIds: [],
    };

    for (const override of overrides) {
      const permId = override.permissionId as string;
      switch (override.effect) {
        case TenantPermissionEffect.GRANT:
          result.grantedPermissionIds.push(permId);
          break;
        case TenantPermissionEffect.DENY:
          result.deniedPermissionIds.push(permId);
          break;
        case TenantPermissionEffect.INHERIT:
          result.inheritedPermissionIds.push(permId);
          break;
      }
    }

    return result;
  }

  /**
   * Set an override for a tenant permission
   */
  async setOverride(
    tenantId: string,
    permissionId: string,
    effect: TenantPermissionEffect,
  ): Promise<TenantPermissionOverride> {
    // Check if override already exists
    const existing = await this.list({
      where: { tenantId, permissionId },
      limit: 1,
    });

    if (existing.length > 0) {
      // Update existing override
      existing[0].effect = effect;
      await existing[0].save();
      return existing[0];
    }

    // Create new override
    const override = await this.create({ tenantId, permissionId, effect });
    await override.save();
    return override;
  }

  /**
   * Remove an override (permission will use default behavior)
   */
  async removeOverride(
    tenantId: string,
    permissionId: string,
  ): Promise<boolean> {
    const existing = await this.list({
      where: { tenantId, permissionId },
      limit: 1,
    });

    if (existing.length === 0) {
      return false;
    }

    await existing[0].delete();
    return true;
  }

  /**
   * Remove all overrides for a tenant
   */
  async removeAllOverrides(tenantId: string): Promise<number> {
    const overrides = await this.findByTenant(tenantId);
    for (const override of overrides) {
      await override.delete();
    }
    return overrides.length;
  }

  /**
   * Grant a permission at the tenant level.
   * Convenience method for setOverride with GRANT effect.
   */
  async grantPermission(
    tenantId: string,
    permissionId: string,
  ): Promise<TenantPermissionOverride> {
    return await this.setOverride(
      tenantId,
      permissionId,
      TenantPermissionEffect.GRANT,
    );
  }

  /**
   * Deny a permission at the tenant level.
   * Convenience method for setOverride with DENY effect.
   * This blocks inheritance from parent tenants.
   */
  async denyPermission(
    tenantId: string,
    permissionId: string,
  ): Promise<TenantPermissionOverride> {
    return await this.setOverride(
      tenantId,
      permissionId,
      TenantPermissionEffect.DENY,
    );
  }

  /**
   * Set a permission to inherit from parent.
   * Convenience method for setOverride with INHERIT effect.
   * This is the default behavior, so mainly useful to document intent
   * or to reset a previous grant/deny.
   */
  async inheritPermission(
    tenantId: string,
    permissionId: string,
  ): Promise<TenantPermissionOverride> {
    return await this.setOverride(
      tenantId,
      permissionId,
      TenantPermissionEffect.INHERIT,
    );
  }

  /**
   * Bulk set overrides for a tenant.
   * Useful for importing or copying permission configurations.
   */
  async bulkSetOverrides(
    tenantId: string,
    overrides: Array<{ permissionId: string; effect: TenantPermissionEffect }>,
  ): Promise<TenantPermissionOverride[]> {
    const results: TenantPermissionOverride[] = [];
    for (const { permissionId, effect } of overrides) {
      const override = await this.setOverride(tenantId, permissionId, effect);
      results.push(override);
    }
    return results;
  }

  /**
   * Copy overrides from one tenant to another.
   * Useful when creating child tenants or templates.
   */
  async copyOverrides(
    fromTenantId: string,
    toTenantId: string,
  ): Promise<TenantPermissionOverride[]> {
    const sourceOverrides = await this.findByTenant(fromTenantId);
    const results: TenantPermissionOverride[] = [];

    for (const source of sourceOverrides) {
      const override = await this.setOverride(
        toTenantId,
        source.permissionId as string,
        source.effect,
      );
      results.push(override);
    }

    return results;
  }
}
