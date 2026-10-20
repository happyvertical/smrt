/**
 * Tenant-owned connected payment accounts (#3831).
 *
 * A tenant (for example a co-op) is paid into its own Stripe Connect Standard
 * account: checkouts are direct charges on that account and the platform's
 * share is an application fee, so the platform never holds the tenant's
 * money. These commands are the only writers of {@link TenantPaymentAccount}
 * and of the connected fields on `PaymentIntent` / `Payment`.
 *
 * Every command takes an explicit `tenantId` and checks ownership against it,
 * so a privileged or system caller cannot act on another tenant's account,
 * payment or quote by accident. There is no fallback to the platform account.
 * See `agents/connected-payments.md`.
 *
 * @packageDocumentation
 */

import { PaymentConfigurationError } from '@happyvertical/payments';
import {
  type StripeAdapter,
  StripeAdapter as StripeAdapterClass,
  type StripeAdapterOptions,
  type StripeApplicationFee,
  type StripeConnectAccountStatus,
  type StripeRefundPaymentInput,
} from '@happyvertical/payments/stripe';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { canonicalTenantId, deterministicId, isUuid } from './billing/units.js';
import { PaymentCollection } from './collections/PaymentCollection.js';
import { PaymentIntentCollection } from './collections/PaymentIntentCollection.js';
import { TenantPaymentAccountCollection } from './collections/TenantPaymentAccountCollection.js';
import { withConnectedPaymentAuthority } from './connected-payments-internal.js';
import type { Payment } from './models/Payment.js';
import type { PaymentIntent } from './models/PaymentIntent.js';
import {
  type TenantPaymentAccount,
  type TenantPaymentCapabilitySnapshot,
  type TenantPaymentEnvironment,
  writeTenantPaymentAccount,
} from './models/TenantPaymentAccount.js';
import {
  TenantPaymentWebhookEventCollection,
  type TenantPaymentWebhookOutcome,
} from './models/TenantPaymentWebhookEvent.js';
import {
  PaymentIntentStatus,
  PaymentMethod,
  PaymentStatus,
} from './types/index.js';

/** Default backend id: the payments SDK's Stripe adapter. */
export const CONNECTED_PAYMENTS_DEFAULT_BACKEND = 'stripe';

/**
 * The provider calls connected payments makes. A `StripeAdapter` from
 * `@happyvertical/payments/stripe` satisfies it; build one with
 * {@link createStripeConnectGateway}. It must not be scoped to a connected
 * account: the account is chosen per call from the tenant's record.
 */
export type ConnectedPaymentGateway = Pick<
  StripeAdapter,
  | 'createPaymentOption'
  | 'getStatus'
  | 'refundPayment'
  | 'resolveConnectWebhookEvent'
  | 'createStandardAccount'
  | 'createOnboardingLink'
  | 'getAccountCapabilities'
>;

/** Why a connected-payments command refused. Messages never carry secrets. */
export type ConnectedPaymentErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIGURATION'
  | 'NO_ENABLED_ACCOUNT'
  | 'ACCOUNT_ALREADY_LINKED'
  | 'ACCOUNT_IN_USE'
  | 'ACCOUNT_NOT_OWNED'
  | 'QUOTE_NOT_OWNED'
  | 'QUOTE_CLOSED'
  | 'PAYMENT_NOT_OWNED'
  | 'ENVIRONMENT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'REFUND_EXCEEDS_PAYMENT'
  | 'REFUND_FAILED'
  | 'REFUND_NOT_RECORDED';

/** A refused connected-payments command. */
export class ConnectedPaymentError extends Error {
  readonly code: ConnectedPaymentErrorCode;
  constructor(
    code: ConnectedPaymentErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConnectedPaymentError';
    this.code = code;
  }
}

/** Ledger accounts a tenant's connected payments settle into. */
export interface ConnectedSettlementAccounts {
  ledgerId: string;
  /** Cash/bank account the connected account pays out to (debit). */
  cashAccountId: string;
  /** Receivables account (credit). */
  receivablesAccountId: string;
  /** Expense account for the platform's application fee (debit). */
  applicationFeeAccountId: string;
}

/** Host lookup of a tenant's settlement accounts. */
export type ResolveConnectedSettlementAccounts = (args: {
  tenantId: string;
  currency: string;
}) => ConnectedSettlementAccounts | Promise<ConnectedSettlementAccounts>;

/** Which tenant account a command acts on. */
export interface TenantPaymentAccountKey {
  db: DatabaseInterface;
  tenantId: string;
  environment: TenantPaymentEnvironment;
  /** Defaults to {@link CONNECTED_PAYMENTS_DEFAULT_BACKEND}. */
  backendId?: string;
}

interface ResolvedKey {
  db: DatabaseInterface;
  tenantId: string;
  environment: TenantPaymentEnvironment;
  backendId: string;
}

function invalid(message: string): ConnectedPaymentError {
  return new ConnectedPaymentError('INVALID_INPUT', message);
}

function resolveKey(args: TenantPaymentAccountKey): ResolvedKey {
  if (!args.db) throw invalid('Connected payments require a database');
  if (args.environment !== 'test' && args.environment !== 'live')
    throw invalid('Connected payments environment must be test or live');
  const backendId = args.backendId ?? CONNECTED_PAYMENTS_DEFAULT_BACKEND;
  if (typeof backendId !== 'string' || !backendId.trim())
    throw invalid('Connected payments backendId must be a non-empty string');
  return {
    db: args.db,
    tenantId: canonicalTenantId(args.tenantId),
    environment: args.environment,
    backendId,
  };
}

/** Run a connected-payments command write in the tenant's context. */
function tenantCommand<T>(tenantId: string, operation: () => Promise<T>) {
  return withTenant({ tenantId }, () =>
    withConnectedPaymentAuthority(tenantId, operation),
  );
}

function sameTenant(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b;
}

async function findTenantAccount(
  key: ResolvedKey,
): Promise<TenantPaymentAccount | null> {
  return withTenant({ tenantId: key.tenantId }, async () => {
    const accounts = await TenantPaymentAccountCollection.create({
      db: key.db,
    });
    const account = await accounts.findForTenant(key);
    if (account && !sameTenant(account.tenantId, key.tenantId))
      throw new ConnectedPaymentError(
        'ACCOUNT_NOT_OWNED',
        'Payment account lookup returned another tenant',
      );
    return account;
  });
}

/**
 * The account that owns a provider account id, across tenants. This is the
 * one reviewed cross-tenant read: webhook routing and ownership checks must
 * see every tenant to refuse a second owner.
 */
async function findAccountByProviderAccount(
  db: DatabaseInterface,
  backendId: string,
  environment: TenantPaymentEnvironment,
  providerAccountId: string,
): Promise<TenantPaymentAccount | null> {
  return withSystemContext(async () => {
    const accounts = await TenantPaymentAccountCollection.create({ db });
    const rows = await accounts.list({
      where: { backendId, environment, providerAccountId },
      limit: 2,
    });
    if (rows.length > 1)
      throw new ConnectedPaymentError(
        'ACCOUNT_IN_USE',
        'A provider account is linked to more than one tenant',
      );
    return rows[0] ?? null;
  });
}

function snapshotOf(
  status: StripeConnectAccountStatus,
): TenantPaymentCapabilitySnapshot {
  return {
    chargesEnabled: status.chargesEnabled,
    detailsSubmitted: status.detailsSubmitted,
    payoutsEnabled: status.payoutsEnabled,
    capabilities: status.capabilities,
    requirements: status.requirements,
    ...(status.country === undefined ? {} : { country: status.country }),
    ...(status.defaultCurrency === undefined
      ? {}
      : { defaultCurrency: status.defaultCurrency }),
  };
}

