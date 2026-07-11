/**
 * Earner — neutral financial payout account.
 *
 * Replaces the financial half of legacy smrt-affiliates' `Partner`: it holds
 * everything money-related about a party that earns commissions (payout
 * method, threshold, schedule, currency, status) and NOTHING role-related.
 * Role models (a CRM `SalesRepresentative`, a referrals `Referrer`, or any
 * application-defined role) each hold their own `earnerId` pointing here, so
 * one person acting in several roles still settles through a single account.
 *
 * @packageDocumentation
 */

import { crossPackageRef, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { EarnerOptions, EarnerStatus, PayoutMethod } from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Earner extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation. Nullable so global/operator-level
   * earners remain possible; unlike legacy affiliates, sales earners are
   * tenant-owned by default.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Identity link to a smrt-profiles Profile (cross-package string
   * reference — never a DDL foreign key).
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId: string = '';

  /** Human-readable display name for portals and operator views. */
  displayName: string = '';

  /** Account lifecycle: `pending` (default) → `active` / `suspended`. */
  status: EarnerStatus = 'pending';

  /** Preferred payout delivery method. */
  payoutMethod: PayoutMethod = 'bank_transfer';

  /**
   * Minimum unsettled balance (integer cents) before a payout batch is
   * created. Default $50.00 = 5000 cents.
   */
  payoutThresholdCents: number = 5000;

  /**
   * Payout cadence key. Open string so applications can define their own
   * schedules (`manual`, `monthly`, `weekly`, `net_30`, …); `manual` means
   * an operator triggers batches explicitly.
   */
  payoutScheduleKey: string = 'manual';

  /** ISO 4217 currency all of this earner's balances settle in. */
  currency: string = 'USD';

  /**
   * Additional metadata as a JSON string (tax info, payout-rail details,
   * …). Use {@link getMetadata}/{@link setMetadata}.
   */
  metadata: string = '{}';

  constructor(options: EarnerOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.displayName !== undefined)
      this.displayName = options.displayName;
    if (options.status !== undefined) this.status = options.status;
    if (options.payoutMethod !== undefined)
      this.payoutMethod = options.payoutMethod;
    if (options.payoutThresholdCents !== undefined)
      this.payoutThresholdCents = options.payoutThresholdCents;
    if (options.payoutScheduleKey !== undefined)
      this.payoutScheduleKey = options.payoutScheduleKey;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  isPending(): boolean {
    return this.status === 'pending';
  }

  isSuspended(): boolean {
    return this.status === 'suspended';
  }

  /** Parse {@link metadata}; returns `{}` on empty/invalid JSON. */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      const parsed = JSON.parse(this.metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Serialize and store {@link metadata}. */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data ?? {});
  }
}

export default Earner;
