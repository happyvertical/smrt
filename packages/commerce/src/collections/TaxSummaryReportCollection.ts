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
        return true;
      });
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
      warningCode: null,
      warningMessage: null,
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
      warningCode: null,
      warningMessage: null,
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
      warningCode: null,
      warningMessage: null,
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
      warningCode: warning.code,
      warningMessage: warning.message,
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