async function assertNotOwnedElsewhere(
  key: ResolvedKey,
  providerAccountId: string,
): Promise<void> {
  const owner = await findAccountByProviderAccount(
    key.db,
    key.backendId,
    key.environment,
    providerAccountId,
  );
  if (owner && !sameTenant(owner.tenantId, key.tenantId))
    throw new ConnectedPaymentError(
      'ACCOUNT_IN_USE',
      'That provider account is linked to another tenant',
    );
}

async function insertAccount(
  key: ResolvedKey,
  providerAccountId: string,
  status: StripeConnectAccountStatus,
  feePolicyRef: string | undefined,
): Promise<TenantPaymentAccount> {
  if (status.accountId !== providerAccountId)
    throw new ConnectedPaymentError(
      'ACCOUNT_NOT_OWNED',
      'Provider returned a different account than requested',
    );
  try {
    return await withTenant({ tenantId: key.tenantId }, async () => {
      const accounts = await TenantPaymentAccountCollection.create({
        db: key.db,
      });
      const account = await accounts.build({
        tenantId: key.tenantId,
        backendId: key.backendId,
        environment: key.environment,
        providerAccountId,
        feePolicyRef: feePolicyRef ?? '',
      });
      account.setCapabilities(snapshotOf(status), new Date());
      await writeTenantPaymentAccount(account, {}, () => account.save());
      return account;
    });
  } catch (error) {
    // A concurrent call for the same tenant may have stored the same account
    // first (the unique indexes refuse the second row): return that one.
    const winner = await findTenantAccount(key);
    if (winner && winner.providerAccountId === providerAccountId) return winner;
    throw error;
  }
}

/**
 * The tenant's payment account for a backend and environment, or `null`.
 *
 * @param args - Database, tenant, environment and optional backend
 * @returns The account or null
 */
export async function getTenantPaymentAccount(
  args: TenantPaymentAccountKey,
): Promise<TenantPaymentAccount | null> {
  return findTenantAccount(resolveKey(args));
}

/**
 * The tenant's enabled payment account. Throws `NO_ENABLED_ACCOUNT` when the
 * tenant has none or it cannot take charges; never falls back to the
 * platform account.
 *
 * @param args - Database, tenant, environment and optional backend
 * @returns The enabled account
 */
export async function requireEnabledTenantPaymentAccount(
  args: TenantPaymentAccountKey,
): Promise<TenantPaymentAccount> {
  const key = resolveKey(args);
  const account = await findTenantAccount(key);
  if (!account)
    throw new ConnectedPaymentError(
      'NO_ENABLED_ACCOUNT',
      `Tenant has no ${key.backendId} payment account for ${key.environment}; connect one before taking payments`,
    );
  if (!account.isEnabled())
    throw new ConnectedPaymentError(
      'NO_ENABLED_ACCOUNT',
      `Tenant's ${key.backendId} payment account for ${key.environment} is ${account.status}; it cannot take payments yet`,
    );
  return account;
}

/** Input to {@link onboardTenantPaymentAccount}. */
export interface OnboardTenantPaymentAccountInput
  extends TenantPaymentAccountKey {
  gateway: ConnectedPaymentGateway;
  /** Two-letter ISO country of the account holder. */
  country?: string;
  /** Prefills the account holder's email in provider onboarding. */
  email?: string;
  businessType?: 'individual' | 'company' | 'non_profit' | 'government_entity';
  feePolicyRef?: string;
}

/**
 * Create the tenant's Standard connected account and store it. Idempotent:
 * a tenant that already has an account gets it back, and the provider call
 * carries a per-tenant idempotency key.
 *
 * @param input - Tenant, environment, gateway and onboarding prefill
 * @returns The tenant's account (usually `pending` until onboarding ends)
 */
export async function onboardTenantPaymentAccount(
  input: OnboardTenantPaymentAccountInput,
): Promise<TenantPaymentAccount> {
  const key = resolveKey(input);
  const existing = await findTenantAccount(key);
  if (existing) return existing;
  const status = await input.gateway.createStandardAccount({
    ...(input.country === undefined ? {} : { country: input.country }),
    ...(input.email === undefined ? {} : { email: input.email }),
    ...(input.businessType === undefined
      ? {}
      : { businessType: input.businessType }),
    metadata: {
      smrt_tenant_id: key.tenantId,
      smrt_environment: key.environment,
    },
    idempotencyKey: `smrt-connect-account:${key.backendId}:${key.environment}:${key.tenantId}`,
  });
  await assertNotOwnedElsewhere(key, status.accountId);
  return insertAccount(key, status.accountId, status, input.feePolicyRef);
}

/** Input to {@link createTenantOnboardingLink}. */
export interface CreateTenantOnboardingLinkInput
  extends TenantPaymentAccountKey {
  gateway: ConnectedPaymentGateway;
  returnUrl: string;
  /** Visited when the link expires or is reused; should mint a new link. */
  refreshUrl: string;
  collect?: 'currently_due' | 'eventually_due';
}

/**
 * A single-use provider onboarding link for the tenant's account. The URL is
 * a bearer secret: redirect to it, never log or store it.
 *
 * @param input - Tenant, environment, gateway and return/refresh URLs
 * @returns The link URL and expiry
 */
export async function createTenantOnboardingLink(
  input: CreateTenantOnboardingLinkInput,
): Promise<{ url: string; expiresAt?: Date }> {
  const key = resolveKey(input);
  const account = await findTenantAccount(key);
  if (!account)
    throw new ConnectedPaymentError(
      'NO_ENABLED_ACCOUNT',
      'Tenant has no payment account to onboard; create one first',
    );
  if (account.status === 'disabled')
    throw new ConnectedPaymentError(
      'NO_ENABLED_ACCOUNT',
      'Tenant payment account is disabled',
    );
  const link = await input.gateway.createOnboardingLink(
    account.providerAccountId,
    input.returnUrl,
    input.refreshUrl,
    input.collect === undefined ? {} : { collect: input.collect },
  );
  return link.expiresAt === undefined
    ? { url: link.url }
    : { url: link.url, expiresAt: link.expiresAt };
}

/** Input to {@link linkTenantPaymentAccount}. */
export interface LinkTenantPaymentAccountInput extends TenantPaymentAccountKey {
  gateway: ConnectedPaymentGateway;
  /** Existing provider account id, for example a Stripe `acct_...`. */
  providerAccountId: string;
  /**
   * Replace the tenant's current account with this one. Open checkouts and
   * refunds on the old account stop working, so this must be explicit.
   */
  replace?: boolean;
  /**
   * The host proved this tenant controls the account (for example through
   * Stripe's OAuth connect flow). Required for an account whose metadata does
   * not already name the tenant; accounts made by
   * {@link onboardTenantPaymentAccount} carry that metadata.
   */
  ownershipVerified?: boolean;
  feePolicyRef?: string;
}

/**
 * Whether provider metadata ties the account to this tenant: `true` when it
 * names the tenant, `false` when it names another tenant or environment,
 * `undefined` when it names none.
 */
function metadataOwner(
  status: StripeConnectAccountStatus,
  key: ResolvedKey,
): boolean | undefined {
  const raw = status.raw;
  const metadata =
    raw && typeof raw === 'object'
      ? (raw as { metadata?: unknown }).metadata
      : undefined;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const { smrt_tenant_id: tenant, smrt_environment: environment } =
    metadata as Record<string, unknown>;
  if (tenant === undefined || tenant === null || tenant === '')
    return undefined;
  return (
    typeof tenant === 'string' &&
    tenant.toLowerCase() === key.tenantId &&
    (environment === undefined || environment === key.environment)
  );
}

