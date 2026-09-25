/**
 * An in-memory Stripe REST double for billing tests (#3060).
 *
 * It sits behind the real `@happyvertical/accounting` Stripe provider (via its
 * `fetch` option), so tests exercise the SDK's request encoding, idempotency
 * keys, replay reconciliation, and unit conversion — only the network is fake.
 * It honours `Idempotency-Key` the way Stripe does (same key, same response,
 * no second side effect, and a key reused with other parameters is refused)
 * and models Stripe Tax as a per-country rate on the customer's address.
 * Amounts it stores are in Stripe's unit, like Stripe (#3139).
 */
import { createHmac } from 'node:crypto';
import type { StripeAccountingProvider } from '@happyvertical/accounting';
import { getAccountingProvider } from '@happyvertical/accounting';

export const WEBHOOK_SECRET = 'whsec_test_billing';

interface FakeCustomer {
  id: string;
  created: number;
  name?: string;
  email?: string;
  address?: Record<string, string>;
  tax_exempt?: string;
  default_payment_method?: string;
  metadata: Record<string, string>;
}

interface FakeInvoiceItem {
  id: string;
  customer: string;
  currency: string;
  quantity: number;
  unit_amount: number;
  description: string;
  invoice: string | null;
  metadata: Record<string, string>;
}

interface FakeInvoice {
  id: string;
  customer: string;
  currency: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  collection_method: 'send_invoice' | 'charge_automatically';
  auto_advance: boolean;
  finalized: number;
  due_date: number | null;
  created: number;
  automatic_tax: boolean;
  items: string[];
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  amount_remaining: number;
  metadata: Record<string, string>;
  sent: number;
}

interface FakeSession {
  id: string;
  url: string;
  mode: string;
  currency: string | null;
  amount_subtotal: number | null;
  amount_tax: number;
  amount_total: number | null;
  customer: string | null;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  automatic_tax: boolean;
  customer_update_address: boolean;
  billing_address_collection: string | null;
  setup_future_usage: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
}

/** How a saved payment method answers an off-session charge. */
export type FakeCardBehavior =
  | 'succeed'
  | 'processing'
  | 'decline'
  | 'authentication_required';

interface FakePaymentIntent {
  id: string;
  object: 'payment_intent';
  created: number;
  amount: number;
  currency: string;
  customer: string;
  payment_method: string;
  status: string;
  last_payment_error: Record<string, string> | null;
  metadata: Record<string, string>;
}

type Failure = {
  method: string;
  path: RegExp;
  /** `before`: reject without side effect; `after`: apply, then reject. */
  when: 'before' | 'after';
  remaining: number;
};

/** Tax rates by customer country, standing in for Stripe Tax. */
const TAX_RATES: Record<string, number> = { CA: 0.13, US: 0.05 };

function parseForm(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body).entries()) {
    const parts = key.replace(/\]/g, '').split('[');
    let cursor = result as Record<string, unknown>;
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1) {
        cursor[part] = value;
      } else {
        cursor[part] = (cursor[part] as Record<string, unknown>) ?? {};
        cursor = cursor[part] as Record<string, unknown>;
      }
    }
  }
  return result;
}

