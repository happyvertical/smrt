/**
 * Reusable billing host glue (#4786): hosted checkout, a verified idempotent
 * webhook, and a customer-portal link, for hosts that sell `SubscriptionPlan`s
 * through Stripe.
 *
 * Every provider call goes through `@happyvertical/accounting` (the
 * {@link BillingProviderPort}); this module owns the trust decisions around
 * it:
 *
 * - **Webhook**: signature and timestamp are checked on the raw body before
 *   anything is parsed; the event id is claimed durably with the subscription
 *   write in one transaction (`runOnce`), so a replay is a 2xx no-op and a
 *   failed apply rolls the claim back for the provider's retry.
 * - **Checkout/portal**: the host authenticates and authorises the caller and
 *   passes the tenant; price, URLs and customer come from server state only.
 * - **Responses and logs** carry fixed messages, ids and reason codes, never
 *   provider text or configuration.
 */
import {
  deriveRunOnceClaimKey,
  digestRunOnceContent,
  isPostgresDatabase,
  RUN_ONCE_CLAIMS_TABLE,
  RunOnceClaimError,
  runOnce,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import { BillingCheckoutSessionCollection } from '../models/BillingCheckoutSession.js';
import type { TenantSubscription } from '../models/TenantSubscription.js';
import {
  type AppliedOutcome,
  applySubscriptionEvent,
  isHeldSubscription,
} from './apply.js';
import {
  CHECKOUT_SESSION_TTL_MS,
  completeBoundCheckout,
  loadFlaggedCheckout,
  METADATA_EXPIRY_KEY,
  parseReconcileContext,
  reconcileFlaggedCheckout,
  recordCheckoutSession,
} from './checkout-sessions.js';
import {
  assertBillingUrl,
  assertWebhookTolerance,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
} from './config.js';
import {
  CHECKOUT_COMPLETED,
  checkoutFactsFromObject,
  SUBSCRIPTION_EVENT_TYPES,
  stripeObject,
  subscriptionSnapshotFromObject,
  subscriptionSnapshotFromState,
} from './events.js';
import { PlanDirectory, priceIdForPlan } from './plans.js';
import {
  checkoutMetadataValid,
  METADATA_PURPOSE,
  safeErrorMessage,
  signCheckoutMetadata,
} from './signing.js';
import {
  type BillingAuth,
  type BillingCheckoutResult,
  type BillingHost,
  BillingHostError,
  type BillingHostOptions,
  type BillingPortalResult,
  type BillingUnreconciledCheckout,
  type BillingWebhookResponse,
} from './types.js';

const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 8 * 1024;
const CLAIM_SCOPE = 'smrt-subscriptions:billing-webhook';
const CHECKOUT_KEY_WINDOW_MS = 10 * 60 * 1000;
const REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;
/** Subscriptions that are still the tenant's live Stripe billing. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/**
 * The `t=` timestamp of a Stripe-Signature header, in seconds. A header with
 * more than one `t=` part is refused: the SDK verifier and this check could
 * otherwise read different ones.
 */
function signatureTimestamp(header: string): number | null {
  let found: number | null = null;
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key !== 't') continue;
    if (found !== null || !value || !/^\d{1,12}$/.test(value)) return null;
    found = Number.parseInt(value, 10);
  }
  return found;
}

/**
 * Read a request body as text, stopping as soon as it exceeds `limit` bytes
 * (a chunked body has no trustworthy Content-Length). Returns null when over.
 */