/**
 * Link (or, with `replace`, relink) an existing provider account to the
 * tenant. Refused when the account belongs to another tenant, whoever the
 * caller is.
 *
 * @param input - Tenant, environment, gateway and provider account id
 * @returns The tenant's account
 */
export async function linkTenantPaymentAccount(
  input: LinkTenantPaymentAccountInput,
): Promise<TenantPaymentAccount> {
  const key = resolveKey(input);
  if (typeof input.providerAccountId !== 'string')
    throw invalid('providerAccountId must be a string');
  const providerAccountId = input.providerAccountId.trim();
  await assertNotOwnedElsewhere(key, providerAccountId);
  const status = await input.gateway.getAccountCapabilities(providerAccountId);
  // Holding no row today does not make an account free to claim: it must be
  // provably this tenant's (#3831 review).
  const owner = metadataOwner(status, key);
  if (owner === false)
    throw new ConnectedPaymentError(
      'ACCOUNT_IN_USE',
      'That provider account was created for another tenant',
    );
  if (owner === undefined && input.ownershipVerified !== true)
    throw new ConnectedPaymentError(
      'ACCOUNT_NOT_OWNED',
      'The account does not name this tenant; link it only after verifying the tenant controls it (ownershipVerified)',
    );
  const existing = await findTenantAccount(key);
  if (!existing)
    return insertAccount(key, providerAccountId, status, input.feePolicyRef);
  if (
    existing.providerAccountId !== providerAccountId &&
    input.replace !== true
  )
    throw new ConnectedPaymentError(
      'ACCOUNT_ALREADY_LINKED',
      'Tenant already has a payment account for this backend and environment; pass replace to relink',
    );
  const relink = existing.providerAccountId !== providerAccountId;
  return withTenant({ tenantId: key.tenantId }, async () => {
    existing.providerAccountId = providerAccountId;
    if (input.feePolicyRef !== undefined)
      existing.feePolicyRef = input.feePolicyRef;
    existing.setCapabilities(snapshotOf(status), new Date());
    await writeTenantPaymentAccount(existing, { relink }, () =>
      existing.save(),
    );
    return existing;
  });
}

/**
 * Re-read the account's capabilities from the provider and re-derive its
 * status.
 *
 * @param input - Tenant, environment and gateway
 * @returns The refreshed account
 */
export async function refreshTenantPaymentAccount(
  input: TenantPaymentAccountKey & { gateway: ConnectedPaymentGateway },
): Promise<TenantPaymentAccount> {
  const key = resolveKey(input);
  const account = await findTenantAccount(key);
  if (!account)
    throw new ConnectedPaymentError(
      'NO_ENABLED_ACCOUNT',
      'Tenant has no payment account to refresh',
    );
  const status = await input.gateway.getAccountCapabilities(
    account.providerAccountId,
  );
  if (status.accountId !== account.providerAccountId)
    throw new ConnectedPaymentError(
      'ACCOUNT_NOT_OWNED',
      'Provider returned a different account than requested',
    );
  return withTenant({ tenantId: key.tenantId }, async () => {
    account.setCapabilities(snapshotOf(status), new Date());
    await writeTenantPaymentAccount(account, {}, () => account.save());
    return account;
  });
}

/**
 * Switch the tenant's account off (operator action) or back on. A disabled
 * account takes no charges and capability refreshes keep it disabled; when
 * re-enabled its status is re-derived from the last snapshot.
 *
 * @param input - Tenant, environment, the new state and a reason
 * @returns The account
 */
export async function setTenantPaymentAccountDisabled(
  input: TenantPaymentAccountKey & { disabled: boolean; reason?: string },
): Promise<TenantPaymentAccount> {
  const key = resolveKey(input);
  const account = await findTenantAccount(key);
  if (!account)
    throw new ConnectedPaymentError(
      'NO_ENABLED_ACCOUNT',
      'Tenant has no payment account',
    );
  return withTenant({ tenantId: key.tenantId }, async () => {
    if (input.disabled) {
      account.status = 'disabled';
      account.disabledAt = new Date();
      account.disabledReason = input.reason ?? '';
    } else {
      account.status = 'pending';
      account.disabledAt = null;
      account.disabledReason = '';
      const snapshot = account.getCapabilities();
      if (snapshot)
        account.setCapabilities(
          snapshot,
          account.capabilitiesObservedAt ?? new Date(),
        );
    }
    await writeTenantPaymentAccount(account, {}, () => account.save());
    return account;
  });
}

/**
 * Set the fee policy reference the host uses to price the platform's
 * application fee for this tenant.
 *
 * @param input - Tenant, environment and the fee policy reference
 * @returns The account
 */
export async function setTenantPaymentFeePolicy(
  input: TenantPaymentAccountKey & { feePolicyRef: string },
): Promise<TenantPaymentAccount> {
  const key = resolveKey(input);
  const account = await findTenantAccount(key);
  if (!account)
    throw new ConnectedPaymentError(
      'NO_ENABLED_ACCOUNT',
      'Tenant has no payment account',
    );
  return withTenant({ tenantId: key.tenantId }, async () => {
    account.feePolicyRef = input.feePolicyRef;
    await writeTenantPaymentAccount(account, {}, () => account.save());
    return account;
  });
}

/** Input to {@link createConnectedCheckout}. */
export interface CreateConnectedCheckoutInput extends TenantPaymentAccountKey {
  gateway: ConnectedPaymentGateway;
  /** Idempotency scope (see `PaymentIntent.offeringRef`). Required. */
  offeringRef: string;
  /** Buyer email. Required. */
  licenseeEmail: string;
  /** Caller retry key; a retry returns the same intent and checkout. */
  idempotencyKey: string;
  /** Price in integer minor units of `currency`. */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
  /**
   * Platform application fee in integer minor units of `currency`, from the
   * tenant's fee policy or agreement (`account.feePolicyRef`). Required;
   * pass `0` for no fee. Never derive it from a float.
   */
  applicationFeeAmount: number;
  /** Checkout expiry; Stripe accepts 30 minutes to 24 hours. Default 60 minutes. */
  expiresAt?: Date;
  successUrl?: string;
  cancelUrl?: string;
  description?: string;
  skuId?: string;
  customerId?: string;
  /** USD reporting value in cents; defaults to `amount` for USD prices, else 0. */
  usdPriceLocked?: number;
}

/** Result of {@link createConnectedCheckout}. */
export interface ConnectedCheckout {
  intent: PaymentIntent;
  /** Hosted checkout URL to redirect the buyer to. */
  checkoutUrl: string;
  /** Whether this call created the intent (false on an idempotent retry). */
  created: boolean;
  /**
   * The checkout is already paid (`PAID`, `ISSUED` or `RETIRED`): a retry
   * returns it instead of a session, and the host must not charge again.
   * `checkoutUrl` is then empty.
   */
  settled: boolean;
}

const DEFAULT_CHECKOUT_WINDOW_MS = 60 * 60 * 1000;
/**
 * A recorded checkout request is replayed only while its expiry is still
 * acceptable to the provider (Stripe: at least 30 minutes ahead) plus a
 * minute of slack.
 */
const MIN_CHECKOUT_REPLAY_MS = 31 * 60 * 1000;

function assertMinorUnits(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw invalid(
      `${name} must be an integer number of minor units of at least ${min}`,
    );
  return value;
}

/**
 * Create a checkout that charges the tenant's own connected account directly,
 * with the platform's application fee, and record it as a `PaymentIntent`
 * carrying `connectedAccountId` and `applicationFeeCents`. Refuses with
 * `NO_ENABLED_ACCOUNT` when the tenant has no enabled account.
 *
 * @param input - Tenant, price, fee, idempotency natural key and gateway
 * @returns The intent and its hosted checkout URL
 */
