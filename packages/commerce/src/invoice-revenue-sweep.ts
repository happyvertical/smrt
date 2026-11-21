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

/**
 * One page of unposted, issued invoice ids after `after`, ordered by id.
 *
 * Raw SQL, because an unposted invoice stores either NULL or '' in
 * `ar_journal_id` and the collection filter cannot match both. Id columns are
 * cast to text so the same statement runs on PostgreSQL (UUID columns) and
 * SQLite (text).
 *
 * @internal exported for the PostgreSQL-dialect test.
 */
export async function selectUnpostedInvoiceIds(
  db: DatabaseInterface,
  tenantId: string,
  after: string | null,
  limit: number,
): Promise<{ id: string }[]> {
  const statuses = POSTABLE_STATUSES.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT CAST(id AS TEXT) AS id FROM invoices
      WHERE CAST(tenant_id AS TEXT) = ? AND kind = 'invoice'
        AND COALESCE(CAST(ar_journal_id AS TEXT), '') = ''
        AND status IN (${statuses})
        ${after ? 'AND CAST(id AS TEXT) > ?' : ''}
      ORDER BY CAST(id AS TEXT) ASC LIMIT ?`,
    tenantId,
    ...POSTABLE_STATUSES,
    ...(after ? [after] : []),
    limit,
  );
  return rows as { id: string }[];
}

/**
 * One page of cancelled invoices that still carry a revenue journal but no
 * reversal, after `after`, ordered by id. Same casts as
 * {@link selectUnpostedInvoiceIds}.
 *
 * @internal exported for the PostgreSQL-dialect test.
 */
export async function selectCancelledUnreversedInvoiceIds(
  db: DatabaseInterface,
  tenantId: string,
  after: string | null,
  limit: number,
): Promise<{ id: string }[]> {
  const { rows } = await db.query(
    `SELECT CAST(id AS TEXT) AS id FROM invoices
      WHERE CAST(tenant_id AS TEXT) = ? AND kind = 'invoice'
        AND status = ?
        AND COALESCE(CAST(ar_journal_id AS TEXT), '') <> ''
        AND COALESCE(CAST(ar_reversal_journal_id AS TEXT), '') = ''
        ${after ? 'AND CAST(id AS TEXT) > ?' : ''}
      ORDER BY CAST(id AS TEXT) ASC LIMIT ?`,
    tenantId,
    InvoiceStatus.CANCELLED,
    ...(after ? [after] : []),
    limit,
  );
  return rows as { id: string }[];
}

/**
 * Reverse the revenue journal of a cancelled invoice that still carries one.
 * Idempotent: the reversal is a deterministic journal, and an invoice that is
 * not cancelled, has no journal, or is already reversed is left alone.
 */
export async function reverseCancelledInvoiceRevenue(
  db: DatabaseInterface,
  tenantId: string,
  invoiceId: string,
): Promise<{ reversed: boolean }> {
  return withTenant({ tenantId }, async () => {
    const invoice = await (await InvoiceCollection.create({ db })).get(
      { id: invoiceId, tenantId },
      { cache: false },
    );
    if (
      !invoice ||
      invoice.status !== InvoiceStatus.CANCELLED ||
      !invoice.arJournalId ||
      invoice.arReversalJournalId
    )
      return { reversed: false };
    await invoice.cancelWithRevenueReversal({ bookCurrency: invoice.currency });
    return { reversed: true };
  });
}

export interface PostPendingInvoiceRevenueOptions {
  /** Invoices per page (1-200, default 50). */
  readonly limit?: number;
  /** Pages per call (default 20). A larger backlog returns `nextCursor`. */
  readonly maxPages?: number;
  /** Resume from a previous call's `nextCursor`. */
  readonly cursor?: string | null;
  /** Called with the invoice id and error when one invoice fails. */
  readonly onError?: (invoiceId: string, error: unknown) => void;
}

export interface PostPendingInvoiceRevenueResult {
  /** Invoices posted by this call. */
  readonly posted: number;
  /** Cancelled invoices whose revenue journal this call reversed. */
  readonly reversed: number;
  /** Invoices whose post or reversal threw; the rest of the batch still ran. */
  readonly failed: number;
  /**
   * Pass back as `options.cursor` to continue past this call's page budget, so
   * invoices that fail every run cannot starve the ones after them. Null when
   * the scan finished.
   */
  readonly nextCursor: string | null;
}

type SweepPhase = 'reverse' | 'post';

function parseCursor(cursor: string | null | undefined): {
  phase: SweepPhase;
  after: string | null;
} {
  if (!cursor) return { phase: 'reverse', after: null };
  const [phase, ...rest] = cursor.split(':');
  const after = rest.join(':') || null;
  return { phase: phase === 'post' ? 'post' : 'reverse', after };
}

/**
 * Repair: bring the tenant's books in line with its invoices.
 *
 * Two phases, each filtered in the query before paging so settled invoices
 * never consume the scan: (1) cancelled invoices that still carry a revenue
 * journal get it reversed (a cancel that raced a post, or a reversal that
 * failed); (2) issued, non-cancelled, non-written-off invoices with no journal
 * get posted. A paid invoice whose payment settled before posting existed is
 * balanced by its new journal. Safe to repeat and to run concurrently: posting
 * and reversal are keyed on the invoice and its snapshot.
 *
 * One call scans up to `maxPages` pages. If it stops there, `nextCursor`
 * resumes where it left off; an invoice that fails stays unposted but the
 * cursor moves past it, so it cannot starve later ones.
 */
export async function postPendingInvoiceRevenue(
  db: DatabaseInterface,
  tenantId: string,
  options: PostPendingInvoiceRevenueOptions = {},
): Promise<PostPendingInvoiceRevenueResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const maxPages = Math.max(options.maxPages ?? MAX_SWEEP_PAGES, 1);
  let posted = 0;
  let reversed = 0;
  let failed = 0;
  let { phase, after } = parseCursor(options.cursor);
  let pages = 0;
  while (true) {
    if (pages >= maxPages)
      return {
        posted,
        reversed,
        failed,
        nextCursor: `${phase}:${after ?? ''}`,
      };
    const batch =
      phase === 'reverse'
        ? await selectCancelledUnreversedInvoiceIds(db, tenantId, after, limit)
        : await selectUnpostedInvoiceIds(db, tenantId, after, limit);
    pages += 1;
    for (const candidate of batch) {
      after = String(candidate.id);
      try {
        if (phase === 'reverse') {
          if (
            (await reverseCancelledInvoiceRevenue(db, tenantId, after)).reversed
          )
            reversed += 1;
        } else if (
          (await postInvoiceRevenueToSettlementChart(db, tenantId, after))
            .posted
        ) {
          posted += 1;
        }
      } catch (error) {
        failed += 1;
        options.onError?.(after, error);
      }
    }
    if (batch.length < limit) {
      if (phase === 'post')
        return { posted, reversed, failed, nextCursor: null };
      phase = 'post';
      after = null;
    }
  }
}