async function readBoundedText(
  request: Request,
  limit: number,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createBillingHost(options: BillingHostOptions): BillingHost {
  const {
    provider,
    db,
    urls: rawUrls,
    prices,
    canPurchasePlan,
    logger,
  } = options;
  // Held in closures only: the returned host exposes no secret.
  if (
    typeof options.webhookSecret !== 'string' ||
    options.webhookSecret.trim() === ''
  ) {
    throw new Error('A webhook signing secret is required.');
  }
  const webhookSecret = options.webhookSecret.trim();
  const signingSecret = options.metadataSigningSecret?.trim() || webhookSecret;
  // New sessions are signed with one secret; a completed one may verify under
  // it or a retired one, so a rotation does not drop in-flight purchases.
  const verificationSecrets = [
    ...new Set([
      signingSecret,
      ...(options.metadataVerificationSecrets ?? [])
        .map((secret) => secret.trim())
        .filter(Boolean),
    ]),
  ];
  if (typeof db?.transaction !== 'function') {
    throw new Error(
      'The billing host needs a database handle with transaction() support.',
    );
  }
  const toleranceSeconds = assertWebhookTolerance(
    options.webhookToleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  );
  const maxBodyBytes =
    options.maxWebhookBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error('maxWebhookBodyBytes must be a positive integer.');
  }
  const urls = {
    successUrl: assertBillingUrl('successUrl', rawUrls.successUrl),
    cancelUrl: assertBillingUrl('cancelUrl', rawUrls.cancelUrl),
    portalReturnUrl: assertBillingUrl(
      'portalReturnUrl',
      rawUrls.portalReturnUrl,
    ),
  };
  const postgres = isPostgresDatabase(db);
  const tenantPlans = options.tenantPlans ?? 'deny';
  if (tenantPlans !== 'deny' && tenantPlans !== 'allow') {
    throw new Error("tenantPlans must be 'deny' or 'allow'.");
  }
  const claimActor = `billing-webhook:${options.accountKey ?? 'default'}`;

  // -------------------------------------------------------------------------
  // Tenant, plan and subscription reads for checkout and portal
  // -------------------------------------------------------------------------

  function assertTenant(auth: BillingAuth): string {
    const tenantId = auth?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new BillingHostError('invalid_request');
    }
    const ambient = getTenantId();
    if (ambient && ambient !== tenantId) {
      throw new BillingHostError('tenant_mismatch');
    }
    return tenantId;
  }

  async function currentSubscription(
    tenantId: string,
  ): Promise<TenantSubscription | null> {
    return withTenant({ tenantId }, async () => {
      const subscriptions = await TenantSubscriptionCollection.create({ db });
      const rows = await subscriptions.list({
        where: { tenantId, subscriberKind: 'tenant' },
        limit: 1,
      });
      const row = rows[0] ?? null;
      return row && row.tenantId === tenantId ? row : null;
    });
  }

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  async function createCheckout(
    auth: BillingAuth,
    input: { planKey?: string; planId?: string },
  ): Promise<BillingCheckoutResult> {
    const tenantId = assertTenant(auth);
    const planKey = input?.planKey;
    const planId = input?.planId;
    if (
      (planKey === undefined) === (planId === undefined) ||
      (planKey !== undefined && !REF_PATTERN.test(planKey)) ||
      (planId !== undefined && !REF_PATTERN.test(planId))
    ) {
      throw new BillingHostError('invalid_request');
    }
    const email = auth.email?.trim();
    if (email && !EMAIL_PATTERN.test(email)) {
      throw new BillingHostError('invalid_request');
    }

    // Another tenant's plan, an unknown plan and an archived plan all look the
    // same to the caller.
    const plan = await new PlanDirectory(db, prices, tenantPlans).find(
      tenantId,
      {
        planKey,
        planId,
      },
    );
    if (!plan?.isActive()) {
      throw new BillingHostError('plan_unavailable');
    }
    if (
      plan.pricingMode !== 'fixed' ||
      plan.priceAmount <= 0 ||
      (plan.externalProvider && plan.externalProvider !== 'stripe')
    ) {
      throw new BillingHostError('plan_not_purchasable');
    }
    const priceId = priceIdForPlan(plan, prices);
    if (!priceId) throw new BillingHostError('price_unconfigured');

    const current = await currentSubscription(tenantId);
    if (
      current?.stripeSubscriptionId &&
      (LIVE_STATUSES.has(current.status) || isHeldSubscription(current))
    ) {
      throw new BillingHostError('already_subscribed');
    }
    if (canPurchasePlan && !(await canPurchasePlan({ tenantId, plan }))) {
      throw new BillingHostError('plan_forbidden');
    }

    const customerExternalId = current?.stripeCustomerId || undefined;
    const bucket = Math.floor(Date.now() / CHECKOUT_KEY_WINDOW_MS);
    // Same for every request in one idempotency window, so a repeated click
    // sends the provider identical parameters. Signed with the metadata.
    const expiresAt = new Date(
      (bucket + 1) * CHECKOUT_KEY_WINDOW_MS + CHECKOUT_SESSION_TTL_MS,
    );
    const idempotencyKey = `smrt-sub-checkout:${(
      await sha256Hex(
        [
          tenantId,
          String(plan.id),
          priceId,
          customerExternalId ?? email ?? '',
          bucket,
        ].join('|'),
      )
    ).slice(0, 48)}`;

    let session: { externalId: string; url: string | null };
    try {
      session = await provider.billing.createCheckoutSession({
        mode: 'subscription',
        successUrl: urls.successUrl,
        cancelUrl: urls.cancelUrl,
        ...(customerExternalId
          ? { customerExternalId }
          : email
            ? { customerEmail: email }
            : {}),
        clientReferenceId: tenantId,
        lineItems: [{ price: priceId, quantity: 1 }],
        metadata: await signCheckoutMetadata(
          {
            smrt_purpose: METADATA_PURPOSE,
            smrt_tenant_id: tenantId,
            smrt_plan_id: String(plan.id),
            // Bind the server-chosen price and, once known, the billing
            // customer: copied metadata cannot be reused for another price
            // or another customer's subscription.
            smrt_price_id: priceId,
            [METADATA_EXPIRY_KEY]: String(
              Math.floor(expiresAt.getTime() / 1000),
            ),
            ...(customerExternalId
              ? { smrt_customer_id: customerExternalId }
              : {}),
          },
          signingSecret,
        ),
        idempotencyKey,
      });
      if (!session.url) throw new Error('Checkout returned no URL.');
    } catch (error) {
      logger?.error?.('billing.checkout.provider_error', {
        tenantId,
        message: safeErrorMessage(error),
      });
      throw new BillingHostError('provider_error');
    }
    // Record the session before the buyer gets its URL: a failure here
    // propagates, so no session is ever sold that completion cannot match.
    await withSystemContext(() =>
      recordCheckoutSession(db, {
        sessionId: session.externalId,
        tenantId,
        expiresAt,
      }),
    );
    return { url: session.url, sessionId: session.externalId };
  }

  // -------------------------------------------------------------------------
  // Customer portal
  // -------------------------------------------------------------------------

  async function createPortalLink(
    auth: BillingAuth,
  ): Promise<BillingPortalResult> {
    const tenantId = assertTenant(auth);
    // The customer is read from this tenant's own subscription row, never from
    // the request, so a link can only open the caller's own billing account.
    const current = await currentSubscription(tenantId);
    if (!current?.stripeCustomerId) {
      throw new BillingHostError('no_billing_account');
    }
    try {
      const session = await provider.billing.createCustomerPortalSession({
        customerExternalId: current.stripeCustomerId,
        returnUrl: urls.portalReturnUrl,
      });
      if (!session.url) throw new Error('Portal returned no URL.');
      return { url: session.url };
    } catch (error) {
      logger?.error?.('billing.portal.provider_error', {
        tenantId,
        message: safeErrorMessage(error),
      });
      throw new BillingHostError('provider_error');
    }
  }

  // -------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------

  function reject(
    status: number,
    error: string,
    reason: string,
    fields: Record<string, unknown> = {},
  ): BillingWebhookResponse {
    logger?.warn?.('billing.webhook.rejected', { reason, ...fields });
    return { status, body: { received: false, error } };
  }

  async function claimExists(eventId: string): Promise<boolean> {
    const claimKey = deriveRunOnceClaimKey({
      tenantId: CLAIM_SCOPE,
      actor: claimActor,
      token: eventId,
      contentDigest: digestRunOnceContent({ provider: 'stripe' }),
    });
    const row = (await db.get(RUN_ONCE_CLAIMS_TABLE, {
      claim_key: claimKey,
      tenant_id: CLAIM_SCOPE,
    })) as { status?: string } | null;
    return row?.status === 'completed';
  }

  async function handleWebhook(input: {
    payload: string;
    signature: string | null;
  }): Promise<BillingWebhookResponse> {
    const { payload, signature } = input;
    if (typeof payload !== 'string') {
      return reject(400, 'invalid_payload', 'payload_not_text');
    }
    if (encoder.encode(payload).byteLength > maxBodyBytes) {
      return reject(413, 'payload_too_large', 'payload_too_large');
    }
    if (!signature)
      return reject(400, 'invalid_signature', 'missing_signature');

    const timestamp = signatureTimestamp(signature);
    if (timestamp === null) {
      return reject(400, 'invalid_signature', 'malformed_signature');
    }
    const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
    if (ageSeconds > toleranceSeconds) {
      return reject(400, 'invalid_signature', 'timestamp_outside_tolerance');
    }
    let verified = false;
    try {
      verified = provider.webhooks.verify(payload, signature, webhookSecret);
    } catch {
      verified = false;
    }
    if (!verified) return reject(400, 'invalid_signature', 'bad_signature');

    // From here the body is authentic and fresh.
    let event: ReturnType<BillingHostOptions['provider']['webhooks']['parse']>;
    try {
      event = provider.webhooks.parse(payload);
    } catch {
      return reject(400, 'invalid_payload', 'unparseable_payload');
    }
    const eventId = event.id;
    if (!eventId) return reject(400, 'invalid_payload', 'missing_event_id');

    const object = stripeObject(event.payload);
    const eventLog = { eventId, eventType: event.type };
    const ignoredResponse = (reason: string): BillingWebhookResponse => {
      logger?.info?.('billing.webhook.ignored', { ...eventLog, reason });
      return { status: 200, body: { received: true, outcome: 'ignored' } };
    };

    const isSubscriptionEvent = SUBSCRIPTION_EVENT_TYPES.has(event.type);
    if (!isSubscriptionEvent && event.type !== CHECKOUT_COMPLETED) {
      return ignoredResponse('event_type_not_handled');
    }
    if (!object) return ignoredResponse('malformed_object');

    const facts = {
      eventId,
      eventType: event.type,
      eventCreated: event.timestamp,
    };
    try {
      if (await claimExists(eventId)) {
        logger?.info?.('billing.webhook.duplicate', eventLog);
        return { status: 200, body: { received: true, outcome: 'duplicate' } };
      }
      let work: (tx: BillingHostOptions['db']) => Promise<AppliedOutcome>;
      if (isSubscriptionEvent) {
        const snapshot = subscriptionSnapshotFromObject(object, event.type);
        if (!snapshot) return ignoredResponse('malformed_object');
        work = (tx) =>
          applySubscriptionEvent(
            { db: tx, postgres, tenantPlans, prices, logger },
            facts,
            snapshot,
          );
      } else {
        const checkout = checkoutFactsFromObject(object);
        if (checkout?.mode !== 'subscription') {
          return ignoredResponse('not_a_subscription_checkout');
        }
        const { metadata } = checkout;
        if (metadata.smrt_purpose !== METADATA_PURPOSE) {
          // Not one of ours: another integration's session.
          logger?.warn?.('billing.webhook.unsigned_checkout', eventLog);
          return ignoredResponse('checkout_metadata_not_signed');
        }
        let signedByUs = false;
        for (const secret of verificationSecrets) {
          if (await checkoutMetadataValid(metadata, secret)) {
            signedByUs = true;
            break;
          }
        }
        if (!signedByUs) {
          // Claims to be ours but does not verify: a forgery, or a genuine
          // purchase whose signing secret rotated out of the accepted set (it
          // is then paid for and dropped). Loud so an operator sees the second.
          logger?.error?.('billing.webhook.checkout_signature_invalid', {
            ...eventLog,
            sessionId: checkout.sessionId,
          });
          return ignoredResponse('checkout_metadata_not_signed');
        }
        const tenantId = metadata.smrt_tenant_id;
        const planId = metadata.smrt_plan_id;
        if (
          !tenantId ||
          !planId ||
          !checkout.subscriptionId ||
          !checkout.customerId
        ) {
          return ignoredResponse('checkout_incomplete');
        }
        // Read the subscription back (outside the transaction): the row then
        // reflects current provider state however the events were ordered.
        const observedAt = new Date();
        const state = await provider.billing.retrieveSubscriptionStatus(
          checkout.subscriptionId,
        );
        if (
          state.externalId !== checkout.subscriptionId ||
          state.customerExternalId !== checkout.customerId
        ) {
          return ignoredResponse('checkout_subscription_mismatch');
        }
        const snapshot = subscriptionSnapshotFromState(state);
        if (
          !metadata.smrt_price_id ||
          snapshot.priceId !== metadata.smrt_price_id ||
          (metadata.smrt_customer_id &&
            metadata.smrt_customer_id !== checkout.customerId)
        ) {
          // The subscription is not the one this checkout was created for:
          // reused signed metadata, or a price remapped mid-checkout.
          logger?.error?.('billing.checkout.binding_mismatch', {
            ...eventLog,
            subscriptionId: state.externalId,
          });
          return ignoredResponse('checkout_binding_mismatch');
        }
        // Create the table on the base handle, outside the transaction.
        await BillingCheckoutSessionCollection.create({ db });
        work = (tx) =>
          completeBoundCheckout(
            { db: tx, postgres, tenantPlans, prices, logger },
            {
              sessionId: checkout.sessionId,
              tenantId,
              planId,
              exp: metadata[METADATA_EXPIRY_KEY],
              eventId,
              eventTime: event.timestamp,
            },
            { ...facts, observedAt },
            snapshot,
          );
      }

      const outcome = await withSystemContext(() =>
        runOnce(
          {
            db,
            tenantId: CLAIM_SCOPE,
            actor: claimActor,
            token: eventId,
            content: { provider: 'stripe' },
          },
          work,
        ),
      );
      logger?.info?.('billing.webhook.processed', {
        ...eventLog,
        outcome: outcome.action,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });
      return {
        status: 200,
        body: { received: true, outcome: outcome.action },
      };
    } catch (error) {
      if (error instanceof RunOnceClaimError) {
        // The same event is being applied right now; ask for a later retry
        // rather than acknowledge work that may yet fail.
        logger?.warn?.('billing.webhook.in_flight', eventLog);
        return { status: 409, body: { received: false, error: 'in_flight' } };
      }
      logger?.error?.('billing.webhook.failed', {
        ...eventLog,
        message: safeErrorMessage(error),
      });
      // Non-2xx: the provider retries, and the rolled-back claim lets it run.
      return {
        status: 500,
        body: { received: false, error: 'processing_failed' },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Operator reconciliation of paid sessions that could not be bound (#4814)
  // -------------------------------------------------------------------------

  async function listCheckoutsNeedingReconciliation(): Promise<
    BillingUnreconciledCheckout[]
  > {
    return withSystemContext(async () => {
      const sessions = await BillingCheckoutSessionCollection.create({ db });
      const rows = await sessions.list({
        where: { status: 'needs_reconciliation' },
        orderBy: 'created_at ASC',
        limit: 200,
      });
      return rows.map((row) => {
        const flagged = parseReconcileContext(row);
        return {
          sessionId: row.sessionId,
          reason: row.reason,
          claimedTenantId: flagged?.claimedTenantId ?? '',
          subscriptionId: flagged?.subscriptionId ?? '',
          eventId: flagged?.eventId ?? '',
          flaggedAt: new Date(row.updated_at ?? row.created_at ?? Date.now()),
        };
      });
    });
  }

  async function reconcileCheckout(input: {
    sessionId: string;
    tenantId: string;
    planId?: string;
    operatorId: string;
  }): Promise<{ outcome: 'applied' | 'ignored'; reason?: string }> {
    const { sessionId, tenantId, planId, operatorId } = input ?? {};
    if (
      typeof sessionId !== 'string' ||
      !REF_PATTERN.test(sessionId) ||
      typeof tenantId !== 'string' ||
      !REF_PATTERN.test(tenantId) ||
      (planId !== undefined &&
        (typeof planId !== 'string' || !REF_PATTERN.test(planId))) ||
      typeof operatorId !== 'string' ||
      !/^\S{1,128}$/.test(operatorId)
    ) {
      throw new BillingHostError('invalid_request');
    }
    return withSystemContext(async () => {
      const loaded = await loadFlaggedCheckout(db, sessionId);
      if (!loaded) throw new BillingHostError('checkout_not_reconcilable');
      let snapshot: ReturnType<typeof subscriptionSnapshotFromState>;
      try {
        snapshot = subscriptionSnapshotFromState(
          await provider.billing.retrieveSubscriptionStatus(
            loaded.flagged.subscriptionId,
          ),
        );
      } catch (error) {
        logger?.error?.('billing.reconcile.provider_error', {
          sessionId,
          message: safeErrorMessage(error),
        });
        throw new BillingHostError('provider_error');
      }
      const outcome = await db.transaction?.((tx) =>
        reconcileFlaggedCheckout(
          { db: tx, postgres, tenantPlans, prices, logger },
          { sessionId, tenantId, planId, operatorId, snapshot },
        ),
      );
      if (!outcome) throw new BillingHostError('checkout_not_reconcilable');
      return {
        outcome: outcome.action === 'applied' ? 'applied' : 'ignored',
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Fetch-API handlers
  // -------------------------------------------------------------------------

  function errorResponse(error: unknown): Response {
    if (error instanceof BillingHostError) {
      return jsonResponse(error.status, {
        error: error.code,
        message: error.message,
      });
    }
    logger?.error?.('billing.request.failed', {
      message: safeErrorMessage(error),
    });
    return jsonResponse(500, { error: 'internal_error' });
  }

  async function readSmallBody(request: Request): Promise<string> {
    const text = await readBoundedText(request, MAX_REQUEST_BODY_BYTES);
    if (text === null) throw new BillingHostError('invalid_request');
    return text;
  }

  async function readPlanRef(
    request: Request,
  ): Promise<{ planKey?: string; planId?: string }> {
    const type = request.headers.get('content-type') ?? '';
    let values: Record<string, unknown>;
    try {
      if (type.includes('application/json')) {
        const parsed: unknown = JSON.parse(await readSmallBody(request));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        values = parsed as Record<string, unknown>;
      } else {
        const form = new URLSearchParams(await readSmallBody(request));
        values = Object.fromEntries(form.entries());
      }
    } catch (error) {
      if (error instanceof BillingHostError) throw error;
      throw new BillingHostError('invalid_request');
    }
    // Only these two fields are read: a price, amount, tenant or URL sent by
    // the client is ignored.
    const ref: { planKey?: string; planId?: string } = {};
    if (values.planKey !== undefined) {
      if (typeof values.planKey !== 'string') {
        throw new BillingHostError('invalid_request');
      }
      ref.planKey = values.planKey;
    }
    if (values.planId !== undefined) {
      if (typeof values.planId !== 'string') {
        throw new BillingHostError('invalid_request');
      }
      ref.planId = values.planId;
    }
    return ref;
  }

  const handlers: BillingHost['handlers'] = {
    async checkout(request, auth) {
      if (request.method !== 'POST') {
        return jsonResponse(
          405,
          { error: 'method_not_allowed' },
          { allow: 'POST' },
        );
      }
      try {
        return jsonResponse(
          200,
          await createCheckout(auth, await readPlanRef(request)),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },

    async portal(request, auth) {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return jsonResponse(
          405,
          { error: 'method_not_allowed' },
          { allow: 'GET, POST' },
        );
      }
      try {
        return jsonResponse(200, await createPortalLink(auth));
      } catch (error) {
        return errorResponse(error);
      }
    },

    async webhook(request) {
      if (request.method !== 'POST') {
        return jsonResponse(
          405,
          { error: 'method_not_allowed' },
          { allow: 'POST' },
        );
      }
      let payload: string | null;
      try {
        payload = await readBoundedText(request, maxBodyBytes);
      } catch {
        const rejected = reject(400, 'invalid_payload', 'unreadable_body');
        return jsonResponse(rejected.status, rejected.body);
      }
      if (payload === null) {
        const rejected = reject(413, 'payload_too_large', 'payload_too_large');
        return jsonResponse(rejected.status, rejected.body);
      }
      const result = await handleWebhook({
        payload,
        signature: request.headers.get('stripe-signature'),
      });
      return jsonResponse(result.status, result.body);
    },
  };

  return {
    createCheckout,
    createPortalLink,
    listCheckoutsNeedingReconciliation,
    reconcileCheckout,
    handleWebhook,
    handlers,
  };
}