export async function createConnectedCheckout(
  input: CreateConnectedCheckoutInput,
): Promise<ConnectedCheckout> {
  const key = resolveKey(input);
  const amount = assertMinorUnits(input.amount, 'amount', 1);
  const fee = assertMinorUnits(
    input.applicationFeeAmount,
    'applicationFeeAmount',
    0,
  );
  if (fee >= amount)
    throw invalid('applicationFeeAmount must be less than the amount');
  if (
    typeof input.currency !== 'string' ||
    !/^[A-Za-z]{3}$/.test(input.currency)
  )
    throw invalid('currency must be an ISO 4217 code');
  const currency = input.currency.toUpperCase();
  for (const [name, value] of [
    ['offeringRef', input.offeringRef],
    ['licenseeEmail', input.licenseeEmail],
    ['idempotencyKey', input.idempotencyKey],
  ] as const)
    if (typeof value !== 'string' || !value.trim())
      throw invalid(`${name} is required for a connected checkout`);
  const usdPriceLocked =
    input.usdPriceLocked === undefined
      ? currency === 'USD'
        ? amount
        : 0
      : assertMinorUnits(input.usdPriceLocked, 'usdPriceLocked', 0);

  const account = await requireEnabledTenantPaymentAccount(key);
  return tenantCommand(key.tenantId, async () => {
    const intents = await PaymentIntentCollection.create({ db: key.db });
    let intent = await intents.findByIdempotencyKey({
      offeringRef: input.offeringRef,
      licenseeEmail: input.licenseeEmail,
      idempotencyKey: input.idempotencyKey,
      tenantId: key.tenantId,
    });
    const reused = !!intent;
    if (intent) {
      if (!sameTenant(intent.tenantId, key.tenantId))
        throw new ConnectedPaymentError(
          'QUOTE_NOT_OWNED',
          'Checkout idempotency lookup returned another tenant',
        );
      const prior = intent.getOption(key.backendId);
      // The same provider account id exists in test and live mode, so the
      // environment is part of the checkout's identity.
      if (
        intent.connectedEnvironment !== key.environment ||
        intent.connectedAccountId !== account.providerAccountId ||
        intent.applicationFeeCents !== fee ||
        intent.connectedAmount !== amount ||
        intent.connectedCurrency !== currency ||
        (prior &&
          (prior.nativeAmount !== amount || prior.currency !== currency))
      )
        throw invalid(
          'idempotencyKey was already used for a different connected checkout',
        );
      // A paid checkout is returned as paid: an idempotent retry (a
      // double-submit, a reload) must never lead to a second charge.
      if (
        intent.status === PaymentIntentStatus.PAID ||
        intent.status === PaymentIntentStatus.ISSUED ||
        intent.status === PaymentIntentStatus.RETIRED
      )
        return { intent, checkoutUrl: '', created: false, settled: true };
      // An unpaid closed quote (expired, cancelled, or with a recorded session
      // whose lock lapsed) never hands out a payable session again.
      if (
        intent.status !== PaymentIntentStatus.AWAITING_PAYMENT ||
        (prior && intent.isExpired())
      )
        throw new ConnectedPaymentError(
          'QUOTE_CLOSED',
          `Checkout was not paid and is ${intent.status === PaymentIntentStatus.AWAITING_PAYMENT ? 'expired' : intent.status}; start a new checkout with a new idempotencyKey`,
        );
      if (prior)
        return {
          intent,
          checkoutUrl: prior.payTo,
          created: false,
          settled: false,
        };
      // The request was recorded but the provider's answer was lost, so the
      // buyer never saw its URL. Re-send it unchanged (same key and expiry)
      // while the provider still accepts that expiry; once it is too close,
      // ask for a fresh session with a renewed expiry (and so a new key) —
      // the unseen one expires unpaid.
      if (
        !intent.priceLockExpiresAt ||
        intent.priceLockExpiresAt.getTime() <
          Date.now() + MIN_CHECKOUT_REPLAY_MS
      ) {
        if (
          input.expiresAt &&
          input.expiresAt.getTime() < Date.now() + MIN_CHECKOUT_REPLAY_MS
        )
          throw invalid(
            'The recorded checkout request is too old to replay; retry with an expiresAt at least 31 minutes ahead (or omit it)',
          );
        const renewed =
          input.expiresAt ?? new Date(Date.now() + DEFAULT_CHECKOUT_WINDOW_MS);
        intent.priceLockExpiresAt = renewed;
        intent.priceLockWindowMs = Math.max(renewed.getTime() - Date.now(), 1);
        await intent.save();
      }
    } else {
      const expiresAt =
        input.expiresAt ?? new Date(Date.now() + DEFAULT_CHECKOUT_WINDOW_MS);
      // Recorded before the provider is asked, so a retry replays the same
      // request; the option naming the provider session is added once, below.
      intent = await intents.create({
        id: await deterministicId([
          'tenant-payment-checkout',
          key.tenantId,
          key.backendId,
          key.environment,
          input.offeringRef,
          input.licenseeEmail,
          input.idempotencyKey,
        ]),
        tenantId: key.tenantId,
        offeringRef: input.offeringRef,
        licenseeEmail: input.licenseeEmail,
        idempotencyKey: input.idempotencyKey,
        skuId: input.skuId ?? '',
        customerId: input.customerId ?? '',
        usdPriceLocked,
        priceLockWindowMs: Math.max(expiresAt.getTime() - Date.now(), 1),
        priceLockExpiresAt: expiresAt,
        connectedAccountId: account.providerAccountId,
        connectedEnvironment: key.environment,
        connectedAmount: amount,
        connectedCurrency: currency,
        applicationFeeCents: fee,
        paymentOptions: [],
      });
    }
    const intentId = intent.id!;
    if (!intent.priceLockExpiresAt)
      throw invalid('Connected checkout has no recorded expiry');
    const option = await input.gateway.createPaymentOption({
      quoteId: intentId,
      amount,
      currency,
      expiresAt: intent.priceLockExpiresAt,
      // The expiry is part of the request, so it is part of the key: a replay
      // of the recorded request reuses it; a renewed request gets a new one.
      idempotencyKey: `smrt-connected-checkout:${intentId}:${intent.priceLockExpiresAt.getTime()}`,
      buyerEmail: input.licenseeEmail,
      stripeAccount: account.providerAccountId,
      ...(fee > 0 ? { applicationFeeAmount: fee } : {}),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(input.successUrl === undefined
        ? {}
        : { successUrl: input.successUrl }),
      ...(input.cancelUrl === undefined ? {} : { cancelUrl: input.cancelUrl }),
    });
    if (
      option.amount !== amount ||
      option.currency !== currency ||
      option.quoteId !== intentId
    )
      throw new ConnectedPaymentError(
        'AMOUNT_MISMATCH',
        'Provider checkout does not match the requested price',
      );
    intent.paymentOptions = [
      {
        backendId: key.backendId,
        currency,
        payTo: option.payTo,
        nativeAmount: amount,
        ...(option.providerPaymentId ? { memo: option.providerPaymentId } : {}),
        expiresAt: option.expiresAt.toISOString(),
      },
    ];
    await intent.save();
    return {
      intent,
      checkoutUrl: option.payTo,
      created: !reused,
      settled: false,
    };
  });
}

