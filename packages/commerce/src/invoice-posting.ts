/** Atomic money-v2 revenue posting and cancellation reversal. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import type { Journal, JournalEntryData } from '@happyvertical/smrt-ledgers';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import { deterministicId } from './billing/units.js';
import { DocumentTaxCollection } from './collections/DocumentTaxCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { lockAndReloadInvoice, settingsForTenant } from './document-money.js';
import {
  DOCUMENT_MONEY_WRITE,
  withDocumentMoneyTransaction,
} from './document-money-internal.js';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';
import { buildRevenueJournalEntries } from './revenue-journal.js';
import {
  type CancelRevenueOptions,
  InvoiceStatus,
  type RecognizeRevenueOptions,
} from './types/index.js';

type PostingMetadata = {
  kind: 'invoice-revenue' | 'invoice-cancellation-reversal';
  invoiceId: string;
  moneySnapshotId: string;
  originalJournalId?: string;
  warnings?: unknown[];
};

function required(value: string | null | undefined, label: string): string {
  if (!value || value.trim() !== value)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} must be a nonempty value`,
    );
  return value;
}

function bookCurrency(value: string | undefined): string {
  if (
    !value ||
    value !== value.toUpperCase() ||
    !ISO_4217_MINOR_UNITS.has(value) ||
    ISO_4217_MINOR_UNITS.get(value) === null
  )
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Money-v2 posting requires a supported ISO 4217 bookCurrency',
    );
  return value;
}

function assertTenantAuthority(tenantId: string): void {
  if (getTenantId() !== tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice posting requires its active tenant context',
    );
}

function assertPostingAvailable(settings: { moneyModel: string } | null): void {
  if (settings?.moneyModel === 'migrating')
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money migration is in progress',
    );
}

function canonicalEntries(entries: readonly JournalEntryData[]): string {
  return JSON.stringify(
    entries
      .map((entry) => ({
        accountId: entry.accountId,
        debit: entry.debit ?? 0,
        credit: entry.credit ?? 0,
        currency: entry.currency ?? '',
        memo: entry.memo ?? '',
      }))
      .sort((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

async function validateAccounts(
  db: DatabaseInterface,
  tenantId: string,
  accountIds: readonly string[],
): Promise<void> {
  const { AccountCollection } = await import('@happyvertical/smrt-ledgers');
  const accounts = await AccountCollection.create({ db });
  for (const accountId of [...new Set(accountIds)]) {
    const account = await accounts.get({ id: accountId }, { cache: false });
    if (!account || account.tenantId !== tenantId || !account.active)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `Posting account ${accountId} must be active and owned by the invoice tenant`,
      );
  }
}

async function entriesForJournal(
  db: DatabaseInterface,
  journalId: string,
): Promise<JournalEntryData[]> {
  const { JournalEntryCollection } = await import(
    '@happyvertical/smrt-ledgers'
  );
  const entries = await (
    await JournalEntryCollection.create({ db })
  ).findByJournal(journalId);
  return entries.map((entry) => ({
    accountId: entry.accountId,
    debit: entry.debit,
    credit: entry.credit,
    currency: entry.currency,
    memo: entry.memo,
  }));
}

function metadataMatches(journal: Journal, expected: PostingMetadata): boolean {
  const actual = journal.metadata as Partial<PostingMetadata>;
  return (
    actual.kind === expected.kind &&
    actual.invoiceId === expected.invoiceId &&
    actual.moneySnapshotId === expected.moneySnapshotId &&
    actual.originalJournalId === expected.originalJournalId
  );
}

async function createOrReadPostedJournal(
  db: DatabaseInterface,
  input: {
    id: string;
    tenantId: string;
    sourceRef: string;
    description: string;
    date: Date;
    metadata: PostingMetadata;
    entries: readonly JournalEntryData[];
  },
): Promise<Journal> {
  const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
  const journals = await JournalCollection.create({ db });
  const existing = await journals.get({ id: input.id }, { cache: false });
  if (existing) {
    const storedEntries = await entriesForJournal(db, input.id);
    if (
      existing.status !== 'posted' ||
      existing.tenantId !== input.tenantId ||
      existing.sourceModule !== 'smrt-commerce' ||
      existing.sourceRef !== input.sourceRef ||
      !metadataMatches(existing, input.metadata) ||
      canonicalEntries(storedEntries) !== canonicalEntries(input.entries)
    )
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        `Deterministic journal ${input.id} conflicts with the frozen invoice snapshot`,
      );
    return existing;
  }
  const journal = await journals.create({
    id: input.id,
    tenantId: input.tenantId,
    date: input.date,
    description: input.description,
    sourceModule: 'smrt-commerce',
    sourceRef: input.sourceRef,
    metadata: input.metadata,
    _insertOnly: true,
  });
  for (const entry of input.entries) await journal.addEntry(entry);
  await journal.post();
  if (!journal.id)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Posted revenue journal is missing its identity',
    );
  return journal;
}

/** Return null for legacy tenants so Invoice can preserve its old path. */
export async function recognizeInvoiceRevenueV2(
  input: Invoice,
  options: RecognizeRevenueOptions,
): Promise<Journal | null> {
  return withDocumentMoneyTransaction(input.db, async (tx) =>
    input.withDatabase(tx, async (callerInvoice) => {
      const candidateTenantId = callerInvoice.tenantId;
      const settings = await settingsForTenant(tx, candidateTenantId);
      assertPostingAvailable(settings);
      if (settings?.moneyModel !== 'v2') return null;
      const invoiceId = required(callerInvoice.id, 'Invoice ID');
      const tenantId = required(candidateTenantId, 'Invoice tenant ID');
      assertTenantAuthority(tenantId);
      const currency = bookCurrency(options.bookCurrency);
      const { invoice } = await lockAndReloadInvoice(tx, invoiceId, tenantId);
      if (invoice.status === InvoiceStatus.DRAFT || !invoice.moneySnapshotId)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Money-v2 revenue recognition requires an issued frozen invoice',
        );
      if (invoice.currency !== currency)
        throw new MoneyValidationError(
          'CURRENCY_MISMATCH',
          `Invoice currency ${invoice.currency} does not match book currency ${currency}`,
        );

      const lines = await (
        await InvoiceLineItemCollection.create({ db: tx })
      ).findByInvoice(invoiceId);
      const taxes = await (
        await DocumentTaxCollection.create({ db: tx })
      ).findByDocument(tenantId, 'invoice', invoiceId);
      const built = buildRevenueJournalEntries(
        {
          id: invoiceId,
          number: invoice.invoiceNumber,
          currency: invoice.currency,
          lineAmountType: invoice.lineAmountType,
          subtotalMinor: invoice.subtotal,
          taxMinor: invoice.taxAmount,
          totalMinor: invoice.totalAmount,
          providerTaxMinor: invoice.providerTaxAmount,
        },
        lines.map((line) => ({
          id: required(line.id, 'Invoice line ID'),
          amountMinor: line.amount,
          taxMinor: line.taxAmount,
          revenueAccountId: line.revenueAccountId,
        })),
        taxes.map((tax) => ({
          currency: tax.currency,
          taxCodeId: tax.taxCodeId,
          taxCodeCode: tax.taxCodeCode,
          taxComponentId: tax.taxComponentId,
          liabilityAccountId: tax.liabilityAccountId,
          taxMinor: tax.taxMinor,
        })),
        {
          arAccountId: options.arAccountId,
          revenueAccountId: options.revenueAccountId,
          taxAccountId: options.taxAccountId,
          bookCurrency: currency,
        },
      );
      await validateAccounts(
        tx,
        tenantId,
        built.entries.map((entry) => entry.accountId),
      );
      const journalId = await deterministicId([
        'invoice-revenue',
        tenantId,
        invoiceId,
        invoice.moneySnapshotId,
      ]);
      const metadata: PostingMetadata = {
        kind: 'invoice-revenue',
        invoiceId,
        moneySnapshotId: invoice.moneySnapshotId,
        warnings: built.warnings,
      };
      const journal = await createOrReadPostedJournal(tx, {
        id: journalId,
        tenantId,
        sourceRef: `invoice-revenue:${invoiceId}:${invoice.moneySnapshotId}`,
        description: `Revenue: Invoice ${invoice.invoiceNumber}`,
        date: invoice.issueDate,
        metadata,
        entries: built.entries,
      });
      if (invoice.arJournalId && invoice.arJournalId !== journalId)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Invoice already links a different revenue journal',
        );
      invoice.arJournalId = journalId;
      await invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
        recomputeLegacy: false,
      });
      callerInvoice.arJournalId = journalId;
      return journal;
    }),
  );
}

