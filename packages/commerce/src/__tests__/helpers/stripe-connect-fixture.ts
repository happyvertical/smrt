/**
 * Recorded Stripe Connect fixtures for connected-payments tests (#3831).
 *
 * A real `StripeAdapter` (test key only) talks to this in-memory replay of the
 * Stripe API through its injected `fetch`, so the tests exercise the SDK's own
 * request building, `Stripe-Account` scoping and webhook verification without
 * any network access. Response bodies follow the shapes Stripe returns for
 * Connect Standard accounts, Checkout Sessions and refunds.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { StripeAdapter } from '@happyvertical/payments/stripe';

export const TEST_SECRET_KEY = 'sk_test_fixture_platform_key';
export const PLATFORM_WEBHOOK_SECRET = 'whsec_test_platform_fixture';
export const CONNECT_WEBHOOK_SECRET = 'whsec_test_connect_fixture';

export interface RecordedRequest {
  method: string;
  path: string;
  stripeAccount: string | null;
  idempotencyKey: string | null;
  body: URLSearchParams;
}

interface FixtureAccount {
  id: string;
  charges_enabled: boolean;
  details_submitted: boolean;
  payouts_enabled: boolean;
  capabilities: Record<string, string>;
  metadata: Record<string, string>;
}

interface FixtureSession {
  account: string;
  body: Record<string, unknown>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accountBody(account: FixtureAccount) {
  return {
    id: account.id,
    object: 'account',
    type: 'standard',
    country: 'CA',
    default_currency: 'usd',
    metadata: account.metadata,
    charges_enabled: account.charges_enabled,
    details_submitted: account.details_submitted,
    payouts_enabled: account.payouts_enabled,
    capabilities: account.capabilities,
    requirements: {
      currently_due: account.details_submitted ? [] : ['external_account'],
      eventually_due: [],
      past_due: [],
      disabled_reason: account.charges_enabled ? null : 'requirements.past_due',
    },
  };
}

/** In-memory Stripe API replay plus webhook signing for tests. */
export class StripeConnectFixture {
  readonly requests: RecordedRequest[] = [];
  private readonly accounts = new Map<string, FixtureAccount>();
  private readonly sessions = new Map<string, FixtureSession>();
  private sequence = 0;
  /** Status the next refunds report (`succeeded`, `pending`, …). */
  refundStatus = 'succeeded';
  /** Distinguishes ids across fixtures sharing one PostgreSQL database. */
  readonly run = randomBytes(5).toString('hex');