/** Input to {@link handleConnectedPaymentWebhook}. */
export interface HandleConnectedPaymentWebhookInput {
  db: DatabaseInterface;
  gateway: ConnectedPaymentGateway;
  environment: TenantPaymentEnvironment;
  backendId?: string;
  /**
   * `connect` (default) for the Connect endpoint; `platform` for the
   * platform endpoint, which carries `application_fee.*` events.
   */
  endpoint?: 'connect' | 'platform';
  /** Raw request body, exactly as received. */
  payload: string;
  /** `Stripe-Signature` header. */
  signature: string | undefined;
  /** Ledger accounts a tenant's settlements post into. */
  resolveSettlementAccounts: ResolveConnectedSettlementAccounts;
}

/** What {@link handleConnectedPaymentWebhook} did. */
export interface ConnectedPaymentWebhookResult {
  outcome: TenantPaymentWebhookOutcome;
  /** True when this event id was already processed. */
  duplicate: boolean;
  eventId: string;
  eventType: string;
  tenantId: string;
  providerAccountId: string;
  paymentIntentId?: string;
  paymentId?: string;
  applicationFee?: Omit<StripeApplicationFee, 'raw'>;
}

function eventCreatedAt(raw: unknown): Date {
  const created =
    raw && typeof raw === 'object'
      ? (raw as { created?: unknown }).created
      : undefined;
  if (typeof created !== 'number' || !Number.isSafeInteger(created))
    throw new ConnectedPaymentError(
      'INVALID_INPUT',
      'Provider event has no creation time',
    );
  return new Date(created * 1000);
}

/**
 * Handle a provider webhook for connected accounts. The SDK verifies the
 * signature before anything is routed; the event's connected account is then
 * mapped to its tenant through {@link TenantPaymentAccount} (an unknown
 * account is rejected with the SDK's `PaymentNotOwnedError`). A payment event
 * settles only a quote that belongs to that tenant and account, after
 * re-reading the checkout from the provider, so delivery order never
 * matters. Processed event ids are stored, so a redelivery is reported as a
 * duplicate across restarts and replicas.
 *
 * Throws on any refusal; respond with a non-2xx status so nothing is
 * acknowledged that was not processed.
 *
 * @param input - Raw delivery, environment, gateway and settlement accounts
 * @returns What was done
 */
export async function handleConnectedPaymentWebhook(
  input: HandleConnectedPaymentWebhookInput,
): Promise<ConnectedPaymentWebhookResult> {
  if (input.environment !== 'test' && input.environment !== 'live')
    throw invalid('Connected payments environment must be test or live');
  const environment = input.environment;
  const backendId = input.backendId ?? CONNECTED_PAYMENTS_DEFAULT_BACKEND;
  const endpoint = input.endpoint ?? 'connect';
  const { db } = input;

  const resolved = await input.gateway.resolveConnectWebhookEvent(
    input.payload,
    input.signature,
    {
      endpoint,
      resolveAccount: (providerAccountId) =>
        findAccountByProviderAccount(
          db,
          backendId,
          environment,
          providerAccountId,
        ),
    },
  );
  const { event, account: providerAccountId, owner } = resolved;
  const raw = event.raw as { livemode?: unknown } | null;
  if (
    typeof raw?.livemode !== 'boolean' ||
    raw.livemode !== (environment === 'live')
  )
    throw new ConnectedPaymentError(
      'ENVIRONMENT_MISMATCH',
      `Provider event is not a ${environment} event`,
    );
  if (
    owner.providerAccountId !== providerAccountId ||
    owner.backendId !== backendId ||
    owner.environment !== environment
  )
    throw new ConnectedPaymentError(
      'ACCOUNT_NOT_OWNED',
      'Resolved payment account does not match the event',
    );
  const tenantId = canonicalTenantId(owner.tenantId);

  const recordId = await deterministicId([
    'tenant-payment-webhook-event',
    backendId,
    environment,
    event.id,
  ]);
  const events = await TenantPaymentWebhookEventCollection.create({ db });
  const seen = await withSystemContext(() => events.get({ id: recordId }));
  const base = {
    eventId: event.id,
    eventType: event.type,
    tenantId,
    providerAccountId,
  };
  if (seen)
    return {
      ...base,
      outcome: seen.outcome,
      duplicate: true,
      ...(seen.paymentIntentId
        ? { paymentIntentId: seen.paymentIntentId }
        : {}),
      // A redelivery still carries the fee, so a host that failed to book it
      // the first time can book it now.
      ...(seen.applicationFeeJson
        ? { applicationFee: JSON.parse(seen.applicationFeeJson) }
        : {}),
    };

  let result: Omit<
    ConnectedPaymentWebhookResult,
    keyof typeof base | 'duplicate'
  >;
  const detail = event.connect;
  if (detail?.type === 'account.updated') {
    result = await applyAccountUpdate(
      db,
      owner,
      tenantId,
      detail.account,
      eventCreatedAt(event.raw),
    );
  } else if (
    detail?.type === 'application_fee.created' ||
    detail?.type === 'application_fee.refunded'
  ) {
    const { raw: _raw, ...applicationFee } = detail.applicationFee;
    result = { outcome: 'application_fee', applicationFee };
  } else if (
    endpoint === 'connect' &&
    (event.type.startsWith('charge.refund.') ||
      event.type.startsWith('refund.'))
  ) {
    result = await applyRefundUpdate({
      db,
      tenantId,
      providerAccountId,
      raw: event.raw,
      resolveSettlementAccounts: input.resolveSettlementAccounts,
    });
  } else if (endpoint === 'connect' && event.quoteId) {
    result = await applyPaymentEvent({
      db,
      gateway: input.gateway,
      backendId,
      tenantId,
      providerAccountId,
      environment,
      quoteId: event.quoteId,
      eventStatus: event.status,
      resolveSettlementAccounts: input.resolveSettlementAccounts,
    });
  } else {
    result = { outcome: 'ignored' };
  }

  await withSystemContext(async () => {
    const record = await events.build({
      id: recordId,
      backendId,
      environment,
      eventId: event.id,
      eventType: event.type,
      endpoint,
      tenantId,
      providerAccountId,
      outcome: result.outcome,
      paymentIntentId: result.paymentIntentId ?? '',
      applicationFeeJson: result.applicationFee
        ? JSON.stringify(result.applicationFee)
        : '',
      processedAt: new Date(),
    });
    await record.save();
  });
  return { ...base, ...result, duplicate: false };
}

async function applyAccountUpdate(
  db: DatabaseInterface,
  owner: TenantPaymentAccount,
  tenantId: string,
  status: StripeConnectAccountStatus,
  observedAt: Date,
): Promise<{ outcome: TenantPaymentWebhookOutcome }> {
  if (status.accountId !== owner.providerAccountId)
    throw new ConnectedPaymentError(
      'ACCOUNT_NOT_OWNED',
      'Account update does not match the routed account',
    );
  return withTenant({ tenantId }, async () => {
    const accounts = await TenantPaymentAccountCollection.create({ db });
    const account = await accounts.get({ id: owner.id! });
    // Reloaded, so a concurrent relink or operator disable is seen: an event
    // for a provider account the row no longer holds is refused, and a
    // write racing this one fails the revision-guarded save below.
    if (
      !account ||
      !sameTenant(account.tenantId, tenantId) ||
      account.providerAccountId !== status.accountId
    )
      throw new ConnectedPaymentError(
        'ACCOUNT_NOT_OWNED',
        'Payment account changed while handling the event',
      );
    // Provider event times have one-second resolution: an event from an
    // earlier second than the snapshot is stale; a tie is applied.
    if (
      account.capabilitiesObservedAt &&
      observedAt.getTime() <
        Math.floor(account.capabilitiesObservedAt.getTime() / 1000) * 1000
    )
      return { outcome: 'stale_account_update' as const };
    account.setCapabilities(snapshotOf(status), observedAt);
    await writeTenantPaymentAccount(account, {}, () => account.save());
    return { outcome: 'account_updated' as const };
  });
}

