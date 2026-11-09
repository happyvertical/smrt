/**
 * Types for the billing host glue (#4786).
 *
 * The provider port is structural: `StripeAccountingProvider` from
 * `@happyvertical/accounting` satisfies it (a compile-time test pins that), so
 * this package carries no runtime or type dependency on the SDK. Every
 * provider call goes through that SDK; nothing here talks to Stripe directly.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';

/** A line item priced by a provider price id (never by a client-sent amount). */
export interface BillingCheckoutLineItem {
  price: string;
  quantity: number;
}

export interface BillingCheckoutSessionInput {
  mode?: 'subscription';
  successUrl: string;
  cancelUrl: string;
  customerExternalId?: string;
  customerEmail?: string;
  clientReferenceId?: string;
  lineItems: BillingCheckoutLineItem[];
  metadata: Record<string, string>;
  idempotencyKey?: string;
}

/** The slice of a provider subscription this module reads. */
export interface BillingSubscriptionState {
  externalId: string;
  status: string;
  customerExternalId: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  trialEnd?: Date;
  raw?: unknown;
}

/** A parsed (not yet trusted until `verify` passed) webhook event. */
export interface BillingProviderWebhookEvent {
  id?: string;
  type: string;
  timestamp: Date;
  payload: unknown;
}

/**
 * The provider operations the glue needs. `StripeAccountingProvider` from
 * `@happyvertical/accounting` is assignable to this.
 */
export interface BillingProviderPort {
  readonly webhooks: {
    verify(payload: string, signature: string, secret: string): boolean;
    parse(payload: string): BillingProviderWebhookEvent;
  };
  readonly billing: {
    createCheckoutSession(
      input: BillingCheckoutSessionInput,
    ): Promise<{ externalId: string; url: string | null }>;
    createCustomerPortalSession(input: {
      customerExternalId: string;
      returnUrl: string;
    }): Promise<{ url: string }>;
    retrieveSubscriptionStatus(
      subscriptionExternalId: string,
    ): Promise<BillingSubscriptionState>;
  };
}

/** Fixed, host-configured destinations. Never taken from a request. */
export interface BillingUrls {
  /** Where Checkout sends the buyer after paying. */
  successUrl: string;
  /** Where Checkout sends the buyer when they back out. */
  cancelUrl: string;
  /** Where the customer portal returns to. */
  portalReturnUrl: string;
}

/**
 * Structured, secret-free log sink. Every field passed is safe to persist:
 * event ids, types, tenant ids and reason codes only.
 */
export interface BillingLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
}

export interface BillingPlanPurchaseContext {
  tenantId: string;
  plan: SubscriptionPlan;
}

export interface BillingHostOptions {
  /** The accounting provider (Stripe) from `@happyvertical/accounting`. */
  provider: BillingProviderPort;
  /**
   * Resolved database handle with `transaction()` support (SQLite or
   * PostgreSQL). Event idempotency and the subscription write share one
   * transaction on it. Take it from any collection, for example
   * `(await TenantSubscriptionCollection.create(config)).db`.
   */
  db: DatabaseInterface;
  /** Webhook endpoint signing secret (`whsec_…`). Required, never defaulted. */
  webhookSecret: string;
  /**
   * Secret used to sign new Checkout metadata. Defaults to `webhookSecret`, so
   * rotating the webhook secret also changes it: list the retired secret in
   * `metadataVerificationSecrets` for as long as sessions created under it can
   * still complete, or give the host its own stable secret here.
   */
  metadataSigningSecret?: string;
  /**
   * Retired secrets still accepted when a completed Checkout is verified (never
   * used to sign). Needed across a rotation of the signing secret, otherwise a
   * session paid after the rotation is not trusted and the purchase is dropped.
   */
  metadataVerificationSecrets?: readonly string[];
  /** Maximum webhook signature age in seconds (default 300, at most 900). */
  webhookToleranceSeconds?: number;
  /** Largest accepted webhook body in bytes (default 1 MiB). */
  maxWebhookBodyBytes?: number;
  urls: BillingUrls;
  /**
   * Whether tenant-owned plans (`SubscriptionPlan.tenantId` set) may be sold.
   * Default `deny`: only operator-owned global plans are sold, so a tenant
   * that can write plan rows cannot buy entitlements it defined itself. Use
   * `allow` only when tenants cannot write plans.
   */
  tenantPlans?: 'deny' | 'allow';
  /** Plan key to provider price id. Wins over the plan's own price binding. */
  prices?: Record<string, string>;
  /**
   * Extra purchase policy, evaluated after the built-in checks (plan visible
   * to the tenant, active, fixed price, price configured, tenant not already
   * subscribed). Return false to refuse.
   */
  canPurchasePlan?: (
    context: BillingPlanPurchaseContext,
  ) => boolean | Promise<boolean>;
  /** Namespaces the idempotency claim when several accounts share a database. */
  accountKey?: string;
  logger?: BillingLogger;
}