  private next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(6, '0')}${this.run}`;
  }

  /** A connected account id unique to this fixture. */
  accountId(name: string): string {
    return `acct_${name}${this.run}`;
  }

  /** Register an existing connected account (as if onboarded elsewhere). */
  addAccount(
    id: string,
    enabled = true,
    metadata: Record<string, string> = {},
  ): void {
    this.accounts.set(id, {
      id,
      metadata,
      charges_enabled: enabled,
      details_submitted: enabled,
      payouts_enabled: enabled,
      capabilities: enabled
        ? { card_payments: 'active', transfers: 'active' }
        : {},
    });
  }

  /** Finish onboarding for an account at the provider. */
  enableAccount(id: string): Record<string, unknown> {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`fixture has no account ${id}`);
    account.charges_enabled = true;
    account.details_submitted = true;
    account.payouts_enabled = true;
    account.capabilities = { card_payments: 'active', transfers: 'active' };
    return accountBody(account);
  }

  /** The buyer pays a checkout session. */
  completeSession(sessionId: string): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`fixture has no session ${sessionId}`);
    session.body.status = 'complete';
    session.body.payment_status = 'paid';
    session.body.payment_intent = `pi_${sessionId.slice(3)}`;
    return session.body;
  }

  session(sessionId: string): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`fixture has no session ${sessionId}`);
    return session.body;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body = new URLSearchParams(
      typeof init?.body === 'string' ? init.body : '',
    );
    if (headers.get('Authorization') !== `Bearer ${TEST_SECRET_KEY}`)
      return json(401, { error: { message: 'Invalid API Key provided' } });
    const stripeAccount = headers.get('Stripe-Account');
    this.requests.push({
      method,
      path,
      stripeAccount,
      idempotencyKey: headers.get('Idempotency-Key'),
      body,
    });

    if (method === 'POST' && path === '/accounts') {
      const id = this.next('acct');
      const metadata: Record<string, string> = {};
      for (const [name, value] of body)
        if (name.startsWith('metadata[') && name.endsWith(']'))
          metadata[name.slice(9, -1)] = value;
      this.accounts.set(id, {
        id,
        metadata,
        charges_enabled: false,
        details_submitted: false,
        payouts_enabled: false,
        capabilities: {},
      });
      return json(200, accountBody(this.accounts.get(id)!));
    }
    const accountMatch = /^\/accounts\/([^/]+)$/.exec(path);
    if (method === 'GET' && accountMatch) {
      const account = this.accounts.get(decodeURIComponent(accountMatch[1]!));
      return account
        ? json(200, accountBody(account))
        : json(404, { error: { message: 'No such account' } });
    }
    if (method === 'POST' && path === '/account_links') {
      return json(200, {
        object: 'account_link',
        url: `https://connect.stripe.com/setup/s/${body.get('account')}/fixture`,
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }
    if (method === 'POST' && path === '/checkout/sessions') {
      if (!stripeAccount)
        return json(400, { error: { message: 'platform checkout refused' } });
      const id = this.next('cs_test');
      const session = {
        id,
        object: 'checkout.session',
        url: `https://checkout.stripe.com/c/pay/${id}`,
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: null,
        client_reference_id: body.get('client_reference_id'),
        amount_total: Number(
          body.get('line_items[0][price_data][unit_amount]'),
        ),
        currency: body.get('line_items[0][price_data][currency]'),
        metadata: { quoteId: body.get('metadata[quoteId]') },
      };
      this.sessions.set(id, { account: stripeAccount, body: session });
      return json(200, session);
    }
    const sessionMatch = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (method === 'GET' && sessionMatch) {
      const session = this.sessions.get(decodeURIComponent(sessionMatch[1]!));
      if (!session || session.account !== stripeAccount)
        return json(404, { error: { message: 'No such checkout.session' } });
      return json(200, session.body);
    }
    if (method === 'POST' && path === '/refunds') {
      return json(200, {
        id: this.next('re'),
        object: 'refund',
        status: this.refundStatus,
        amount: Number(body.get('amount')),
        currency: 'usd',
        payment_intent: body.get('payment_intent'),
      });
    }
    return json(404, { error: { message: `fixture has no route ${path}` } });
  };

  /** A platform Stripe adapter backed by this fixture. */
  adapter(): StripeAdapter {
    return new StripeAdapter({
      secretKey: TEST_SECRET_KEY,
      webhookSecret: PLATFORM_WEBHOOK_SECRET,
      connectWebhookSecret: CONNECT_WEBHOOK_SECRET,
      successUrl: 'https://riverbend.example/checkout/done',
      cancelUrl: 'https://riverbend.example/checkout/cancel',
      apiBaseUrl: 'https://api.stripe.test/v1',
      fetch: this.fetch,
    });
  }

  /** Build and sign an event as Stripe delivers it. */
  event(args: {
    type: string;
    object: Record<string, unknown>;
    account?: string;
    id?: string;
    livemode?: boolean;
    created?: number;
    secret?: string;
  }): { payload: string; signature: string; id: string } {
    const id = args.id ?? this.next('evt');
    const payload = JSON.stringify({
      id,
      object: 'event',
      type: args.type,
      livemode: args.livemode ?? false,
      created: args.created ?? Math.floor(Date.now() / 1000),
      ...(args.account ? { account: args.account } : {}),
      data: { object: args.object },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const secret =
      args.secret ??
      (args.account ? CONNECT_WEBHOOK_SECRET : PLATFORM_WEBHOOK_SECRET);
    const digest = createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    return { payload, signature: `t=${timestamp},v1=${digest}`, id };
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }
}