async function applyPaymentEvent(args: {
  db: DatabaseInterface;
  gateway: ConnectedPaymentGateway;
  backendId: string;
  tenantId: string;
  providerAccountId: string;
  environment: TenantPaymentEnvironment;
  quoteId: string;
  eventStatus: string;
  resolveSettlementAccounts: ResolveConnectedSettlementAccounts;
}): Promise<{
  outcome: TenantPaymentWebhookOutcome;
  paymentIntentId?: string;
  paymentId?: string;
}> {
  const notOwned = () =>
    new ConnectedPaymentError(
      'QUOTE_NOT_OWNED',
      "Event's quote does not belong to the connected account's tenant",
    );
  // The connected account chose quoteId; only a UUID can name our intent.
  if (!isUuid(args.quoteId)) throw notOwned();
  const { db, tenantId } = args;
  return tenantCommand(tenantId, async () => {
    const intents = await PaymentIntentCollection.create({ db });
    const intent = await intents.get({ id: args.quoteId });
    if (
      !intent ||
      !sameTenant(intent.tenantId, tenantId) ||
      intent.connectedAccountId !== args.providerAccountId ||
      intent.connectedEnvironment !== args.environment
    )
      throw notOwned();
    const paymentIntentId = intent.id!;
    if (args.eventStatus === 'refunded')
      return { outcome: 'refund_reported' as const, paymentIntentId };
    if (
      intent.status === PaymentIntentStatus.PAID ||
      intent.status === PaymentIntentStatus.ISSUED ||
      intent.status === PaymentIntentStatus.RETIRED
    )
      return {
        outcome: 'already_settled' as const,
        paymentIntentId,
        paymentId: intent.paymentId,
      };
    const option = intent.getOption(args.backendId);
    if (!option) return { outcome: 'pending' as const, paymentIntentId };
    const status = await args.gateway.getStatus(paymentIntentId, option.payTo, {
      stripeAccount: args.providerAccountId,
      ...(option.memo ? { providerPaymentId: option.memo } : {}),
    });
    // Closed (expired or cancelled) before the provider's confirmation was
    // handled: the money reached the tenant's account, but nothing is posted
    // against a closed quote; an operator reconciles it.
    if (intent.status !== PaymentIntentStatus.AWAITING_PAYMENT)
      return {
        outcome:
          status.status === 'confirmed'
            ? ('late_payment' as const)
            : ('ignored' as const),
        paymentIntentId,
      };
    if (status.status !== 'confirmed')
      return { outcome: 'pending' as const, paymentIntentId };
    if (
      status.receivedAmount !== option.nativeAmount ||
      status.settlementCurrency !== option.currency
    )
      throw new ConnectedPaymentError(
        'AMOUNT_MISMATCH',
        'Provider reports a different amount or currency than the quote',
      );
    if (!status.transactionId)
      throw new ConnectedPaymentError(
        'AMOUNT_MISMATCH',
        'Provider checkout has no payment reference',
      );
    const payment = await settleIntent({
      db,
      intent,
      backendId: args.backendId,
      tenantId,
      amount: option.nativeAmount,
      currency: option.currency,
      transactionId: status.transactionId,
      resolveSettlementAccounts: args.resolveSettlementAccounts,
    });
    return {
      outcome: 'settled' as const,
      paymentIntentId,
      paymentId: payment.id!,
    };
  });
}

async function settleIntent(args: {
  db: DatabaseInterface;
  intent: PaymentIntent;
  backendId: string;
  tenantId: string;
  amount: number;
  currency: string;
  transactionId: string;
  resolveSettlementAccounts: ResolveConnectedSettlementAccounts;
}): Promise<Payment> {
  const { intent } = args;
  const paymentId = await deterministicId([
    'tenant-payment-settlement',
    intent.id!,
  ]);
  const payments = await PaymentCollection.create({ db: args.db });
  let payment = await payments.get({ id: paymentId });
  if (!payment) {
    payment = await payments.create({
      id: paymentId,
      tenantId: args.tenantId,
      kind: 'payment',
      amount: args.amount,
      currency: args.currency,
      method: PaymentMethod.CREDIT_CARD,
      status: PaymentStatus.PENDING,
      transactionId: args.transactionId,
      reference: `connected-checkout:${intent.id}`,
      backendId: args.backendId,
      backendTxRef: args.transactionId,
      connectedAccountId: intent.connectedAccountId,
      applicationFeeCents: intent.applicationFeeCents,
    });
  } else if (
    !sameTenant(payment.tenantId, args.tenantId) ||
    payment.connectedAccountId !== intent.connectedAccountId
  ) {
    throw new ConnectedPaymentError(
      'PAYMENT_NOT_OWNED',
      'Settlement payment belongs to another tenant or account',
    );
  }
  if (payment.status !== PaymentStatus.COMPLETED) {
    const accounts = await args.resolveSettlementAccounts({
      tenantId: args.tenantId,
      currency: args.currency,
    });
    await payment.recordPayment(accounts);
  }
  await intent.verifyAndMarkPaid({
    backendId: args.backendId,
    paymentId: payment.id!,
  });
  await intent.save();
  return payment;
}

/** Input to {@link refundConnectedPayment}. */
export interface RefundConnectedPaymentInput extends TenantPaymentAccountKey {
  gateway: ConnectedPaymentGateway;
  /** The settled connected `Payment` to refund. */
  paymentId: string;
  /** Integer minor units; defaults to everything not yet refunded. */
  amount?: number;
  /**
   * Whether the platform's application fee is refunded too (in proportion,
   * by the provider). Required: the choice is always explicit.
   */
  refundApplicationFee: boolean;
  /** Caller retry key; a retry returns the same refund. */
  idempotencyKey: string;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  resolveSettlementAccounts: ResolveConnectedSettlementAccounts;
}

/** Result of {@link refundConnectedPayment}. */
export interface ConnectedRefund {
  refund: Payment;
  payment: Payment;
  /** Minor units still refundable after this refund. */
  remaining: number;
  /**
   * Provider state: `succeeded` refunds are journaled; `pending` (or
   * `requested`, when the provider's answer was lost) holds its amount and is
   * booked when the provider's refund update arrives; `failed` releases it.
   */
  state: 'requested' | 'pending' | 'succeeded' | 'failed';
  /** Whether this call created the refund (false on an idempotent retry). */
  created: boolean;
}

/**
 * Refund a connected charge on the tenant's own account. Refused when the
 * payment is not the tenant's, or was made on an account the tenant does not
 * hold now — whoever the caller is. A full refund marks the payment
 * `REFUNDED` and retires its intent.
 *
 * @param input - Tenant, payment, amount, fee-refund flag and retry key
 * @returns The refund and remaining refundable amount
 */
