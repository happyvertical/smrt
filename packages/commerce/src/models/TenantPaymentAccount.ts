/**
 * TenantPaymentAccount — a tenant-owned connected payment account (#3831).
 *
 * The account a tenant (for example a co-op) is paid into: a Stripe Connect
 * Standard account the tenant owns, so its customers' money lands with the
 * tenant and the platform never holds it. Charges for the tenant are direct
 * charges on this account; the platform's share is an application fee.
 *
 * Commands live in `connected-payments.ts`; this model only guards its own
 * identity. See `agents/connected-payments.md`.
 *
 * @packageDocumentation
 */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Which provider mode an account belongs to; test and live never mix. */
export type TenantPaymentEnvironment = 'test' | 'live';

/**
 * Account standing, derived from the provider's capability flags except
 * `disabled`, which only an operator sets.
 *
 * - `pending`: onboarding details not submitted yet.
 * - `restricted`: details submitted, but charges or payouts are off.
 * - `enabled`: charges, details and payouts are all on. Only an enabled
 *   account takes new charges.
 * - `disabled`: switched off by an operator; capability refreshes keep it off.
 */
export type TenantPaymentAccountStatus =
  | 'pending'
  | 'restricted'
  | 'enabled'
  | 'disabled';

/** Capability snapshot kept on the account (no raw provider payload). */
export interface TenantPaymentCapabilitySnapshot {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  capabilities: Record<string, string>;
  requirements: {
    currentlyDue: string[];
    eventuallyDue: string[];
    pastDue: string[];
    disabledReason?: string;
  };
  country?: string;
  defaultCurrency?: string;
}

/** Constructor options for {@link TenantPaymentAccount}. */
export interface TenantPaymentAccountOptions extends SmrtObjectOptions {
  tenantId?: string;
  backendId?: string;
  environment?: TenantPaymentEnvironment;
  providerAccountId?: string;
  feePolicyRef?: string;
}

/**
 * Accounts whose provider account id is being changed by the relink command.
 * Any other change of identity is refused by {@link TenantPaymentAccount.save}.
 */
const relinkInProgress = new WeakSet<TenantPaymentAccount>();

/** Accounts whose status/capabilities are being written by a command. */
const commandWriteInProgress = new WeakSet<TenantPaymentAccount>();

/** @internal Run a status/capability write owned by connected-payments. */
export async function writeTenantPaymentAccount<T>(
  account: TenantPaymentAccount,
  options: { relink?: boolean },
  write: () => Promise<T>,
): Promise<T> {
  commandWriteInProgress.add(account);
  if (options.relink) relinkInProgress.add(account);
  try {
    return await write();
  } finally {
    commandWriteInProgress.delete(account);
    relinkInProgress.delete(account);
  }
}

/** Derive the account status from provider capability flags. */
export function deriveTenantPaymentAccountStatus(snapshot: {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
}): Exclude<TenantPaymentAccountStatus, 'disabled'> {
  if (!snapshot.detailsSubmitted) return 'pending';
  if (snapshot.chargesEnabled && snapshot.payoutsEnabled) return 'enabled';
  return 'restricted';
}

const ENVIRONMENTS: readonly TenantPaymentEnvironment[] = ['test', 'live'];
const STATUSES: readonly TenantPaymentAccountStatus[] = [
  'pending',
  'restricted',
  'enabled',
  'disabled',
];

