/**
 * MembershipOverrideCollection - Collection manager for MembershipOverride objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { MembershipOverride } from '../models/MembershipOverride.js';
import { OverrideEffect } from '../types/index.js';

/**
 * Collection for managing MembershipOverride objects
 */
export class MembershipOverrideCollection extends SmrtCollection<MembershipOverride> {
  static readonly _itemClass = MembershipOverride;

  /**
   * Find all overrides for a membership
   */
  async findByMembership(membershipId: string): Promise<MembershipOverride[]> {
    return await this.list({
      where: { membershipId },
    });
  }

  /**
   * Find grant overrides for a membership.
   *
   * Filters in memory because the `effect` column is JSON-typed and
   * Postgres rejects bare `json = text` comparisons.  A single
   * `findByMembership` call is reused for both grant and deny lookups
   * within the same request (see `_overridesByMembership` cache).
   */
  async findGrants(membershipId: string): Promise<MembershipOverride[]> {
    const all = await this.findByMembership(membershipId);
    return all.filter((o) => o.effect === OverrideEffect.GRANT);
  }

  /**
   * Find deny overrides for a membership.
   *
   * See `findGrants` for rationale on in-memory filtering.
   */
  async findDenies(membershipId: string): Promise<MembershipOverride[]> {
    const all = await this.findByMembership(membershipId);
    return all.filter((o) => o.effect === OverrideEffect.DENY);
  }

  /**
   * Get grant permission IDs for a membership
   */
  async getGrantedPermissionIds(membershipId: string): Promise<string[]> {
    const grants = await this.findGrants(membershipId);
    return grants.map((o) => o.permissionId as string);
  }

  /**
   * Get denied permission IDs for a membership
   */
  async getDeniedPermissionIds(membershipId: string): Promise<string[]> {
    const denies = await this.findDenies(membershipId);
    return denies.map((o) => o.permissionId as string);
  }

  /**
   * Set an override for a membership.
   *
   * An upsert on the `(membership_id, permission_id)` natural key (#3375):
   * concurrent calls converge on one row, the last write's effect wins, and
   * an existing override keeps its id.
   */
  async setOverride(
    membershipId: string,
    permissionId: string,
    effect: OverrideEffect,
  ): Promise<MembershipOverride> {
    return await this.create({ membershipId, permissionId, effect });
  }

  /**
   * Remove the override for a membership/permission pair, returning whether
   * one existed. Every row for the pair is removed, so a duplicate left by a
   * deployment that has not yet run `deduplicateAuthorityPairs()` can never
   * keep the override in force.
   */
  async removeOverride(
    membershipId: string,
    permissionId: string,
  ): Promise<boolean> {
    const existing = await this.list({
      where: { membershipId, permissionId },
    });
    for (const override of existing) await override.delete();
    return existing.length > 0;
  }

  /**
   * Grant a permission to a membership
   * Convenience method for setOverride with GRANT effect
   */
  async grantPermission(
    membershipId: string,
    permissionId: string,
  ): Promise<MembershipOverride> {
    return await this.setOverride(
      membershipId,
      permissionId,
      OverrideEffect.GRANT,
    );
  }

  /**
   * Deny a permission for a membership
   * Convenience method for setOverride with DENY effect
   */
  async denyPermission(
    membershipId: string,
    permissionId: string,
  ): Promise<MembershipOverride> {
    return await this.setOverride(
      membershipId,
      permissionId,
      OverrideEffect.DENY,
    );
  }
}