export async function refundConnectedPayment(
  input: RefundConnectedPaymentInput,
): Promise<ConnectedRefund> {
  const key = resolveKey(input);
  if (typeof input.refundApplicationFee !== 'boolean')
    throw invalid('refundApplicationFee must be set to true or false');
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim())
    throw invalid('idempotencyKey is required for a refund');
  if (!isUuid(input.paymentId))
    throw new ConnectedPaymentError(
      'PAYMENT_NOT_OWNED',
      'Payment does not belong to this tenant',
    );
  const account = await findTenantAccount(key);
  return tenantCommand(key.tenantId, async () => {
    const payments = await PaymentCollection.create({ db: key.db });
    const payment = await payments.get({ id: input.paymentId });
    if (!payment || !sameTenant(payment.tenantId, key.tenantId))
      throw new ConnectedPaymentError(
        'PAYMENT_NOT_OWNED',
        'Payment does not belong to this tenant',
      );
    if (
      payment.kind !== 'payment' ||
      !payment.connectedAccountId ||
      payment.backendId !== key.backendId
    )
      throw invalid(`Payment is not a connected ${key.backendId} charge`);
    if (!account || account.providerAccountId !== payment.connectedAccountId)
      throw new ConnectedPaymentError(
        'ACCOUNT_NOT_OWNED',
        "Payment was made on an account this tenant does not hold; it can't be refunded here",
      );

    const refundId = await deterministicId([
      'tenant-payment-refund',
      payment.id!,
      input.idempotencyKey,
    ]);
    const settle = (refund: Payment) =>
      finalizeConnectedRefund({
        db: key.db,
        tenantId: key.tenantId,
        payment,
        refund,
        resolveSettlementAccounts: input.resolveSettlementAccounts,
      });
    const outcome = async (
      refund: Payment,
      created: boolean,
    ): Promise<ConnectedRefund> => ({
      refund,
      payment,
      remaining: await settle(refund),
      state: refund.connectedRefundState || 'requested',
      created,
    });

    // The refund row is the request's identity, whatever its status: a retry
    // returns a terminal result and never asks the provider twice.
    let refund = await payments.get({ id: refundId });
    const fresh = !refund;
    if (refund) {
      if (
        !sameTenant(refund.tenantId, key.tenantId) ||
        refund.refundOfPaymentId !== payment.id ||
        refund.connectedAccountId !== payment.connectedAccountId
      )
        throw new ConnectedPaymentError(
          'PAYMENT_NOT_OWNED',
          'Refund does not belong to this payment',
        );
      if (refund.connectedRefundState !== 'requested')
        return outcome(refund, false);
      // A re-sent request must be the original one, or the provider refuses
      // the reused key.
      if (refund.applicationFeeRefunded !== input.refundApplicationFee)
        throw invalid(
          'A retried refund must repeat its original refundApplicationFee',
        );
      // The provider's answer was lost. Re-sending the same idempotency key
      // returns the provider's original refund, but only while the provider
      // still remembers the key; after that, wait for the refund update.
      const age = Date.now() - new Date(refund.created_at ?? 0).getTime();
      if (!(age >= 0 && age < PROVIDER_IDEMPOTENCY_SAFE_MS))
        return outcome(refund, false);
    } else {
      if (payment.status !== PaymentStatus.COMPLETED)
        throw new ConnectedPaymentError(
          'REFUND_EXCEEDS_PAYMENT',
          `Payment is ${payment.status}; only a completed payment can be refunded`,
        );
      const remaining =
        payment.amount -
        (await liveRefunds(payments, payment.id!)).reduce(
          (sum, row) => sum + row.amount,
          0,
        );
      const amount =
        input.amount === undefined
          ? remaining
          : assertMinorUnits(input.amount, 'amount', 1);
      if (amount < 1 || amount > remaining)
        throw new ConnectedPaymentError(
          'REFUND_EXCEEDS_PAYMENT',
          `Refund of ${amount} exceeds the ${remaining} still refundable`,
        );
      // Recorded before the provider is asked: it holds its amount, and a
      // retry or a refund update always finds it.
      refund = await payments.create({
        id: refundId,
        tenantId: key.tenantId,
        kind: 'refund',
        amount,
        currency: payment.currency,
        method: payment.method,
        status: PaymentStatus.PENDING,
        transactionId: payment.backendTxRef,
        reference: `connected-refund:${payment.id}`,
        backendId: key.backendId,
        connectedAccountId: payment.connectedAccountId,
        refundOfPaymentId: payment.id!,
        connectedRefundState: 'requested',
        applicationFeeRefunded: input.refundApplicationFee,
      });
    }

    const request: StripeRefundPaymentInput = {
      paymentId: payment.backendTxRef,
      amount: refund.amount,
      currency: payment.currency,
      stripeAccount: account.providerAccountId,
      refundApplicationFee: input.refundApplicationFee,
      idempotencyKey: `smrt-connected-refund:${refundId}`,
      // Ties provider refund updates to this row (see applyRefundUpdate).
      metadata: { smrt_refund_id: refundId },
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    let result: Awaited<ReturnType<ConnectedPaymentGateway['refundPayment']>>;
    try {
      result = await input.gateway.refundPayment(request);
    } catch (error) {
      // Only a first request the SDK refused before sending provably made no
      // refund: release its amount. Any provider or transport error may have
      // followed a refund (even a 2xx whose body could not be read), so the
      // row stays `requested` until a re-send or the refund update resolves it.
      if (fresh && error instanceof PaymentConfigurationError) {
        refund.connectedRefundState = 'failed';
        refund.status = PaymentStatus.FAILED;
        await refund.save();
        throw new ConnectedPaymentError(
          'REFUND_FAILED',
          'Provider refused the refund',
          { cause: error },
        );
      }
      throw error;
    }
    if (
      (result.amount !== undefined && result.amount !== refund.amount) ||
      !result.refundId
    )
      // Left `requested` (unbooked, amount held) for an operator.
      throw new ConnectedPaymentError(
        'AMOUNT_MISMATCH',
        'Provider refund does not match the requested refund',
      );
    await recordRefundState(
      refund,
      refundState(result.status),
      result.refundId,
    );
    if (refund.connectedRefundState === 'failed')
      throw new ConnectedPaymentError(
        'REFUND_FAILED',
        'Provider declined the refund',
      );
    return outcome(refund, true);
  });
}

/** How long a provider idempotency key is safely remembered (Stripe: 24 h). */
const PROVIDER_IDEMPOTENCY_SAFE_MS = 23 * 60 * 60 * 1000;

/**
 * Move a refund row on from `requested`/`pending`. Terminal states never
 * move back; the provider refund reference is set once.
 */
async function recordRefundState(
  refund: Payment,
  state: 'pending' | 'succeeded' | 'failed',
  providerRefundId: string,
): Promise<void> {
  if (refund.backendTxRef && refund.backendTxRef !== providerRefundId)
    throw new ConnectedPaymentError(
      'PAYMENT_NOT_OWNED',
      'Provider refund does not match the recorded refund',
    );
  const current = refund.connectedRefundState;
  const open = current === 'requested' || current === 'pending';
  const next = open && state !== 'pending' ? state : open ? 'pending' : current;
  if (next === current && refund.backendTxRef === providerRefundId) return;
  refund.backendTxRef = providerRefundId;
  refund.connectedRefundState = next;
  if (next === 'failed') refund.status = PaymentStatus.FAILED;
  await refund.save();
}

function refundState(status: string): 'pending' | 'succeeded' | 'failed' {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'canceled') return 'failed';
  return 'pending';
}

/** Refunds of a payment that hold or used its refundable amount. */
async function liveRefunds(
  payments: PaymentCollection,
  paymentId: string,
): Promise<Payment[]> {
  return (
    await payments.list({
      where: { refundOfPaymentId: paymentId, kind: 'refund' },
    })
  ).filter(
    (row) =>
      row.status !== PaymentStatus.FAILED &&
      row.status !== PaymentStatus.CANCELLED,
  );
}

/**
 * Book a provider-confirmed refund and, once confirmed refunds cover the
 * payment, mark it `REFUNDED` and retire its intent. Every step is idempotent,
 * so a retry or a later provider update resumes where a failure stopped. A
 * refund the provider has not confirmed is never booked.
 *
 * @returns Minor units still refundable
 */