function reverseEntries(
  entries: readonly JournalEntryData[],
  currency: string,
): JournalEntryData[] {
  return entries.map((entry, index) => {
    if (
      entry.currency !== currency ||
      !Number.isSafeInteger(entry.debit ?? 0) ||
      !Number.isSafeInteger(entry.credit ?? 0) ||
      (entry.debit ?? 0) < 0 ||
      (entry.credit ?? 0) < 0 ||
      (entry.debit ?? 0) > 0 === (entry.credit ?? 0) > 0
    )
      throw new MoneyValidationError(
        entry.currency !== currency ? 'CURRENCY_MISMATCH' : 'UNSAFE_MONEY',
        `Original journal entry ${index + 1} is not an exact ${currency} movement`,
      );
    return {
      accountId: required(entry.accountId, 'Original journal account ID'),
      debit: entry.credit ?? 0,
      credit: entry.debit ?? 0,
      currency,
      memo: `Reversal: ${entry.memo ?? ''}`,
    };
  });
}

/** Atomically reverse a posted v2 invoice and move it to CANCELLED. */
export async function cancelInvoiceWithRevenueReversal(
  input: Invoice,
  options: CancelRevenueOptions,
): Promise<Journal | null> {
  return withDocumentMoneyTransaction(input.db, async (tx) =>
    input.withDatabase(tx, async (callerInvoice) => {
      const candidateTenantId = callerInvoice.tenantId;
      const settings = await settingsForTenant(tx, candidateTenantId);
      assertPostingAvailable(settings);
      if (settings?.moneyModel !== 'v2') {
        callerInvoice.cancel();
        await callerInvoice.saveDerived(DOCUMENT_MONEY_WRITE, {
          recomputeLegacy: true,
        });
        return null;
      }
      const invoiceId = required(callerInvoice.id, 'Invoice ID');
      const tenantId = required(candidateTenantId, 'Invoice tenant ID');
      assertTenantAuthority(tenantId);
      const currency = bookCurrency(options.bookCurrency);
      const { invoice } = await lockAndReloadInvoice(tx, invoiceId, tenantId);
      if (invoice.currency !== currency)
        throw new MoneyValidationError(
          'CURRENCY_MISMATCH',
          `Invoice currency ${invoice.currency} does not match book currency ${currency}`,
        );
      if (invoice.isPaid())
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Paid invoices cannot be cancelled',
        );
      if (!invoice.arJournalId)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Revenue must be posted before using cancellation reversal',
        );
      const snapshotId = required(
        invoice.moneySnapshotId,
        'Invoice money snapshot ID',
      );
      const originalJournalId = invoice.arJournalId;
      const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
      const journals = await JournalCollection.create({ db: tx });
      const original = await journals.get(
        { id: originalJournalId },
        { cache: false },
      );
      if (
        original?.status !== 'posted' ||
        original.tenantId !== tenantId ||
        original.sourceModule !== 'smrt-commerce' ||
        original.sourceRef !== `invoice-revenue:${invoiceId}:${snapshotId}` ||
        !metadataMatches(original, {
          kind: 'invoice-revenue',
          invoiceId,
          moneySnapshotId: snapshotId,
        })
      )
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Invoice revenue journal must be posted and tenant-owned before reversal',
        );
      const originalEntries = await entriesForJournal(tx, originalJournalId);
      const reversalEntries = reverseEntries(originalEntries, currency);
      await validateAccounts(
        tx,
        tenantId,
        reversalEntries.map((entry) => entry.accountId),
      );
      const reversalId = await deterministicId([
        'invoice-cancellation-reversal',
        tenantId,
        invoiceId,
        snapshotId,
        originalJournalId,
      ]);
      const metadata: PostingMetadata = {
        kind: 'invoice-cancellation-reversal',
        invoiceId,
        moneySnapshotId: snapshotId,
        originalJournalId,
      };
      const reversal = await createOrReadPostedJournal(tx, {
        id: reversalId,
        tenantId,
        sourceRef: `invoice-cancellation:${invoiceId}:${snapshotId}`,
        description: `Cancellation reversal: Invoice ${invoice.invoiceNumber}`,
        date: new Date(),
        metadata,
        entries: reversalEntries,
      });
      if (
        invoice.arReversalJournalId &&
        invoice.arReversalJournalId !== reversalId
      )
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Invoice already links a different cancellation reversal',
        );
      invoice.arReversalJournalId = reversalId;
      if (invoice.status !== InvoiceStatus.CANCELLED) invoice.cancel();
      await invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
        recomputeLegacy: false,
      });
      callerInvoice.arReversalJournalId = reversalId;
      callerInvoice.status = InvoiceStatus.CANCELLED;
      return reversal;
    }),
  );
}
