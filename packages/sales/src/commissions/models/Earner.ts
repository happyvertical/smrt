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
 * `kind` (#3834) distinguishes a `person` (the default) from an
 * `organisation` or a `treasury` account; neither of the latter needs a
 * person Profile. Stripe Connect and crypto payout methods carry a typed
 * {@link PayoutDestination}; this model only records it and never calls a
 * payment provider.
 *
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  EARNER_KINDS,
  type EarnerKind,
  type EarnerOptions,
  type EarnerStatus,
  PAYOUT_METHODS,
  PAYOUT_METHODS_REQUIRING_DESTINATION,
  type PayoutDestination,
  type PayoutMethod,
} from '../types.js';

/**
 * Validate a typed payout destination. Throws on unknown methods, missing
 * or non-string fields, and unexpected properties (so secrets cannot ride
 * along in this public field).
 */
export function validatePayoutDestination(
  destination: PayoutDestination,
): void {
  const value = destination as unknown as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Earner payoutDestination must be an object');
  const requireText = (key: string) => {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim())
      throw new Error(`Earner payoutDestination.${key} is required`);
  };
  let allowed: string[];
  if (value.method === 'stripe_connect') {
    allowed = ['method', 'connectedAccountId'];
    requireText('connectedAccountId');
    if (!/^acct_[A-Za-z0-9]+$/.test(value.connectedAccountId as string))
      throw new Error(
        "Earner payoutDestination.connectedAccountId must be a Stripe connected account id ('acct_…')",
      );
  } else if (value.method === 'crypto') {
    allowed = ['method', 'network', 'asset', 'address', 'memo'];
    requireText('network');
    requireText('asset');
    requireText('address');
    if (value.memo !== undefined && typeof value.memo !== 'string')
      throw new Error('Earner payoutDestination.memo must be a string');
  } else {
    throw new Error(
      `Earner payoutDestination.method must be one of ${PAYOUT_METHODS_REQUIRING_DESTINATION.join(', ')}`,
    );
  }
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(
        `Earner payoutDestination has an unexpected field '${key}'`,
      );
}

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { skipApiCheck: true },
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
   * Party kind: `person` (default), `organisation`, or `treasury`.
   * Organisation and treasury earners need no person Profile.
   */
  kind: EarnerKind = 'person';

  /**
   * Identity link to a smrt-profiles Profile (cross-package string
   * reference — never a DDL foreign key).
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId: string = '';

  /** Human-readable display name for portals and operator views. */
  @field({ description: 'The name this payee is paid under.' })
  displayName: string = '';

  /** Account lifecycle: `pending` (default) → `active` / `suspended`. */
  @field({ description: 'Whether this payee can be paid.' })
  status: EarnerStatus = 'pending';

  /** Preferred payout delivery method. */
  payoutMethod: PayoutMethod = 'bank_transfer';

  /**
   * Typed payout-rail descriptor as a JSON string (`{}` when none). Required
   * for an active earner whose method is `stripe_connect` or `crypto`, and
   * its `method` must match {@link payoutMethod}. Use
   * {@link getPayoutDestination}/{@link setPayoutDestination}.
   */
  payoutDestination: string = '{}';

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
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.displayName !== undefined)
      this.displayName = options.displayName;
    if (options.status !== undefined) this.status = options.status;
    if (options.payoutMethod !== undefined)
      this.payoutMethod = options.payoutMethod;
    if (options.payoutDestination !== undefined)
      this.payoutDestination = options.payoutDestination;
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

  isOrganisation(): boolean {
    return this.kind === 'organisation';
  }

  isTreasury(): boolean {
    return this.kind === 'treasury';
  }

  /** Parse {@link payoutDestination}; `null` when none or unparseable. */
  getPayoutDestination(): PayoutDestination | null {
    try {
      const parsed = JSON.parse(this.payoutDestination || '{}') as unknown;
      return parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length > 0
        ? (parsed as PayoutDestination)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Validate and store a payout destination, and set {@link payoutMethod}
   * to its method. `null` clears it (the method is left unchanged).
   */
  setPayoutDestination(destination: PayoutDestination | null): void {
    if (destination === null) {
      this.payoutDestination = '{}';
      return;
    }
    validatePayoutDestination(destination);
    this.payoutDestination = JSON.stringify(destination);
    this.payoutMethod = destination.method;
  }

  /**
   * Save with field guards: `kind` and `payoutMethod` must be known values,
   * a stored destination must be valid and match `payoutMethod`, and an
   * active Stripe Connect / crypto earner must have a destination.
   */
  override async save(): Promise<this> {
    this.assertPayoutTerms();
    return (await super.save()) as this;
  }

  private assertPayoutTerms(): void {
    const label = `Earner ${this.id ?? '<new>'}`;
    if (!(EARNER_KINDS as readonly string[]).includes(this.kind))
      throw new Error(`${label}: unknown kind '${this.kind}'`);
    if (!(PAYOUT_METHODS as readonly string[]).includes(this.payoutMethod))
      throw new Error(`${label}: unknown payoutMethod '${this.payoutMethod}'`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.payoutDestination || '{}');
    } catch {
      throw new Error(`${label}: payoutDestination must be valid JSON`);
    }
    const hasDestination =
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0;
    if (hasDestination) {
      validatePayoutDestination(parsed as PayoutDestination);
      if ((parsed as PayoutDestination).method !== this.payoutMethod)
        throw new Error(
          `${label}: payoutDestination method '${(parsed as PayoutDestination).method}' does not match payoutMethod '${this.payoutMethod}'`,
        );
    } else if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${label}: payoutDestination must be a JSON object`);
    }
    if (
      this.status === 'active' &&
      !hasDestination &&
      (PAYOUT_METHODS_REQUIRING_DESTINATION as readonly string[]).includes(
        this.payoutMethod,
      )
    )
      throw new Error(
        `${label}: an active ${this.payoutMethod} earner requires a payoutDestination`,
      );
  }
}

export default Earner;