async function finalizeConnectedRefund(args: {
  db: DatabaseInterface;
  tenantId: string;
  payment: Payment;
  refund: Payment;
  resolveSettlementAccounts: ResolveConnectedSettlementAccounts;
}): Promise<number> {
  const { refund, payment } = args;
  if (
    refund.connectedRefundState === 'succeeded' &&
    refund.status === PaymentStatus.PENDING
  )
    await refund.recordRefund(
      await args.resolveSettlementAccounts({
        tenantId: args.tenantId,
        currency: refund.currency,
      }),
    );
  const payments = await PaymentCollection.create({ db: args.db });
  const live = await liveRefunds(payments, payment.id!);
  const booked = live
    .filter((row) => row.status === PaymentStatus.COMPLETED)
    .reduce((sum, row) => sum + row.amount, 0);
  if (booked === payment.amount) {
    if (payment.status === PaymentStatus.COMPLETED) {
      payment.status = PaymentStatus.REFUNDED;
      await payment.save();
    }
    const intents = await PaymentIntentCollection.create({ db: args.db });
    for (const intent of await intents.list({
      where: { paymentId: payment.id! },
    }))
      if (
        sameTenant(intent.tenantId, args.tenantId) &&
        (intent.isPaid() || intent.isIssued())
      ) {
        intent.retire('refunded in full');
        await intent.save();
      }
  }
  return payment.amount - live.reduce((sum, row) => sum + row.amount, 0);
}

/**
 * Apply a provider refund update (`charge.refund.updated`, `refund.*`) to the
 * refund recorded by {@link refundConnectedPayment}: book it once the provider
 * confirms it, release its amount if the provider failed it.
 */
async function applyRefundUpdate(args: {
  db: DatabaseInterface;
  tenantId: string;
  providerAccountId: string;
  raw: unknown;
  resolveSettlementAccounts: ResolveConnectedSettlementAccounts;
}): Promise<{ outcome: TenantPaymentWebhookOutcome; paymentId?: string }> {
  const object =
    args.raw && typeof args.raw === 'object'
      ? (args.raw as { data?: { object?: unknown } }).data?.object
      : undefined;
  const { id, status, amount, metadata } = (object ?? {}) as {
    id?: unknown;
    status?: unknown;
    amount?: unknown;
    metadata?: unknown;
  };
  if (typeof id !== 'string' || !id || typeof status !== 'string')
    return { outcome: 'ignored' };
  const ours =
    metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>).smrt_refund_id
      : undefined;
  return tenantCommand(args.tenantId, async () => {
    const payments = await PaymentCollection.create({ db: args.db });
    const byRef = async () =>
      (
        await payments.list({
          where: {
            backendTxRef: id,
            kind: 'refund',
            connectedAccountId: args.providerAccountId,
          },
          limit: 1,
        })
      )[0] ?? null;
    const refund =
      typeof ours === 'string' && isUuid(ours)
        ? await payments.get({ id: ours })
        : await byRef();
    if (!refund) {
      // Ours, but the row is gone or not visible: refuse so the provider
      // redelivers and an operator sees it.
      if (typeof ours === 'string' && ours)
        throw new ConnectedPaymentError(
          'REFUND_NOT_RECORDED',
          'Refund update names a refund that is not recorded',
        );
      // Refunds made outside these commands are reported, not booked.
      return { outcome: 'refund_reported' as const };
    }
    if (
      !sameTenant(refund.tenantId, args.tenantId) ||
      refund.kind !== 'refund' ||
      refund.connectedAccountId !== args.providerAccountId
    )
      throw new ConnectedPaymentError(
        'PAYMENT_NOT_OWNED',
        'Refund does not belong to the connected account that reported it',
      );
    if (typeof amount === 'number' && amount !== refund.amount)
      throw new ConnectedPaymentError(
        'AMOUNT_MISMATCH',
        'Provider refund amount differs from the recorded refund',
      );
    const source = await payments.get({ id: refund.refundOfPaymentId });
    if (!source || !sameTenant(source.tenantId, args.tenantId))
      throw new ConnectedPaymentError(
        'PAYMENT_NOT_OWNED',
        'Refunded payment does not belong to this tenant',
      );
    await recordRefundState(refund, refundState(status), id);
    if (refund.connectedRefundState === 'succeeded')
      await finalizeConnectedRefund({
        db: args.db,
        tenantId: args.tenantId,
        payment: source,
        refund,
        resolveSettlementAccounts: args.resolveSettlementAccounts,
      });
    return { outcome: 'refund_updated' as const, paymentId: refund.id! };
  });
}

/**
 * Reads installation secrets; `SecretService` from
 * `@happyvertical/smrt-secrets` satisfies it.
 */
export interface ConnectedPaymentSecretReader {
  retrieveForTenant(tenantId: string, name: string): Promise<{ value: string }>;
}

/** Input to {@link createStripeConnectGateway}. */
export interface CreateStripeConnectGatewayInput {
  secrets: ConnectedPaymentSecretReader;
  /** Tenant that holds the installation's (platform) Stripe secrets. */
  secretsTenantId: string;
  environment: TenantPaymentEnvironment;
  /** Override the default secret names (see {@link stripeConnectSecretNames}). */
  secretNames?: Partial<ReturnType<typeof stripeConnectSecretNames>>;
  /** Other adapter options; account scope and secrets are not accepted here. */
  adapterOptions?: Omit<
    StripeAdapterOptions,
    'secretKey' | 'webhookSecret' | 'connectWebhookSecret' | 'stripeAccount'
  >;
}

/**
 * Default smrt-secrets names for an environment's platform Stripe secrets.
 *
 * @param environment - `test` or `live`
 * @returns Secret names for the API key and the two webhook endpoints
 */
export function stripeConnectSecretNames(
  environment: TenantPaymentEnvironment,
) {
  return {
    secretKey: `stripe-connect-${environment}-secret-key`,
    webhookSecret: `stripe-connect-${environment}-webhook-secret`,
    connectWebhookSecret: `stripe-connect-${environment}-connect-webhook-secret`,
  };
}

/**
 * Build the platform's Stripe gateway for connected payments from
 * smrt-secrets. The secret key must be a key of the requested environment.
 * Secret values never appear in errors.
 *
 * @param input - Secret reader, holder tenant, environment and adapter options
 * @returns A `StripeAdapter` for the platform (no account scope)
 */
export async function createStripeConnectGateway(
  input: CreateStripeConnectGatewayInput,
): Promise<StripeAdapter> {
  if (input.environment !== 'test' && input.environment !== 'live')
    throw invalid('Connected payments environment must be test or live');
  const names = {
    ...stripeConnectSecretNames(input.environment),
    ...input.secretNames,
  };
  const holder = canonicalTenantId(input.secretsTenantId);
  const read = async (name: string): Promise<string> => {
    try {
      const { value } = await input.secrets.retrieveForTenant(holder, name);
      if (typeof value !== 'string' || !value) throw new Error('empty secret');
      return value;
    } catch (cause) {
      throw new ConnectedPaymentError(
        'CONFIGURATION',
        `Connected payments secret '${name}' is not available`,
        { cause },
      );
    }
  };
  const secretKey = await read(names.secretKey);
  const prefix = input.environment === 'live' ? '_live_' : '_test_';
  if (!/^(sk|rk)_/.test(secretKey) || !secretKey.slice(2).startsWith(prefix))
    throw new ConnectedPaymentError(
      'CONFIGURATION',
      `Secret '${names.secretKey}' is not a ${input.environment} Stripe key`,
    );
  return new StripeAdapterClass({
    ...input.adapterOptions,
    secretKey,
    webhookSecret: await read(names.webhookSecret),
    connectWebhookSecret: await read(names.connectWebhookSecret),
  });
}
