/**
 * Adapters from the QuickBooks provider's operations to commerce's injected
 * accounting ports (#5154): payment creation (sdk#1540), invoice readback
 * (sdk#1548) and customer find / find-or-create (sdk#1539).
 *
 * The SDK shapes are declared here structurally, so these adapters compile and
 * run against any `@happyvertical/accounting` that exposes the operations (the
 * range smrt pins does not have to move). Pass the provider
 * `withTenantQuickBooksProvider` hands you; a provider without the operation
 * fails the call with a plain error, never silently.
 *
 * @packageDocumentation
 */

import { prepareQuickBooksPaymentRequest } from '@happyvertical/accounting';
import {
  type AccountingCustomerCandidate,
  type AccountingCustomerDirectory,
  AccountingMappingError,
} from './accounting-mapping.js';
import {
  type AccountingInvoiceEvidence,
  type AccountingInvoiceReader,
  AccountingPaymentNotSentError,
  type AccountingPaymentPort,
  type AccountingPaymentRequest,
} from './accounting-payment-sync.js';
import { minorToMajorUnits } from './billing/units.js';

/** The SDK's QuickBooks payment creation (sdk#1540), as this adapter drives it. */
export interface QuickBooksPaymentCreateOperation {
  create(
    input: {
      customerRef: string;
      depositToAccountRef: string;
      /** Calendar date, `YYYY-MM-DD`. */
      paidOn: string;
      currency: string;
      /** Major units. */
      amount: number;
      applications: { invoiceRef: string; amount: number }[];
      reference?: string;
    },
    request: {
      requestId: string;
      realmId: string;
      environment: 'sandbox' | 'production';
      payloadHash: string;
    },
  ): Promise<{ externalId: string }>;
}

/** The SDK's QuickBooks invoice readback (sdk#1548). */
export interface QuickBooksInvoiceReadbackOperation {
  readback(
    externalId: string,
  ): Promise<Omit<AccountingInvoiceEvidence, 'tenantId'>>;
}

/** The SDK's QuickBooks customer operations (sdk#1539). */
export interface QuickBooksCustomerOperations {
  find(query: {
    displayName?: string;
    email?: string;
  }): Promise<
    Array<{ id?: string; externalId?: string; name: string; email?: string }>
  >;
  findOrCreate(customer: {
    id: string;
    name: string;
    email?: string;
  }): Promise<{
    match: 'existing' | 'created' | 'ambiguous';
    candidates: Array<{ id?: string; externalId?: string }>;
  }>;
}

/** QuickBooks `PaymentRefNum` holds at most this many characters. */
const PAYMENT_REFERENCE_MAX = 21;

/**
 * Adapt the provider's payment creation to {@link AccountingPaymentPort}. The
 * commerce request id is forwarded as the QuickBooks `requestid`, so a retry of
 * the same facts cannot double-record; amounts convert from ISO 4217 minor to
 * major units and an unknown currency is refused (it throws before any call). A
 * `QuickBooksWriteError` already carries `outcome: 'rejected' | 'unknown'`,
 * which commerce's reconciliation reads, so errors pass through unchanged.
 */
export function paymentPortFromProvider(provider: {
  payments: unknown;
}): AccountingPaymentPort {
  const payments =
    provider.payments as Partial<QuickBooksPaymentCreateOperation>;
  const input = (request: AccountingPaymentRequest) => ({
    customerRef: request.customerExternalId,
    depositToAccountRef: request.depositAccountRef,
    paidOn: request.paidAt.toISOString().slice(0, 10),
    currency: request.currency,
    amount: minorToMajorUnits(request.amountMinor, request.currency),
    applications: request.applications.map((application) => ({
      invoiceRef: application.invoiceExternalId,
      amount: minorToMajorUnits(application.amountMinor, request.currency),
    })),
    ...(request.transactionId
      ? {
          reference: request.transactionId.slice(0, PAYMENT_REFERENCE_MAX),
        }
      : {}),
  });
  return {
    // The SDK's descriptor is the SHA-256 of the exact mapped payload; commerce
    // persists it so `create` receives what it verifies (it performs no I/O).
    prepare(request: AccountingPaymentRequest) {
      try {
        return {
          payloadHash: prepareQuickBooksPaymentRequest(input(request), {
            requestId: request.requestId,
            realmId: request.realmId,
            environment: request.environment,
          }).payloadHash,
        };
      } catch {
        // The SDK's message can quote payload values; keep the cause out.
        throw new AccountingPaymentNotSentError(
          'INVALID_PROVIDER_REQUEST',
          'The payment cannot be formed into a valid provider request',
        );
      }
    },
    async create(request: AccountingPaymentRequest) {
      if (typeof payments?.create !== 'function')
        throw new AccountingPaymentNotSentError(
          'PROVIDER_UNSUPPORTED',
          'The QuickBooks provider does not support payment creation.',
        );
      const result = await payments.create(input(request), {
        requestId: request.requestId,
        realmId: request.realmId,
        environment: request.environment,
        payloadHash: request.payloadHash,
      });
      return { externalId: result.externalId, syncedAt: new Date() };
    },
  };
}

/**
 * Adapt the provider's invoice readback to {@link AccountingInvoiceReader}. The
 * SDK result carries the realm and environment; only the tenant scope is added.
 * A failing read throws, and `readbackInvoice` records the invoice as needing
 * reconciliation.
 */
export function invoiceReaderFromProvider(
  provider: { invoices: unknown },
  tenantId: string,
): AccountingInvoiceReader {
  const invoices =
    provider.invoices as Partial<QuickBooksInvoiceReadbackOperation>;
  return {
    async readInvoice(externalId) {
      if (typeof invoices?.readback !== 'function')
        throw new Error(
          'The QuickBooks provider does not support invoice readback.',
        );
      return { tenantId, ...(await invoices.readback(externalId)) };
    },
  };
}

const providerId = (record: { id?: string; externalId?: string }): string =>
  String(record.externalId ?? record.id ?? '');

/**
 * Adapt the provider's customer operations to {@link AccountingCustomerDirectory}.
 * `create` uses find-or-create keyed by the commerce request id and never
 * creates over a match: if QuickBooks now has a matching customer it throws
 * `AccountingMappingError('CUSTOMER_NEEDS_CONFIRMATION')` so the operator looks
 * again instead of getting a duplicate.
 */
export function customerDirectoryFromProvider(provider: {
  customers: unknown;
}): AccountingCustomerDirectory {
  const customers = provider.customers as Partial<QuickBooksCustomerOperations>;
  const need = <K extends keyof QuickBooksCustomerOperations>(name: K) => {
    const operation = customers?.[name];
    if (typeof operation !== 'function')
      throw new Error(
        `The QuickBooks provider does not support customer ${name}.`,
      );
    return operation.bind(customers) as QuickBooksCustomerOperations[K];
  };
  return {
    async find({ name, email }) {
      const found = await need('find')({ displayName: name, email });
      return found.map(
        (row): AccountingCustomerCandidate => ({
          externalId: providerId(row),
          name: row.name,
          ...(row.email ? { email: row.email } : {}),
        }),
      );
    },
    async create({ name, email, requestId }) {
      const result = await need('findOrCreate')({
        id: requestId,
        name,
        ...(email ? { email } : {}),
      });
      if (result.match !== 'created' || result.candidates.length !== 1)
        throw new AccountingMappingError(
          'CUSTOMER_NEEDS_CONFIRMATION',
          'QuickBooks now has a matching customer; review the matches and choose again',
        );
      return { externalId: providerId(result.candidates[0] ?? {}) };
    },
  };
}