/**
 * A tenant's connected payment account for one backend and environment.
 *
 * One per `(tenant, backend, environment)`, and a provider account belongs to
 * at most one tenant per backend and environment; both are unique indexes, so
 * the database refuses a second owner even if a command check were bypassed.
 * The generated surface is read-only: accounts are created, relinked,
 * refreshed and disabled only through the connected-payments commands.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tenant_payment_accounts',
  indexes: [
    {
      name: 'tenant_payment_accounts_tenant_backend_environment',
      columns: ['tenantId', 'backendId', 'environment'],
      unique: true,
    },
    {
      name: 'tenant_payment_accounts_provider_account',
      columns: ['backendId', 'environment', 'providerAccountId'],
      unique: true,
    },
  ],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class TenantPaymentAccount extends SmrtObject {
  /** Tenant that owns the account and receives its charges. */
  @tenantId()
  tenantId: string = '';

  /** Payment backend adapter id, for example `stripe`. */
  @field({ required: true })
  backendId: string = 'stripe';

  /** Provider mode: `test` or `live`. */
  @field({ required: true })
  environment: TenantPaymentEnvironment = 'test';

  /** Provider account id, for example a Stripe `acct_...`. */
  @field({ required: true })
  providerAccountId: string = '';

  /** Derived standing; see {@link TenantPaymentAccountStatus}. */
  status: TenantPaymentAccountStatus = 'pending';

  /** Provider `charges_enabled` at the last snapshot. */
  chargesEnabled: boolean = false;

  /** Provider `details_submitted` at the last snapshot. */
  detailsSubmitted: boolean = false;

  /** Provider `payouts_enabled` at the last snapshot. */
  payoutsEnabled: boolean = false;

  /** Capability and requirement snapshot (JSON); read with {@link getCapabilities}. */
  @field({ type: 'text' })
  capabilitiesJson: string = '';

  /** Provider time of the snapshot; older account events never overwrite it. */
  @field({ type: 'datetime', nullable: true })
  capabilitiesObservedAt: Date | null = null;

  /**
   * Reference to the fee policy or agreement that sets the platform's
   * application fee for this tenant. The host resolves it to an amount.
   */
  feePolicyRef: string = '';

  /** When an operator disabled the account. */
  @field({ type: 'datetime', nullable: true })
  disabledAt: Date | null = null;

  /** Why an operator disabled the account. */
  disabledReason: string = '';

  constructor(options: TenantPaymentAccountOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.backendId !== undefined) this.backendId = options.backendId;
    if (options.environment !== undefined)
      this.environment = options.environment;
    if (options.providerAccountId !== undefined)
      this.providerAccountId = options.providerAccountId;
    if (options.feePolicyRef !== undefined)
      this.feePolicyRef = options.feePolicyRef;
  }

  /** Whether the account may take new charges. */
  isEnabled(): boolean {
    return this.status === 'enabled';
  }

  /** The stored capability snapshot, or `null` before the first refresh. */
  getCapabilities(): TenantPaymentCapabilitySnapshot | null {
    if (!this.capabilitiesJson) return null;
    const parsed: unknown = JSON.parse(this.capabilitiesJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('TenantPaymentAccount capabilities snapshot is invalid');
    return parsed as TenantPaymentCapabilitySnapshot;
  }

  /** Store a capability snapshot and re-derive {@link status}. */
  setCapabilities(
    snapshot: TenantPaymentCapabilitySnapshot,
    observedAt: Date,
  ): void {
    const stored: TenantPaymentCapabilitySnapshot = {
      chargesEnabled: snapshot.chargesEnabled === true,
      detailsSubmitted: snapshot.detailsSubmitted === true,
      payoutsEnabled: snapshot.payoutsEnabled === true,
      capabilities: { ...snapshot.capabilities },
      requirements: {
        currentlyDue: [...snapshot.requirements.currentlyDue],
        eventuallyDue: [...snapshot.requirements.eventuallyDue],
        pastDue: [...snapshot.requirements.pastDue],
        ...(snapshot.requirements.disabledReason === undefined
          ? {}
          : { disabledReason: snapshot.requirements.disabledReason }),
      },
      ...(snapshot.country === undefined ? {} : { country: snapshot.country }),
      ...(snapshot.defaultCurrency === undefined
        ? {}
        : { defaultCurrency: snapshot.defaultCurrency }),
    };
    this.capabilitiesJson = JSON.stringify(stored);
    this.chargesEnabled = stored.chargesEnabled;
    this.detailsSubmitted = stored.detailsSubmitted;
    this.payoutsEnabled = stored.payoutsEnabled;
    this.capabilitiesObservedAt = observedAt;
    if (this.status !== 'disabled')
      this.status = deriveTenantPaymentAccountStatus(stored);
  }

  /**
   * Refuses writes outside the connected-payments commands, and any change of
   * tenant, backend or environment. The provider account id changes only
   * through the relink command, which checks ownership first.
   */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!commandWriteInProgress.has(this))
      throw new Error(
        'TenantPaymentAccount is written only by the connected-payments commands',
      );
    if (!this.tenantId)
      throw new Error('TenantPaymentAccount requires a tenant');
    if (!this.backendId)
      throw new Error('TenantPaymentAccount requires a backendId');
    if (!ENVIRONMENTS.includes(this.environment))
      throw new Error('TenantPaymentAccount environment must be test or live');
    if (!STATUSES.includes(this.status))
      throw new Error('TenantPaymentAccount status is invalid');
    if (!this.providerAccountId)
      throw new Error('TenantPaymentAccount requires a providerAccountId');
    if (this.id) {
      const prior = await this.db.get(this.tableName, { id: this.id });
      if (prior) {
        const identity: Array<[string, unknown, unknown]> = [
          ['tenantId', String(prior.tenant_id ?? ''), this.tenantId],
          ['backendId', String(prior.backend_id ?? ''), this.backendId],
          ['environment', String(prior.environment ?? ''), this.environment],
        ];
        for (const [name, before, after] of identity)
          if (String(before).toLowerCase() !== String(after).toLowerCase())
            throw new Error(`TenantPaymentAccount ${name} cannot change`);
        if (
          String(prior.provider_account_id ?? '') !== this.providerAccountId &&
          !relinkInProgress.has(this)
        )
          throw new Error(
            'TenantPaymentAccount providerAccountId changes only through relinkTenantPaymentAccount',
          );
      }
    }
    return super.save(options);
  }
}

export default TenantPaymentAccount;
