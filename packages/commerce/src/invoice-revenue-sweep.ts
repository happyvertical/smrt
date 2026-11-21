/**
 * Post issued invoices into the tenant's settlement chart, and sweep up the
 * ones that were never posted.
 *
 * `Invoice.recognizeRevenue` posts one balanced journal per frozen invoice
 * snapshot and links it as `arJournalId`, so everything here is idempotent.
 * {@link postInvoiceRevenueToSettlementChart} wires it to the chart from
 * `ensureTenantSettlementAccounts`; {@link postPendingInvoiceRevenue} is the
 * repair for invoices issued before posting existed or whose post failed.
 *
 * Both open their own money transaction: call them outside a model
 * transaction, as `ensureTenantSettlementAccounts`.
 */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import type { Invoice } from './models/Invoice.js';
import { ensureTenantSettlementAccounts } from './settlement-accounts.js';
import { InvoiceStatus } from './types/index.js';

const MAX_SWEEP_PAGES = 20;

/** Statuses whose invoices are issued and still carry receivables. */
const POSTABLE_STATUSES: readonly InvoiceStatus[] = Object.values(
  InvoiceStatus,
).filter(
  (status) =>
    status !== InvoiceStatus.DRAFT &&
    status !== InvoiceStatus.CANCELLED &&
    status !== InvoiceStatus.WRITTEN_OFF,
);

export interface PostInvoiceRevenueResult {
  /** True when this call posted the journal. */
  readonly posted: boolean;
  /** The invoice's revenue journal, or null when it is not postable. */
  readonly journalId: string | null;
}

/**
 * Post one issued invoice's revenue journal (Dr receivables / Cr revenue / Cr
 * tax) into the tenant's settlement chart for the invoice currency.
 *
 * Idempotent: an invoice that already links a journal returns it unchanged.
 * Drafts, cancelled and written-off invoices are skipped. If a cancellation
 * commits between the read and the post, the new journal is reversed so a
 * cancelled invoice never keeps receivables.
 */
export async function postInvoiceRevenueToSettlementChart(
  db: DatabaseInterface,
  tenantId: string,
  invoiceId: string,
): Promise<PostInvoiceRevenueResult> {
  return withTenant({ tenantId }, async () => {
    const load = async (): Promise<Invoice> => {
      const invoice = await (await InvoiceCollection.create({ db })).get(
        { id: invoiceId, tenantId },
        { cache: false },
      );
      if (!invoice) throw new Error('Invoice not found');
      return invoice;
    };
    const invoice = await load();
    if (invoice.arJournalId)
      return { posted: false, journalId: String(invoice.arJournalId) };
    if (!POSTABLE_STATUSES.includes(invoice.status))
      return { posted: false, journalId: null };

    const accounts = await ensureTenantSettlementAccounts(db, tenantId, {
      currency: invoice.currency,
    });
    const journal = await invoice.recognizeRevenue({
      arAccountId: accounts.receivablesAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxAccountId: accounts.salesTaxPayableAccountId,
      bookCurrency: invoice.currency,
    });

    const after = await load();
    if (
      after.status === InvoiceStatus.CANCELLED &&
      !after.arReversalJournalId
    ) {
      await after.cancelWithRevenueReversal({ bookCurrency: after.currency });
    }
    return { posted: true, journalId: String(journal.id) };
  });
}

export interface PostPendingInvoiceRevenueOptions {
  /** Invoices per page (1-200, default 50). */
  readonly limit?: number;
  /** Called with the invoice id and error when one invoice fails to post. */
  readonly onError?: (invoiceId: string, error: unknown) => void;
}

export interface PostPendingInvoiceRevenueResult {
  /** Invoices posted by this call. */
  readonly posted: number;
  /** Invoices whose posting threw; the rest of the batch still ran. */
  readonly failed: number;
}

/**
 * Repair: post every issued invoice of the tenant that has no revenue journal.
 *
 * The query keeps only unposted, issued, non-cancelled, non-written-off
 * invoices before paging, so posted invoices never consume the scan (up to 20
 * pages of `limit`). Safe to repeat and to run concurrently: posting is keyed
 * on the invoice and its snapshot. A paid invoice whose payment settled before
 * posting existed is balanced by the new journal.
 */
export async function postPendingInvoiceRevenue(
  db: DatabaseInterface,
  tenantId: string,
  options: PostPendingInvoiceRevenueOptions = {},
): Promise<PostPendingInvoiceRevenueResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  let posted = 0;
  let failed = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
    const after: string | null = cursor;
    // Raw ids, because an unposted invoice stores either NULL or '' in
    // `ar_journal_id` and the collection filter cannot match both.
    const statuses = POSTABLE_STATUSES.map(() => '?').join(', ');
    const { rows } = await db.query(
      `SELECT id FROM invoices
        WHERE tenant_id = ? AND kind = 'invoice'
          AND (ar_journal_id IS NULL OR ar_journal_id = '')
          AND status IN (${statuses})
          ${after ? 'AND id > ?' : ''}
        ORDER BY id ASC LIMIT ?`,
      tenantId,
      ...POSTABLE_STATUSES,
      ...(after ? [after] : []),
      limit,
    );
    const batch = rows as { id: string }[];
    for (const candidate of batch) {
      cursor = String(candidate.id);
      try {
        const outcome = await postInvoiceRevenueToSettlementChart(
          db,
          tenantId,
          String(candidate.id),
        );
        if (outcome.posted) posted += 1;
      } catch (error) {
        failed += 1;
        options.onError?.(String(candidate.id), error);
      }
    }
    if (batch.length < limit) break;
  }
  return { posted, failed };
}
