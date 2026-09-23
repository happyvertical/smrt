/**
 * An in-memory Stripe REST double for billing tests (#3060).
 *
 * It sits behind the real `@happyvertical/accounting` Stripe provider (via its
 * `fetch` option), so tests exercise the SDK's request encoding, idempotency
 * keys, replay reconciliation, and unit conversion — only the network is fake.
 * It honours `Idempotency-Key` the way Stripe does (same key, same response,
 * no second side effect) and models Stripe Tax as a per-country rate on the
 * customer's address.
 */
import { createHmac } from 'node:crypto';
import type { StripeAccountingProvider } from '@happyvertical/accounting';
import { getAccountingProvider } from '@happyvertical/accounting';

export const WEBHOOK_SECRET = 'whsec_test_billing';

interface FakeCustomer {
  id: string;
  name?: string;
  email?: string;
  address?: Record<string, string>;
  tax_exempt?: string;
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
  currency: string;
  amount_subtotal: number;
  customer: string | null;
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
  readonly subscriptions = new Map<string, Record<string, unknown>>();
  readonly requests: Array<{ method: string; path: string; key?: string }> = [];
  private readonly idempotent = new Map<
    string,
    { status: number; body: unknown }
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
    if (replayKey && this.idempotent.has(replayKey)) {
      const stored = this.idempotent.get(replayKey);
      return json(stored?.status ?? 200, stored?.body);
    }
    const body =
      typeof init?.body === 'string' ? parseForm(init.body) : ({} as never);
    const result = this.route(method, url, body);
    if (replayKey && result.status < 300) {
      this.idempotent.set(replayKey, result);
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
        metadata: {},
      };
      this.applyCustomer(customer, body);
      this.customers.set(customer.id, customer);
      return { status: 200, body: customer };
    }
    match = path.match(/^\/v1\/customers\/([^/]+)$/);
    if (match) {
      const customer = this.customers.get(match[1]);
      if (!customer) return { status: 404, body: { error: {} } };
      if (method === 'POST') this.applyCustomer(customer, body);
      return { status: 200, body: customer };
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
      const invoice: FakeInvoice = {
        id: this.nextId('in'),
        customer,
        currency: items[0]?.currency ?? 'usd',
        status: 'draft',
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
    match = path.match(/^\/v1\/invoices\/([^/]+)\/send$/);
    if (match) {
      const invoice = this.invoices.get(match[1]);
      if (!invoice) return { status: 404, body: { error: {} } };
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
      invoice.sent += 1;
      return { status: 200, body: this.view(invoice) };
    }
    match = path.match(/^\/v1\/invoices\/([^/]+)$/);
    if (match) {
      const invoice = this.invoices.get(match[1]);
      if (!invoice) return { status: 404, body: { error: {} } };
      return { status: 200, body: this.view(invoice) };
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const lineItems = body.line_items as Record<
        string,
        {
          price_data: { currency: string; unit_amount: string };
          quantity: string;
        }
      >;
      const line = lineItems['0'];
      const session: FakeSession = {
        id: this.nextId('cs'),
        url: 'https://checkout.stripe.test/session',
        mode: String(body.mode),
        currency: line.price_data.currency,
        amount_subtotal:
          Number(line.price_data.unit_amount) * Number(line.quantity ?? 1),
        customer: body.customer ? String(body.customer) : null,
        // Stripe treats an empty metadata value as unset.
        metadata: Object.fromEntries(
          Object.entries(
            (body.metadata as Record<string, string>) ?? {},
          ).filter(([, value]) => value !== ''),
        ),
      };
      this.sessions.set(session.id, session);
      return { status: 200, body: { ...session } };
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

  private view(invoice: FakeInvoice): Record<string, unknown> {
    return {
      id: invoice.id,
      object: 'invoice',
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
    currency: string;
    amount_subtotal: number;
    amount_total?: number;
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
        mode: 'payment',
        payment_status: paymentStatus,
        currency: session.currency,
        amount_subtotal: session.amount_subtotal,
        amount_total: session.amount_total ?? session.amount_subtotal,
        metadata: session.metadata,
      },
    },
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