/** The value of a `metadata['<key>']:'<value>'` search query. */
function metadataQuery(url: URL, key: string): string | undefined {
  const query = url.searchParams.get('query') ?? '';
  const match = query.match(new RegExp(`^metadata\\['${key}'\\]:'(.*)'$`));
  return match?.[1]?.replace(/\\'/g, "'");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class FakeStripe {
  readonly customers = new Map<string, FakeCustomer>();
  readonly invoiceItems = new Map<string, FakeInvoiceItem>();
  readonly invoices = new Map<string, FakeInvoice>();
  readonly sessions = new Map<string, FakeSession>();
  readonly paymentIntents = new Map<string, FakePaymentIntent>();
  /** False while Stripe's search index lags behind writes. */
  searchable = true;
  /** Behavior of each saved payment method (default `succeed`). */
  readonly cards = new Map<string, FakeCardBehavior>();
  readonly subscriptions = new Map<string, Record<string, unknown>>();
  readonly requests: Array<{ method: string; path: string; key?: string }> = [];
  private readonly idempotent = new Map<
    string,
    { status: number; body: unknown; params: string }
  >();
  private failures: Failure[] = [];
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(6, '0')}`;
  }

  /** Make the next matching request(s) fail. */
  fail(
    method: string,
    path: RegExp,
    when: 'before' | 'after' = 'before',
    times = 1,
  ): void {
    this.failures.push({ method, path, when, remaining: times });
  }

  provider(): Promise<StripeAccountingProvider> {
    return getAccountingProvider({
      type: 'stripe',
      secretKey: 'sk_test_fake',
      apiBaseUrl: 'https://stripe.test',
      webhookSecret: WEBHOOK_SECRET,
      maxRetries: 1,
      fetch: this.fetch,
    }) as Promise<StripeAccountingProvider>;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const key = headers.get('Idempotency-Key') ?? undefined;
    this.requests.push({ method, path: url.pathname, key });

    const failure = this.failures.find(
      (entry) =>
        entry.remaining > 0 &&
        entry.method === method &&
        entry.path.test(url.pathname),
    );
    if (failure?.when === 'before') {
      failure.remaining -= 1;
      return json(400, { error: { message: 'injected failure (before)' } });
    }
    const replayKey = key ? `${method} ${url.pathname} ${key}` : undefined;
    const params = typeof init?.body === 'string' ? init.body : '';
    if (replayKey && this.idempotent.has(replayKey)) {
      const stored = this.idempotent.get(replayKey);
      if (stored?.params !== params) {
        // Stripe refuses a key reused with different parameters.
        return json(400, {
          error: {
            type: 'idempotency_error',
            message:
              'Keys for idempotent requests can only be used with the same parameters they were first used with.',
          },
        });
      }
      return json(stored?.status ?? 200, stored?.body);
    }
    const body =
      typeof init?.body === 'string' ? parseForm(init.body) : ({} as never);
    const result = this.route(method, url, body);
    // Stripe saves the result of an idempotent request that ran, including a
    // card decline (the PaymentIntent exists); a request refused before it
    // ran (validation) is not saved.
    if (replayKey && (result.status < 300 || result.status === 402)) {
      this.idempotent.set(replayKey, { ...result, params });
    }
    if (failure?.when === 'after') {
      failure.remaining -= 1;
      return json(400, { error: { message: 'injected failure (after)' } });
    }
    return json(result.status, result.body);
  };

  private route(
    method: string,
    url: URL,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } {
    const path = url.pathname;
    let match: RegExpMatchArray | null;
    if (method === 'POST' && path === '/v1/customers') {
      const customer: FakeCustomer = {
        id: this.nextId('cus'),
        created: this.counter,
        metadata: {},
      };
      this.applyCustomer(customer, body);
      this.customers.set(customer.id, customer);
      return { status: 200, body: this.customerView(customer) };
    }
    if (method === 'GET' && path === '/v1/customers/search') {
      const wanted = metadataQuery(url, 'local_id');
      const data = [...this.customers.values()]
        .filter(
          (customer) =>
            this.searchable && customer.metadata.local_id === wanted,
        )
        .map((customer) => this.customerView(customer));
      return {
        status: 200,
        body: { object: 'search_result', data, has_more: false },
      };
    }
    match = path.match(/^\/v1\/customers\/([^/]+)$/);
    if (match) {
      const customer = this.customers.get(match[1]);
      if (!customer) return { status: 404, body: { error: {} } };
      if (method === 'POST') this.applyCustomer(customer, body);
      return { status: 200, body: this.customerView(customer) };
    }
    if (method === 'POST' && path === '/v1/invoiceitems') {
      const item: FakeInvoiceItem = {
        id: this.nextId('ii'),
        customer: String(body.customer),
        currency: String(body.currency),
        quantity: Number(body.quantity ?? 1),
        unit_amount: Number(body.unit_amount_decimal),
        description: String(body.description ?? ''),
        invoice: null,
        metadata: (body.metadata as Record<string, string>) ?? {},
      };
      this.invoiceItems.set(item.id, item);
      return { status: 200, body: item };
    }
    if (method === 'GET' && path === '/v1/invoiceitems') {
      const customer = url.searchParams.get('customer');
      const pending = url.searchParams.get('pending') === 'true';
      const data = [...this.invoiceItems.values()].filter(
        (item) =>
          item.customer === customer && (!pending || item.invoice === null),
      );
      return { status: 200, body: { object: 'list', data, has_more: false } };
    }
    if (method === 'POST' && path === '/v1/invoices') {
      const customer = String(body.customer);
      const items = [...this.invoiceItems.values()].filter(
        (item) => item.customer === customer && item.invoice === null,
      );
      const collection =
        body.collection_method === 'charge_automatically'
          ? 'charge_automatically'
          : 'send_invoice';
      const invoice: FakeInvoice = {
        id: this.nextId('in'),
        customer,
        currency: items[0]?.currency ?? 'usd',
        status: 'draft',
        collection_method: collection,
        auto_advance: body.auto_advance === 'true',
        finalized: 0,
        due_date: body.due_date ? Number(body.due_date) : null,
        created: Math.floor(Date.now() / 1000),
        automatic_tax:
          (body.automatic_tax as Record<string, string> | undefined)
            ?.enabled === 'true',
        items: items.map((item) => item.id),
        subtotal: 0,
        tax: 0,
        total: 0,
        amount_paid: 0,
        amount_remaining: 0,
        metadata: (body.metadata as Record<string, string>) ?? {},
        sent: 0,
      };
      for (const item of items) item.invoice = invoice.id;
      this.recalculate(invoice);
      this.invoices.set(invoice.id, invoice);
      return { status: 200, body: this.view(invoice) };
    }
    if (method === 'GET' && path === '/v1/invoices') {
      const customer = url.searchParams.get('customer');
      const data = [...this.invoices.values()]
        .filter((invoice) => invoice.customer === customer)
        .map((invoice) => this.view(invoice));
      return { status: 200, body: { object: 'list', data, has_more: false } };
    }
    match = path.match(/^\/v1\/invoices\/([^/]+)\/(send|finalize)$/);
    if (match) {
      const invoice = this.invoices.get(match[1]);
      if (!invoice) return { status: 404, body: { error: {} } };
      if (match[2] === 'finalize') {
        if (invoice.collection_method !== 'charge_automatically') {
          return { status: 400, body: { error: { message: 'not auto' } } };
        }
        invoice.finalized += 1;
        invoice.auto_advance = body.auto_advance === 'true';
      } else if (invoice.collection_method !== 'send_invoice') {
        return {
          status: 400,
          body: {
            error: {
              message:
                'You can only manually send an invoice if its collection method is send_invoice.',
            },
          },
        };
      }
      if (invoice.status === 'draft') {
        if (invoice.automatic_tax) {
          const customer = this.customers.get(invoice.customer);
          if (!customer?.address?.country) {
            return {
              status: 400,
              body: { error: { code: 'customer_tax_location_invalid' } },
            };
          }
        }
        this.recalculate(invoice);
        invoice.status = invoice.total === 0 ? 'paid' : 'open';
      }
      if (match[2] === 'send') invoice.sent += 1;
      return { status: 200, body: this.view(invoice) };
    }
    match = path.match(/^\/v1\/invoices\/([^/]+)\/mark_uncollectible$/);
    if (match && method === 'POST') {
      const invoice = this.invoices.get(match[1]);
      if (!invoice) return { status: 404, body: { error: {} } };
      if (invoice.status !== 'open' && invoice.status !== 'uncollectible') {
        return { status: 400, body: { error: { message: 'not open' } } };
      }
      invoice.status = 'uncollectible';
      return { status: 200, body: this.view(invoice) };
    }
    match = path.match(/^\/v1\/invoices\/([^/]+)$/);
    if (match) {
      const invoice = this.invoices.get(match[1]);
      if (!invoice) return { status: 404, body: { error: {} } };
      if (method === 'POST' && body.auto_advance !== undefined) {
        invoice.auto_advance = body.auto_advance === 'true';
      }
      return { status: 200, body: this.view(invoice) };
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const lineItems = body.line_items as
        | Record<
            string,
            {
              price_data: { currency: string; unit_amount: string };
              quantity: string;
            }
          >
        | undefined;
      const line = lineItems?.['0'];
      const mode = String(body.mode);
      if (mode === 'setup' ? line || !body.currency : !line) {
        return { status: 400, body: { error: { message: 'bad session' } } };
      }
      const automaticTax =
        (body.automatic_tax as Record<string, string> | undefined)?.enabled ===
        'true';
      const customerUpdate = body.customer_update as
        | Record<string, string>
        | undefined;
      const paymentIntentData = body.payment_intent_data as
        | Record<string, string>
        | undefined;
      const subtotal = line
        ? Number(line.price_data.unit_amount) * Number(line.quantity ?? 1)
        : null;
      const session: FakeSession = {
        id: this.nextId('cs'),
        url: 'https://checkout.stripe.test/session',
        mode,
        currency: line ? line.price_data.currency : String(body.currency),
        amount_subtotal: subtotal,
        amount_tax: 0,
        amount_total: subtotal,
        customer: body.customer ? String(body.customer) : null,
        status: 'open',
        payment_status: mode === 'setup' ? 'no_payment_required' : 'unpaid',
        automatic_tax: automaticTax,
        customer_update_address: customerUpdate?.address === 'auto',
        billing_address_collection: body.billing_address_collection
          ? String(body.billing_address_collection)
          : null,
        setup_future_usage: paymentIntentData?.setup_future_usage ?? null,
        payment_method: null,
        // Stripe treats an empty metadata value as unset.
        metadata: Object.fromEntries(
          Object.entries(
            (body.metadata as Record<string, string>) ?? {},
          ).filter(([, value]) => value !== ''),
        ),
      };
      this.sessions.set(session.id, session);
      return { status: 200, body: this.sessionView(session) };
    }
    match = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (match && method === 'GET') {
      const session = this.sessions.get(match[1]);
      if (!session) return { status: 404, body: { error: {} } };
      return { status: 200, body: this.sessionView(session, true) };
    }
    if (method === 'GET' && path === '/v1/payment_intents/search') {
      const wanted = metadataQuery(url, 'hv_charge_key');
      const data = [...this.paymentIntents.values()].filter(
        (intent) => this.searchable && intent.metadata.hv_charge_key === wanted,
      );
      return {
        status: 200,
        body: { object: 'search_result', data, has_more: false },
      };
    }
    if (method === 'POST' && path === '/v1/payment_intents') {
      return this.createPaymentIntent(body);
    }
    match = path.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (match) {
      const subscription = this.subscriptions.get(match[1]);
      if (!subscription) return { status: 404, body: { error: {} } };
      return { status: 200, body: subscription };
    }
    return { status: 404, body: { error: { message: `${method} ${path}` } } };
  }

  private applyCustomer(
    customer: FakeCustomer,
    body: Record<string, unknown>,
  ): void {
    if (body.name !== undefined) customer.name = String(body.name);
    if (body.email !== undefined) customer.email = String(body.email);
    if (body.address) {
      customer.address = body.address as Record<string, string>;
    }
    if (body.tax_exempt !== undefined) {
      customer.tax_exempt = String(body.tax_exempt);
    }
    const settings = body.invoice_settings as
      | Record<string, string>
      | undefined;
    if (settings?.default_payment_method) {
      customer.default_payment_method = settings.default_payment_method;
    }
    customer.metadata = {
      ...customer.metadata,
      ...((body.metadata as Record<string, string>) ?? {}),
    };
  }

  private recalculate(invoice: FakeInvoice): void {
    invoice.subtotal = invoice.items.reduce((sum, id) => {
      const item = this.invoiceItems.get(id);
      return sum + (item ? item.unit_amount * item.quantity : 0);
    }, 0);
    const customer = this.customers.get(invoice.customer);
    const exempt = customer?.tax_exempt === 'exempt';
    const rate =
      invoice.automatic_tax && !exempt
        ? (TAX_RATES[customer?.address?.country ?? ''] ?? 0)
        : 0;
    invoice.tax = Math.round(invoice.subtotal * rate);
    invoice.total = invoice.subtotal + invoice.tax;
    invoice.amount_remaining = invoice.total - invoice.amount_paid;
  }

  private customerView(customer: FakeCustomer): Record<string, unknown> {
    const { default_payment_method: method, ...rest } = customer;
    return {
      ...rest,
      object: 'customer',
      invoice_settings: { default_payment_method: method ?? null },
    };
  }

  private sessionView(
    session: FakeSession,
    expand = false,
  ): Record<string, unknown> {
    const intent = session.payment_method
      ? { id: `${session.id}_intent`, payment_method: session.payment_method }
      : null;
    return {
      id: session.id,
      object: 'checkout.session',
      url: session.url,
      mode: session.mode,
      status: session.status,
      payment_status: session.payment_status,
      currency: session.currency,
      customer: session.customer,
      amount_subtotal: session.amount_subtotal,
      amount_total: session.amount_total,
      total_details: { amount_tax: session.amount_tax },
      metadata: session.metadata,
      ...(session.mode === 'setup'
        ? { setup_intent: expand ? intent : (intent?.id ?? null) }
        : { payment_intent: expand ? intent : (intent?.id ?? null) }),
    };
  }

  private view(invoice: FakeInvoice): Record<string, unknown> {
    return {
      id: invoice.id,
      object: 'invoice',
      collection_method: invoice.collection_method,
      auto_advance: invoice.auto_advance,
      number: `FAKE-${invoice.id}`,
      customer: invoice.customer,
      created: invoice.created,
      due_date: invoice.due_date,
      subtotal: invoice.subtotal,
      tax: invoice.tax,
      total: invoice.total,
      amount_paid: invoice.amount_paid,
      amount_remaining: invoice.amount_remaining,
      status: invoice.status,
      currency: invoice.currency,
      metadata: invoice.metadata,
    };
  }

  /** Customer pays an open invoice in full. */
  pay(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`No invoice ${invoiceId}`);
    invoice.amount_paid = invoice.total;
    invoice.amount_remaining = 0;
    invoice.status = 'paid';
  }

  /**
   * Stripe's automatic collection of a finalized `charge_automatically`
   * invoice: charges the customer's default card. Returns the outcome.
   */
  collect(invoiceId: string): 'paid' | 'failed' {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`No invoice ${invoiceId}`);
    if (
      invoice.collection_method !== 'charge_automatically' ||
      invoice.status !== 'open' ||
      !invoice.auto_advance
    ) {
      throw new Error(`Invoice ${invoiceId} is not being collected.`);
    }
    const method = this.customers.get(invoice.customer)?.default_payment_method;
    if (!method || (this.cards.get(method) ?? 'succeed') !== 'succeed') {
      return 'failed';
    }
    this.pay(invoiceId);
    return 'paid';
  }

  /**
   * The customer finishes a checkout: a payment session is paid with tax
   * from the collected (or customer) address; a setup session saves
   * `paymentMethod`. A collected address is saved to the customer when the
   * session asked to.
   */
  completeSession(
    sessionId: string,
    options: { paymentMethod?: string; address?: Record<string, string> } = {},
  ): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    const customer = session.customer
      ? this.customers.get(session.customer)
      : undefined;
    if (options.address && customer && session.customer_update_address) {
      customer.address = options.address;
    }
    const country = options.address?.country ?? customer?.address?.country;
    if (session.mode === 'payment') {
      const rate =
        session.automatic_tax && customer?.tax_exempt !== 'exempt'
          ? (TAX_RATES[country ?? ''] ?? 0)
          : 0;
      session.amount_tax = Math.round((session.amount_subtotal ?? 0) * rate);
      session.amount_total =
        (session.amount_subtotal ?? 0) + session.amount_tax;
      session.payment_status = 'paid';
    }
    if (session.mode === 'setup' || session.setup_future_usage) {
      session.payment_method = options.paymentMethod ?? this.nextId('pm');
    }
    session.status = 'complete';
    return session;
  }

  private createPaymentIntent(body: Record<string, unknown>): {
    status: number;
    body: unknown;
  } {
    const method = String(body.payment_method ?? '');
    const behavior = this.cards.get(method) ?? 'succeed';
    const intent: FakePaymentIntent = {
      id: this.nextId('pi'),
      object: 'payment_intent',
      created: this.counter,
      amount: Number(body.amount),
      currency: String(body.currency),
      customer: String(body.customer),
      payment_method: method,
      status:
        behavior === 'succeed'
          ? 'succeeded'
          : behavior === 'processing'
            ? 'processing'
            : 'requires_payment_method',
      last_payment_error: null,
      metadata: (body.metadata as Record<string, string>) ?? {},
    };
    this.paymentIntents.set(intent.id, intent);
    if (behavior === 'decline' || behavior === 'authentication_required') {
      const code =
        behavior === 'decline' ? 'card_declined' : 'authentication_required';
      intent.last_payment_error = { code, message: `Card ${code}.` };
      return {
        status: 402,
        body: {
          error: {
            type: 'card_error',
            code,
            ...(behavior === 'decline'
              ? { decline_code: 'insufficient_funds' }
              : {}),
            message: `Card ${code}.`,
            payment_intent: { ...intent },
          },
        },
      };
    }
    return { status: 200, body: { ...intent } };
  }

  /** A processing PaymentIntent settles (Stripe then sends its event). */
  settlePaymentIntent(
    intentId: string,
    status: 'succeeded' | 'failed',
  ): FakePaymentIntent {
    const intent = this.paymentIntents.get(intentId);
    if (!intent) throw new Error(`No payment intent ${intentId}`);
    intent.status =
      status === 'succeeded' ? 'succeeded' : 'requires_payment_method';
    if (status === 'failed') {
      intent.last_payment_error = { code: 'card_declined', message: 'x' };
    }
    return intent;
  }

  setInvoiceStatus(invoiceId: string, status: FakeInvoice['status']): void {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`No invoice ${invoiceId}`);
    invoice.status = status;
  }

  lineItemsOf(invoiceId: string): FakeInvoiceItem[] {
    const invoice = this.invoices.get(invoiceId);
    return (invoice?.items ?? []).map(
      (id) => this.invoiceItems.get(id) as FakeInvoiceItem,
    );
  }
}

/** A signed Stripe webhook delivery for `event`. */
export function signedEvent(event: Record<string, unknown>): {
  payload: string;
  signature: string;
} {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return { payload, signature: `t=${timestamp},v1=${signature}` };
}

let eventCounter = 0;

export function invoiceEvent(
  type: string,
  invoiceId: string,
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: `evt_${type.replace(/\./g, '_')}_${eventCounter}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: invoiceId, object: 'invoice' } },
  };
}

export function checkoutEvent(
  session: {
    id: string;
    mode?: string;
    currency: string | null;
    amount_subtotal: number | null;
    amount_total?: number | null;
    metadata: Record<string, string>;
  },
  paymentStatus = 'paid',
  type = 'checkout.session.completed',
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: `evt_checkout_${eventCounter}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: session.id,
        object: 'checkout.session',
        mode: session.mode ?? 'payment',
        payment_status: paymentStatus,
        currency: session.currency,
        amount_subtotal: session.amount_subtotal,
        amount_total: session.amount_total ?? session.amount_subtotal,
        metadata: session.metadata,
      },
    },
  };
}

/** A `payment_intent.*` event for a PaymentIntent the fake holds. */
export function paymentIntentEvent(
  type: string,
  intent: Record<string, unknown>,
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: `evt_pi_${eventCounter}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { ...intent } },
  };
}

export function subscriptionEvent(
  type: string,
  subscriptionId: string,
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: `evt_sub_${eventCounter}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: subscriptionId, object: 'subscription' } },
  };
}
