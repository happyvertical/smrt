/**
 * TenantKeyCollection - Collection manager for TenantKey objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { TenantKey, type TenantKeyStatus } from '../models/TenantKey.js';

/**
 * Collection for managing TenantKey objects
 */
export class TenantKeyCollection extends SmrtCollection<TenantKey> {
  static readonly _itemClass = TenantKey;

  /**
   * Get the active key for a tenant
   */
  async getActiveKey(tenantId: string): Promise<TenantKey | null> {
    return this.get({
      tenantId,
      status: 'active',
    });
  }

  /**
   * List all key versions for a tenant
   */
  async listKeyVersions(tenantId: string): Promise<TenantKey[]> {
    return this.list({
      where: { tenantId },
      orderBy: 'version DESC',
    });
  }

  /**
   * Get a specific key version for a tenant
   */
  async getKeyVersion(
    tenantId: string,
    version: number,
  ): Promise<TenantKey | null> {
    return this.get({
      tenantId,
      version,
    });
  }

  /**
   * Find keys that need rotation
   */
  async findKeysNeedingRotation(): Promise<TenantKey[]> {
    const now = new Date();

    return this.list({
      where: {
        status: 'active',
        'rotateAfter !=': null,
        'rotateAfter <': now.toISOString(),
      },
      orderBy: 'rotateAfter ASC',
    });
  }

  /**
   * List all active keys across all tenants
   */
  async listAllActiveKeys(): Promise<TenantKey[]> {
    return this.list({
      where: { status: 'active' },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Count keys by status
   */
  async countByStatus(): Promise<Record<TenantKeyStatus, number>> {
    const keys = await this.list({});

    const counts: Record<TenantKeyStatus, number> = {
      active: 0,
      rotating: 0,
      retired: 0,
      compromised: 0,
    };

    for (const key of keys) {
      counts[key.status]++;
    }

    return counts;
  }

  /**
   * Mark a key as compromised (should trigger re-encryption)
   */
  async markCompromised(tenantId: string, keyId: string): Promise<boolean> {
    const key = await this.get({
      id: keyId,
      tenantId,
    });

    if (!key) return false;

    key.markCompromised();
    await key.save();
    return true;
  }

  /**
   * Delete old retired keys that are no longer needed
   * @param olderThanDays Delete keys retired more than this many days ago
   */
  async cleanupRetiredKeys(olderThanDays: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const oldKeys = await this.list({
      where: {
        status: 'retired',
        'retiredAt <': cutoffDate.toISOString(),
      },
    });

    let count = 0;
    for (const key of oldKeys) {
      await key.delete();
      count++;
    }

    return count;
  }
}
