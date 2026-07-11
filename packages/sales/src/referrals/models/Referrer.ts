/**
 * Referrer — the referral role model.
 * @packageDocumentation
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ReferrerOptions, ReferrerStatus } from '../types.js';

/**
 * Referrer is a ROLE model: it links an identity (smrt-profiles Profile) to
 * referral activity (ReferralLinks, ReferralTouches, and Referrals reference
 * `referrerId`).
 *
 * Roles and money stay separate (see `packages/sales/AGENTS.md` "Roles vs.
 * money"): a referrer connects to payouts only through the optional
 * `earnerId` pointing at the commissions module's neutral `Earner`. A
 * referral cannot produce Commissions until its referrer carries an
 * `earnerId` — `ReferralCommissionService` skips such referrals with reason
 * `'referrer_missing_earner'`.
 *
 * @example
 * ```typescript
 * const referrers = await ReferrerCollection.create({ db });
 * const referrer = await referrers.create({
 *   profileId: 'profile-uuid',
 *   displayName: 'Jordan Partner',
 *   status: 'active',
 * });
 * const active = await referrers.findActive();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Referrer extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation. Nullable to support both
   * tenant-scoped and global (operator-level) referrers.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Identity of the person/organization acting as a referrer —
   * cross-package string reference to a smrt-profiles Profile.
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId: string = '';

  /**
   * Optional link to the commissions module's `Earner` (the neutral payout
   * identity). String-form same-package FK: the Earner class lives in
   * `src/commissions` and is intentionally NOT imported here — the string
   * form registers the relationship without a module dependency, keeping the
   * `referrals → commissions` boundary reference-only at the model layer.
   * Empty when the referrer is not commission-compensated (yet).
   */
  @foreignKey('Earner')
  earnerId: string = '';

  /** Human-readable display name for portals and operator views. */
  displayName: string = '';

  /**
   * Role lifecycle: `pending` (default, awaiting approval) → `active` /
   * `suspended`. Only active referrers should receive new links/agreements.
   */
  status: ReferrerStatus = 'pending';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: ReferrerOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.earnerId !== undefined) this.earnerId = options.earnerId;
    if (options.displayName !== undefined)
      this.displayName = options.displayName;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether the referrer may receive new links/agreements. */
  isActive(): boolean {
    return this.status === 'active';
  }

  isPending(): boolean {
    return this.status === 'pending';
  }

  isSuspended(): boolean {
    return this.status === 'suspended';
  }

  /** Parse the metadata JSON string; returns `{}` on malformed content. */
  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Serialize and store the metadata object. */
  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }
}

export default Referrer;