/** The tenant a host has already authenticated and authorised for billing. */
export interface BillingAuth {
  tenantId: string;
  /** Prefilled on Checkout for a tenant with no billing customer yet. */
  email?: string;
}

export type BillingHostErrorCode =
  | 'invalid_request'
  | 'tenant_mismatch'
  | 'plan_unavailable'
  | 'plan_forbidden'
  | 'plan_not_purchasable'
  | 'price_unconfigured'
  | 'already_subscribed'
  | 'no_billing_account'
  | 'checkout_not_reconcilable'
  | 'provider_error';

const STATUS_BY_CODE: Record<BillingHostErrorCode, number> = {
  invalid_request: 400,
  tenant_mismatch: 403,
  plan_forbidden: 403,
  plan_unavailable: 404,
  plan_not_purchasable: 409,
  already_subscribed: 409,
  no_billing_account: 409,
  checkout_not_reconcilable: 409,
  price_unconfigured: 503,
  provider_error: 502,
};

const MESSAGE_BY_CODE: Record<BillingHostErrorCode, string> = {
  invalid_request: 'The request is not valid.',
  tenant_mismatch: 'The request does not match the signed-in workspace.',
  plan_unavailable: 'That plan is not available.',
  plan_forbidden: 'This workspace cannot buy that plan.',
  plan_not_purchasable: 'That plan cannot be bought online.',
  price_unconfigured: 'Billing is not configured for that plan.',
  already_subscribed:
    'This workspace already has a subscription. Use the billing portal to change it.',
  no_billing_account: 'This workspace has no billing account yet.',
  checkout_not_reconcilable: 'That checkout cannot be reconciled.',
  provider_error: 'The billing provider could not complete the request.',
};

/**
 * A refusal with a stable code and a fixed message. The message never carries
 * provider text, ids or configuration, so it is safe to return to a browser.
 */
export class BillingHostError extends Error {
  readonly code: BillingHostErrorCode;
  readonly status: number;

  constructor(code: BillingHostErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.name = 'BillingHostError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export interface BillingCheckoutResult {
  /** Hosted checkout page to send the buyer to. */
  url: string;
  sessionId: string;
}

export interface BillingPortalResult {
  url: string;
}

export type BillingWebhookOutcome =
  | 'applied'
  | 'ignored'
  | 'duplicate'
  /**
   * A paid first-purchase Checkout could not be tied to a session this host
   * created. It was not linked and not discarded: it is stored for an
   * operator (`listCheckoutsNeedingReconciliation`, `reconcileCheckout`).
   */
  | 'needs_reconciliation';

/** A paid Checkout session waiting for an operator. Ids and codes only. */
export interface BillingUnreconciledCheckout {
  sessionId: string;
  /** `session_record_missing`, `session_record_mismatch` or `session_expired`. */
  reason: string;
  /** The tenant the signed metadata named (not trusted). */
  claimedTenantId: string;
  subscriptionId: string;
  eventId: string;
  flaggedAt: Date;
}

export interface BillingWebhookResponse {
  status: number;
  body: {
    received: boolean;
    outcome?: BillingWebhookOutcome;
    error?: string;
  };
}

export interface BillingHost {
  createCheckout(
    auth: BillingAuth,
    input: { planKey?: string; planId?: string },
  ): Promise<BillingCheckoutResult>;
  createPortalLink(auth: BillingAuth): Promise<BillingPortalResult>;
  /** Paid Checkout sessions flagged `needs_reconciliation`, oldest first. */
  listCheckoutsNeedingReconciliation(): Promise<BillingUnreconciledCheckout[]>;
  /**
   * Operator-only, called by host code that has already authenticated and
   * authorised an operator (never wired to a request handler). Links a flagged
   * paid session to `tenantId` on purpose, once: the subscription is re-read
   * from the provider and must be the one recorded when the session was
   * flagged. `planId` defaults to the plan the signed metadata named. Throws
   * `checkout_not_reconcilable` when the session is not flagged (or was
   * already reconciled); otherwise reports whether the link was `applied` or
   * `ignored` with a reason (for example `already_subscribed`).
   */
  reconcileCheckout(input: {
    sessionId: string;
    tenantId: string;
    planId?: string;
    /** Who is acting; recorded in the audit log. */
    operatorId: string;
  }): Promise<{ outcome: 'applied' | 'ignored'; reason?: string }>;
  handleWebhook(input: {
    payload: string;
    signature: string | null;
  }): Promise<BillingWebhookResponse>;
  /**
   * Fetch-API handlers for any framework (`+server.ts`, Hono, Workers). The
   * host authenticates and authorises the caller first and passes the tenant;
   * checkout and portal never read a tenant, price or URL from the request.
   */
  handlers: {
    checkout(request: Request, auth: BillingAuth): Promise<Response>;
    portal(request: Request, auth: BillingAuth): Promise<Response>;
    webhook(request: Request): Promise<Response>;
  };
}
