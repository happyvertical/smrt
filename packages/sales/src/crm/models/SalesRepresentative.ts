/**
 * SalesRepresentative — the sales-rep role model.
 * @packageDocumentation
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  SalesRepresentativeOptions,
  SalesRepresentativeStatus,
} from '../types.js';

/**
 * SalesRepresentative is a ROLE model: it links an identity (smrt-profiles
 * Profile) to sales ownership (Leads/Opportunities reference `ownerRepId`).
 *
 * Roles and money stay separate (see `packages/sales/AGENTS.md` "Roles vs.
 * money"): a rep connects to payouts only through the optional `earnerId`
 * pointing at the commissions module's neutral `Earner`. No referral or
 * commission semantics live on this model.
 *
 * @example
 * ```typescript
 * const reps = await SalesRepresentativeCollection.create({ db });
 * const rep = await reps.create({
 *   profileId: 'profile-uuid',
 *   title: 'Account Executive',
 * });
 * const active = await reps.findActive();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class SalesRepresentative extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global (operator-level) reps.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Identity of the person acting as a rep — cross-package string reference
   * to a smrt-profiles Profile.
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId: string = '';

  /**
   * Optional link to the commissions module's `Earner` (the neutral payout
   * identity). String-form same-package FK: the Earner class lives in
   * `src/commissions` and is intentionally NOT imported here — the string
   * form registers the relationship without a module dependency, keeping the
   * `crm → commissions` boundary reference-only. Empty when the rep is not
   * commission-compensated.
   */
  @foreignKey('Earner')
  earnerId: string = '';

  /** Role status — only `active` reps should receive new assignments. */
  status: SalesRepresentativeStatus = 'active';

  /** Job title shown on CRM surfaces (e.g. `'Account Executive'`). */
  title: string = '';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: SalesRepresentativeOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.earnerId !== undefined) this.earnerId = options.earnerId;
    if (options.status !== undefined) this.status = options.status;
    if (options.title !== undefined) this.title = options.title;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether the rep may receive new lead/opportunity assignments. */
  isActive(): boolean {
    return this.status === 'active';
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

export default SalesRepresentative;
