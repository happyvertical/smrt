import type {
  SmrtCollection,
  SmrtListOptions,
  SmrtObject,
  SmrtSelectedRow,
  SmrtSelectField,
  SmrtStiReadScope,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { SmrtReportCollection } from '@happyvertical/smrt-reports';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import {
  lockDocumentMoneyParents,
  withDocumentMoneyTransaction,
} from '../document-money-internal.js';
import { TaxSummaryReport } from '../models/TaxSummaryReport.js';
import { deterministicTaxId } from '../tax/identity.js';
import {
  aggregateTaxSummary,
  type TaxSummaryComponentMapping,
  type TaxSummaryExpenseFact,
  type TaxSummaryLedgerMovement,
  type TaxSummarySourceScope,
} from '../tax-summary.js';
import {
  DocumentTaxCollection,
  type InvoiceTaxReportFact,
} from './DocumentTaxCollection.js';
import { TaxSettingsCollection } from './TaxSettingsCollection.js';

export interface TaxSummaryExpenseSource {
  listReviewedTaxFacts(options: {
    tenantId: string;
    from: string;
    to: string;
    /** Refresh supplies its transaction-bound executor. */
    db: DatabaseInterface;
  }): Promise<readonly TaxSummaryExpenseFact[]>;
}

export interface TaxSummaryLedgerSource {
  listPostedMovements(options: {
    tenantId: string;
    accountIds: string[];
    from: Date;
    to: Date;
    currency: string;
    /** Refresh supplies its transaction-bound executor. */
    db: DatabaseInterface;
  }): Promise<readonly TaxSummaryLedgerMovement[]>;
}

export interface RefreshTaxSummaryReportOptions {
  tenantId: string;
  from: Date;
  to: Date;
  /** Dependency inversion: expenses already depend on commerce. */
  expenseSource: TaxSummaryExpenseSource;
  /** Inject the ledger owner rather than reaching into its private state. */
  ledgerSource: TaxSummaryLedgerSource;
  expenseComponentMappings: readonly TaxSummaryComponentMapping[];
}

export interface TaxSummaryReportRefreshResult {
  rowCount: number;
  complete: boolean;
}

export interface TaxSummaryInvoiceDrilldownOptions {
  /** Bound by the authenticated principal or browser host, never supplied by a row. */
  tenantId: string;
  reportId: string;
}

/** A numeric report cell, selected explicitly rather than inferred from a row. */
export type TaxSummaryReportMeasure =
  | 'taxable'
  | 'tax'
  | 'recoverable'
  | 'net'
  | 'ledgerMovement'
  | 'difference'
  | 'documentCount'
  | 'warning';

/** Detail shape supplied by the ledger owner for a reconciliation drilldown. */
export interface TaxSummaryLedgerDrilldownFact
  extends TaxSummaryLedgerMovement {
  journalId: string;
  journalDate: Date;
  journalNumber: string;
  sourceModule: string;
  sourceRef: string | null;
  debit: number;
  credit: number;
}

/** Dependency-inverted because commerce cannot import the ledgers package. */
export interface TaxSummaryLedgerDrilldownSource {
  listPostedMovements(options: {
    tenantId: string;
    accountIds: string[];
    from: Date;
    to: Date;
    currency: string;
    db: DatabaseInterface;
  }): Promise<readonly TaxSummaryLedgerDrilldownFact[]>;
}

export interface TaxSummaryContributorDrilldownOptions
  extends TaxSummaryInvoiceDrilldownOptions {
  measure: TaxSummaryReportMeasure;
  /** Required only when the materialized row says that it contains expenses. */
  expenseSource?: TaxSummaryExpenseSource;
  /** Required for ledger and reconciliation cells. */
  ledgerSource?: TaxSummaryLedgerDrilldownSource;
  expenseComponentMappings?: readonly TaxSummaryComponentMapping[];
}

export type TaxSummaryDrilldownPending =
  | 'expense-source'
  | 'ledger-source'
  | 'purchase-source'
  | 'source-provenance-missing'
  | 'source-state-diverged'
  | 'materialized-incomplete';

export type TaxSummaryDrilldownContributor =
  | {
      source: 'invoice';
      valueMinor: number;
      fact: InvoiceTaxReportFact;
    }
  | {
      source: 'contract';
      valueMinor: number;
      fact: InvoiceTaxReportFact;
    }
  | {
      source: 'expense';
      valueMinor: number;
      expense: TaxSummaryExpenseFact;
      expenseCode: string | null;
    }
  | {
      source: 'ledger';
      valueMinor: number;
      movement: TaxSummaryLedgerDrilldownFact;
    };

export interface TaxSummaryContributorDrilldown {
  row: TaxSummaryReport;
  measure: TaxSummaryReportMeasure;
  contributors: TaxSummaryDrilldownContributor[];
  /** False means this detail cannot establish the materialized cell exactly. */
  complete: boolean;
  pending: TaxSummaryDrilldownPending[];
}

function requiredTenant(value: string): void {
  if (!value?.trim()) throw new Error('Tax summary report requires a tenant.');
}

function orderedRange(from: Date, to: Date): void {
  if (
    !(from instanceof Date) ||
    Number.isNaN(from.getTime()) ||
    !(to instanceof Date) ||
    Number.isNaN(to.getTime()) ||
    from > to
  )
    throw new Error('Tax summary report requires an ordered date range.');
}

function calendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function stableDimension(parts: readonly (string | null)[]): string {
  // PostgreSQL text rejects NUL bytes; JSON preserves null/empty distinctions
  // while remaining portable across every report table dialect.
  return JSON.stringify(parts);
}

function sourceScopes(scopes: readonly TaxSummarySourceScope[]): string {
  return [...new Set(scopes)].sort().join(',');
}

function storedScopes(row: TaxSummaryReport): Set<string> {
  return new Set(
    row.sourceScopes
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

function assertMeasure(
  row: TaxSummaryReport,
  measure: TaxSummaryReportMeasure,
): void {
  const allowed: Record<
    TaxSummaryReport['rowKind'],
    readonly TaxSummaryReportMeasure[]
  > = {
    component: ['taxable', 'tax', 'recoverable', 'net', 'documentCount'],
    kind: ['taxable', 'documentCount'],
    reconciliation: ['tax', 'ledgerMovement', 'difference'],
    warning: ['warning'],
  };
  if (!allowed[row.rowKind].includes(measure))
    throw new Error(
      `Tax summary measure ${measure} is not available for ${row.rowKind} rows.`,
    );
}

function signedFact(fact: InvoiceTaxReportFact, value: number): number {
  if (!Number.isSafeInteger(value))
    throw new RangeError('Invoice drilldown value must be a safe integer.');
  return fact.documentKind === 'credit_note' ? -value : value;
}

function addDrilldownValue(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum))
    throw new RangeError('Tax summary drilldown exceeds safe integer range.');
  return sum;
}

function reportMeasureValue(
  row: TaxSummaryReport,
  measure: TaxSummaryReportMeasure,
): number | null {
  switch (measure) {
    case 'taxable':
      return row.taxableMinor;
    case 'tax':
      return row.taxMinor;
    case 'recoverable':
      return row.recoverableMinor;
    case 'net':
      return row.netTaxMinor;
    case 'ledgerMovement':
      return row.ledgerMovementMinor;
    case 'difference':
      return row.differenceMinor;
    case 'documentCount':
      return row.documentCount;
    case 'warning':
      return null;
  }
}

function reportFactIdentity(fact: InvoiceTaxReportFact): string {
  return `${fact.documentType}\u0000${fact.documentId}`;
}

function reportWarningIdentity(fact: InvoiceTaxReportFact): string {
  return JSON.stringify([fact.documentType, fact.documentId]);
}

function matchingExpenseTaxes(
  expenses: readonly TaxSummaryExpenseFact[],
  row: Pick<
    TaxSummaryReport,
    'tenantId' | 'currency' | 'periodFrom' | 'periodTo' | 'taxComponentId'
  >,
  mappings: readonly TaxSummaryComponentMapping[],
): Array<{
  expense: TaxSummaryExpenseFact;
  code: string;
  recoverableMinor: number;
}> {
  if (!row.taxComponentId) return [];
  const byCode = new Map(
    mappings
      .filter((mapping) => mapping.tenantId === row.tenantId)
      .map((mapping) => [mapping.expenseCode, mapping]),
  );
  const from = calendarDate(row.periodFrom);
  const to = calendarDate(row.periodTo);
  const matches: Array<{
    expense: TaxSummaryExpenseFact;
    code: string;
    recoverableMinor: number;
  }> = [];
  for (const expense of expenses) {
    if (
      expense.tenantId !== row.tenantId ||
      expense.currency !== row.currency ||
      expense.incurredOn < from ||
      expense.incurredOn > to ||
      !expense.financialBreakdown
    )
      continue;
    for (const tax of expense.financialBreakdown.taxes) {
      const mapping = byCode.get(tax.code);
      if (mapping?.taxComponentId !== row.taxComponentId) continue;
      if (!Number.isSafeInteger(tax.recoverableAmount))
        throw new RangeError('Expense drilldown value must be a safe integer.');
      matches.push({
        expense,
        code: tax.code,
        recoverableMinor: tax.recoverableAmount,
      });
    }
  }
  return matches;
}

export class TaxSummaryReportCollection extends SmrtReportCollection<TaxSummaryReport> {
  static readonly _itemClass = TaxSummaryReport;

  private async assertReadableMoneyModel(): Promise<void> {
    const tenantId = getTenantId();
    if (!tenantId)
      throw new Error('Tax summary report reads require a tenant context.');
    const settings = await TaxSettingsCollection.create({ db: this.db });
    const current = await settings.getForTenant(tenantId);
    if (current?.moneyModel !== 'v2')
      throw new Error(
        'Tax summary requires an activated v2 money model; legacy and migrating tenants are incomplete.',
      );
  }

  override async get(
    filter: Parameters<SmrtCollection<TaxSummaryReport>['get']>[0],
    options: Parameters<SmrtCollection<TaxSummaryReport>['get']>[1] = {},
  ): Promise<TaxSummaryReport | null> {
    await this.assertReadableMoneyModel();
    return super.get(filter, options);
  }

  override async count(
    options: Parameters<SmrtCollection<TaxSummaryReport>['count']>[0] = {},
  ): Promise<number> {
    await this.assertReadableMoneyModel();
    return super.count(options);
  }

  override async list<
    const Select extends readonly SmrtSelectField<TaxSummaryReport>[],
  >(
    options: Omit<SmrtListOptions<TaxSummaryReport>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<Record<string, unknown>[]>;
  override async list<
    const Select extends readonly SmrtSelectField<TaxSummaryReport>[],
  >(
    options: Omit<SmrtListOptions<TaxSummaryReport>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope?: undefined;
    },
  ): Promise<SmrtSelectedRow<TaxSummaryReport, Select>[]>;
  override async list(
    options: Omit<SmrtListOptions<TaxSummaryReport>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<SmrtObject[]>;
  override async list(options?: undefined): Promise<TaxSummaryReport[]>;
  override async list(
    options: Omit<SmrtListOptions<TaxSummaryReport>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope?: undefined;
    },
  ): Promise<TaxSummaryReport[]>;
  override async list(
    options:
      | (Omit<SmrtListOptions<TaxSummaryReport>, 'select'> & {
          select?: undefined;
        })
      | undefined,
  ): Promise<SmrtObject[]>;
  override async list(
    options: SmrtListOptions<TaxSummaryReport> | undefined,
  ): Promise<SmrtObject[] | Record<string, unknown>[]>;
  override async list(
    options: SmrtListOptions<TaxSummaryReport> = {},
  ): Promise<SmrtObject[] | Record<string, unknown>[]> {
    await this.assertReadableMoneyModel();
    return super.list(options);
  }

  /**
   * Rebuild the Invoice path from immutable snapshots. Legacy or migrating
   * tenants are refused because their rows are not a complete v2 tax source.
   */
  async refreshTaxSummary(
    options: RefreshTaxSummaryReportOptions,
  ): Promise<TaxSummaryReportRefreshResult> {
    requiredTenant(options.tenantId);
    orderedRange(options.from, options.to);
    if (!options.expenseSource || !options.ledgerSource)
      throw new Error(
        'Tax summary refresh requires explicit expense and ledger source adapters.',
      );

    return withTenant({ tenantId: options.tenantId }, () =>
      withDocumentMoneyTransaction(this.db, async (tx) => {
        const settings = await TaxSettingsCollection.create({ db: tx });
        const existingSettings = await settings.getForTenant(options.tenantId);
        if (!existingSettings?.id)
          throw new Error(
            'Tax summary requires an activated v2 money model; legacy and migrating tenants are incomplete.',
          );
        await lockDocumentMoneyParents([
          {
            id: existingSettings.id,
            tenantId: options.tenantId,
            collection: settings,
          },
        ]);
        const taxSettings = await settings.getForTenant(options.tenantId);
        if (taxSettings?.moneyModel !== 'v2')
          throw new Error(
            'Tax summary requires an activated v2 money model; legacy and migrating tenants are incomplete.',
          );

        const documentTaxes = await DocumentTaxCollection.create({ db: tx });
        const facts = await documentTaxes.listReportFacts({
          tenantId: options.tenantId,
          from: options.from,
          to: options.to,
        });
        const expenses = await options.expenseSource.listReviewedTaxFacts({
          tenantId: options.tenantId,
          from: calendarDate(options.from),
          to: calendarDate(options.to),
          db: tx,
        });
        const accountIdsByCurrency = new Map<string, Set<string>>();
        for (const fact of facts) {
          if (!fact.liabilityAccountId) continue;
          const accounts =
            accountIdsByCurrency.get(fact.currency) ?? new Set<string>();
          accounts.add(fact.liabilityAccountId);
          accountIdsByCurrency.set(fact.currency, accounts);
        }
        for (const mapping of options.expenseComponentMappings) {
          if (
            mapping.tenantId !== options.tenantId ||
            !mapping.liabilityAccountId
          )
            continue;
          for (const currency of new Set(
            expenses.map((expense) => expense.currency),
          )) {
            const accounts =
              accountIdsByCurrency.get(currency) ?? new Set<string>();
            accounts.add(mapping.liabilityAccountId);
            accountIdsByCurrency.set(currency, accounts);
          }
        }
        const ledgerMovements = (
          await Promise.all(
            [...accountIdsByCurrency.entries()].map(
              async ([currency, accountIds]) =>
                options.ledgerSource.listPostedMovements({
                  tenantId: options.tenantId,
                  accountIds: [...accountIds].sort(),
                  from: options.from,
                  to: options.to,
                  currency,
                  db: tx,
                }),
            ),
          )
        ).flat();
        const result = aggregateTaxSummary({
          tenantId: options.tenantId,
          from: options.from.toISOString(),
          to: options.to.toISOString(),
          facts,
          expenses,
          expenseComponentMappings: options.expenseComponentMappings,
          ledgerMovements,
        });
        const rows = await materializeTaxSummaryRows(options, result);
        const reports = await TaxSummaryReportCollection.create({ db: tx });
        const existing = await reports.list({
          where: {
            tenantId: options.tenantId,
            periodFrom: options.from.toISOString(),
            periodTo: options.to.toISOString(),
          },
        });
        for (const row of existing) await row.delete();
        for (const row of rows) await reports.create(row);
        return { rowCount: rows.length, complete: result.complete };
      }),
    );
  }

  /**
   * Execute the Invoice-path drilldown under a principal-bound tenant. The
   * materialized row cannot expand its own tenant or date range.
   */
  async drilldownInvoiceFacts(
    options: TaxSummaryInvoiceDrilldownOptions,
  ): Promise<InvoiceTaxReportFact[]> {
    requiredTenant(options.tenantId);
    if (!options.reportId?.trim())
      throw new Error('Tax summary drilldown requires a row id.');
    return withTenant({ tenantId: options.tenantId }, async () => {
      const row = await this.get({ id: options.reportId }, { cache: false });
      if (!row || row.tenantId !== options.tenantId)
        throw new Error(
          'Tax summary report row is not visible to this tenant.',
        );
      const source = await DocumentTaxCollection.create({ db: this.db });
      const facts = await source.listReportFacts({
        tenantId: options.tenantId,
        from: row.periodFrom,
        to: row.periodTo,
        currency: row.currency,
      });
      return facts.filter((fact) => {
        if (row.rowKind === 'component')
          return fact.taxComponentId === row.taxComponentId;
        if (row.rowKind === 'kind') return fact.taxCodeKind === row.taxCodeKind;
        if (row.rowKind === 'reconciliation')
          return (
            fact.taxComponentId === row.taxComponentId &&
            (row.liabilityAccountId === null ||
              fact.liabilityAccountId === row.liabilityAccountId)
          );
        if (row.warningSourceType === 'document')
          return reportWarningIdentity(fact) === row.warningSourceId;
        if (row.warningSourceType === 'component')
          return fact.taxComponentId === row.warningSourceId;
        return false;
      });
    });
  }

  /**
   * Re-read the owning sources for one explicitly selected materialized cell.
   * Missing owners and source drift are reported as incomplete instead of being
   * displayed as a zero or as unrelated Invoice facts.
   */
  async drilldownContributors(
    options: TaxSummaryContributorDrilldownOptions,
  ): Promise<TaxSummaryContributorDrilldown> {
    requiredTenant(options.tenantId);
    if (!options.reportId?.trim())
      throw new Error('Tax summary drilldown requires a row id.');
    return withTenant({ tenantId: options.tenantId }, async () => {
      const row = await this.get({ id: options.reportId }, { cache: false });
      if (!row || row.tenantId !== options.tenantId)
        throw new Error(
          'Tax summary report row is not visible to this tenant.',
        );
      assertMeasure(row, options.measure);

      const pending = new Set<TaxSummaryDrilldownPending>();
      if (!row.complete) pending.add('materialized-incomplete');
      const scopes = storedScopes(row);
      if (row.rowKind === 'component' && scopes.size === 0)
        pending.add('source-provenance-missing');
      if (
        row.rowKind === 'warning' &&
        (!row.warningSourceType || !row.warningSourceId)
      )
        pending.add('source-provenance-missing');

      const documentTaxes = await DocumentTaxCollection.create({ db: this.db });
      const facts = await documentTaxes.listReportFacts({
        tenantId: row.tenantId,
        from: row.periodFrom,
        to: row.periodTo,
        currency: row.currency,
      });
      const contributors: TaxSummaryDrilldownContributor[] = [];
      const addDocumentFacts = (
        matches: readonly InvoiceTaxReportFact[],
        value: (fact: InvoiceTaxReportFact) => number,
        distinctDocuments = false,
      ) => {
        const seen = new Set<string>();
        for (const fact of matches) {
          const identity = reportFactIdentity(fact);
          if (distinctDocuments && seen.has(identity)) continue;
          seen.add(identity);
          contributors.push({
            source: fact.documentType === 'contract' ? 'contract' : 'invoice',
            valueMinor: value(fact),
            fact,
          });
        }
      };
      const componentFacts = facts.filter(
        (fact) => fact.taxComponentId === row.taxComponentId,
      );
      const salesComponentFacts = componentFacts.filter(
        (fact) => fact.direction === 'sales',
      );
      const purchaseComponentFacts = componentFacts.filter(
        (fact) => fact.direction === 'purchase',
      );

      const includeExpenses = async (
        sign: 1 | -1,
        distinctExpenses = false,
        exactExpenseId?: string,
      ) => {
        if (!options.expenseSource) {
          pending.add('expense-source');
          return;
        }
        const expenses = await options.expenseSource.listReviewedTaxFacts({
          tenantId: row.tenantId,
          from: calendarDate(row.periodFrom),
          to: calendarDate(row.periodTo),
          db: this.db,
        });
        if (row.rowKind === 'warning' && exactExpenseId !== undefined) {
          const from = calendarDate(row.periodFrom);
          const to = calendarDate(row.periodTo);
          for (const expense of expenses) {
            if (
              expense.tenantId !== row.tenantId ||
              expense.currency !== row.currency ||
              expense.expenseId !== exactExpenseId ||
              expense.incurredOn < from ||
              expense.incurredOn > to
            )
              continue;
            contributors.push({
              source: 'expense',
              valueMinor: 0,
              expense,
              expenseCode: null,
            });
          }
          return;
        }
        const matches = matchingExpenseTaxes(
          expenses,
          row,
          options.expenseComponentMappings ?? [],
        ).filter(({ expense }) =>
          exactExpenseId === undefined
            ? true
            : expense.expenseId === exactExpenseId,
        );
        const seen = new Set<string>();
        for (const match of matches) {
          if (distinctExpenses && seen.has(match.expense.expenseId)) continue;
          seen.add(match.expense.expenseId);
          contributors.push({
            source: 'expense',
            valueMinor: distinctExpenses ? 1 : sign * match.recoverableMinor,
            expense: match.expense,
            expenseCode: match.code,
          });
        }
      };
      const includeLedger = async (sign: 1 | -1) => {
        if (!row.liabilityAccountId && row.rowKind !== 'warning') {
          pending.add('source-provenance-missing');
          return;
        }
        if (!options.ledgerSource) {
          pending.add('ledger-source');
          return;
        }
        const accountId =
          row.rowKind === 'warning'
            ? row.warningSourceId
            : row.liabilityAccountId;
        if (!accountId) {
          pending.add('source-provenance-missing');
          return;
        }
        const movements = await options.ledgerSource.listPostedMovements({
          tenantId: row.tenantId,
          accountIds: [accountId],
          from: row.periodFrom,
          to: row.periodTo,
          currency: row.currency,
          db: this.db,
        });
        for (const movement of movements) {
          const journalTime = movement.journalDate.getTime();
          if (
            movement.tenantId !== row.tenantId ||
            movement.accountId !== accountId ||
            movement.currency !== row.currency ||
            !Number.isFinite(journalTime) ||
            journalTime < row.periodFrom.getTime() ||
            journalTime > row.periodTo.getTime() ||
            !Number.isSafeInteger(movement.creditMinusDebit)
          )
            continue;
          contributors.push({
            source: 'ledger',
            valueMinor: sign * movement.creditMinusDebit,
            movement,
          });
        }
      };

      if (row.rowKind === 'component') {
        switch (options.measure) {
          case 'taxable':
            addDocumentFacts(componentFacts, (fact) =>
              signedFact(fact, fact.taxableMinor),
            );
            break;
          case 'tax':
            addDocumentFacts(salesComponentFacts, (fact) =>
              signedFact(fact, fact.taxMinor),
            );
            break;
          case 'recoverable':
            addDocumentFacts(purchaseComponentFacts, (fact) =>
              signedFact(fact, fact.recoverableMinor),
            );
            if (scopes.has('expense')) await includeExpenses(1);
            break;
          case 'net':
            addDocumentFacts(salesComponentFacts, (fact) =>
              signedFact(fact, fact.taxMinor),
            );
            addDocumentFacts(
              purchaseComponentFacts,
              (fact) => -signedFact(fact, fact.recoverableMinor),
            );
            if (scopes.has('expense')) await includeExpenses(-1);
            break;
          case 'documentCount':
            addDocumentFacts(componentFacts, () => 1, true);
            if (scopes.has('expense')) await includeExpenses(1, true);
            break;
        }
      } else if (row.rowKind === 'kind') {
        const kindFacts = facts.filter(
          (fact) =>
            fact.taxCodeKind === row.taxCodeKind &&
            fact.direction === row.direction,
        );
        if (options.measure === 'taxable') {
          const seen = new Set<string>();
          addDocumentFacts(
            kindFacts.filter((fact) => {
              const key = `${reportFactIdentity(fact)}\u0000${fact.taxCodeId}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
            (fact) => signedFact(fact, fact.taxableMinor),
          );
        } else addDocumentFacts(kindFacts, () => 1, true);
      } else if (row.rowKind === 'reconciliation') {
        const reconciliationFacts = salesComponentFacts.filter(
          (fact) =>
            row.liabilityAccountId === null ||
            fact.liabilityAccountId === row.liabilityAccountId,
        );
        if (options.measure === 'tax')
          addDocumentFacts(reconciliationFacts, (fact) =>
            signedFact(fact, fact.taxMinor),
          );
        if (options.measure === 'ledgerMovement') await includeLedger(1);
        if (options.measure === 'difference') {
          addDocumentFacts(
            reconciliationFacts,
            (fact) => -signedFact(fact, fact.taxMinor),
          );
          await includeLedger(1);
        }
      } else {
        if (row.warningSourceType === 'document') {
          addDocumentFacts(
            facts.filter(
              (fact) => reportWarningIdentity(fact) === row.warningSourceId,
            ),
            () => 0,
          );
        } else if (row.warningSourceType === 'expense') {
          await includeExpenses(1, false, row.warningSourceId ?? undefined);
        } else if (row.warningSourceType === 'component') {
          addDocumentFacts(
            facts.filter((fact) => fact.taxComponentId === row.warningSourceId),
            () => 0,
          );
          if (options.expenseSource) {
            const expenses = await options.expenseSource.listReviewedTaxFacts({
              tenantId: row.tenantId,
              from: calendarDate(row.periodFrom),
              to: calendarDate(row.periodTo),
              db: this.db,
            });
            for (const match of matchingExpenseTaxes(
              expenses,
              { ...row, taxComponentId: row.warningSourceId },
              options.expenseComponentMappings ?? [],
            ))
              contributors.push({
                source: 'expense',
                valueMinor: 0,
                expense: match.expense,
                expenseCode: match.code,
              });
          } else pending.add('expense-source');
        } else if (row.warningSourceType === 'account') {
          await includeLedger(1);
        }
      }

      const expected = reportMeasureValue(row, options.measure);
      const sourceUnavailable = [...pending].some((reason) =>
        [
          'expense-source',
          'ledger-source',
          'purchase-source',
          'source-provenance-missing',
        ].includes(reason),
      );
      if (expected !== null && !sourceUnavailable) {
        const actual = contributors.reduce(
          (total, contributor) =>
            addDrilldownValue(total, contributor.valueMinor),
          0,
        );
        if (actual !== expected) pending.add('source-state-diverged');
      }
      return {
        row,
        measure: options.measure,
        contributors,
        complete: pending.size === 0,
        pending: [...pending].sort(),
      };
    });
  }
}

/** @internal Maps aggregate nullability onto persisted report rows. */
export async function materializeTaxSummaryRows(
  options: Pick<RefreshTaxSummaryReportOptions, 'tenantId' | 'from' | 'to'>,
  result: ReturnType<typeof aggregateTaxSummary>,
): Promise<Array<Record<string, unknown>>> {
  const period = {
    tenantId: options.tenantId,
    periodFrom: options.from,
    periodTo: options.to,
    complete: result.complete,
  };
  const rows = [
    ...result.componentRows.map((row) => ({
      ...period,
      currency: row.currency,
      rowKind: 'component' as const,
      dimensionKey: stableDimension(['component', row.taxComponentId]),
      direction: 'sales',
      taxComponentId: row.taxComponentId,
      taxCodeKind: null,
      liabilityAccountId: row.liabilityAccountId,
      taxableMinor: row.taxableMinor,
      taxMinor: row.collectedMinor,
      recoverableMinor: row.inputTaxCreditMinor,
      ledgerMovementMinor: null,
      netTaxMinor: row.netTaxMinor,
      differenceMinor: null,
      documentCount: row.documentCount,
      sourceScopes: sourceScopes(row.sourceScopes),
      warningCode: null,
      warningMessage: null,
      warningSourceType: null,
      warningSourceId: null,
    })),
    ...result.kindRows.map((row) => ({
      ...period,
      currency: row.currency,
      rowKind: 'kind' as const,
      dimensionKey: stableDimension(['kind', row.direction, row.taxCodeKind]),
      direction: row.direction,
      taxComponentId: null,
      taxCodeKind: row.taxCodeKind,
      liabilityAccountId: null,
      taxableMinor: row.taxableMinor,
      taxMinor: 0,
      recoverableMinor: 0,
      ledgerMovementMinor: null,
      netTaxMinor: null,
      differenceMinor: null,
      documentCount: row.documentCount,
      sourceScopes: sourceScopes(row.sourceScopes),
      warningCode: null,
      warningMessage: null,
      warningSourceType: null,
      warningSourceId: null,
    })),
    ...result.reconciliationRows.map((row) => ({
      ...period,
      currency: row.currency,
      rowKind: 'reconciliation' as const,
      dimensionKey: stableDimension(['reconciliation', row.taxComponentId]),
      direction: 'reconciliation',
      taxComponentId: row.taxComponentId,
      taxCodeKind: null,
      liabilityAccountId: row.liabilityAccountId,
      taxableMinor: 0,
      taxMinor: row.collectedMinor,
      recoverableMinor: 0,
      ledgerMovementMinor: row.ledgerMovementMinor,
      netTaxMinor: null,
      differenceMinor: row.differenceMinor,
      documentCount: 0,
      sourceScopes: sourceScopes(row.sourceScopes),
      warningCode: null,
      warningMessage: null,
      warningSourceType: null,
      warningSourceId: null,
    })),
    ...result.warnings.map((warning, index) => ({
      ...period,
      currency: warning.currency,
      rowKind: 'warning' as const,
      dimensionKey: stableDimension([
        'warning',
        warning.code,
        warning.sourceId,
        String(index),
      ]),
      direction: 'warning',
      taxComponentId: null,
      taxCodeKind: null,
      liabilityAccountId: null,
      taxableMinor: 0,
      taxMinor: 0,
      recoverableMinor: 0,
      ledgerMovementMinor: null,
      netTaxMinor: null,
      differenceMinor: null,
      documentCount: 0,
      sourceScopes: warning.sourceType,
      warningCode: warning.code,
      warningMessage: warning.message,
      warningSourceType: warning.sourceType,
      warningSourceId: warning.sourceId,
    })),
  ];
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      id: await deterministicTaxId(
        options.tenantId,
        'report',
        JSON.stringify([
          options.from.toISOString(),
          options.to.toISOString(),
          row.currency,
          row.rowKind,
          row.dimensionKey,
        ]),
      ),
    })),
  );
}
