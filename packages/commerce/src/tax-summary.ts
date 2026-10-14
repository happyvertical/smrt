/**
 * Pure stored-fact aggregation for the commerce tax summary report.
 *
 * Persistence owns source queries. This module deliberately accepts normalized
 * snapshots so report arithmetic is testable without reaching into documents.
 */

export type TaxCodeKind = 'taxable' | 'zero-rated' | 'exempt' | 'out-of-scope';
export type TaxSummaryDirection = 'sales' | 'purchase';

export interface TaxSummaryStoredFact {
  tenantId: string;
  documentId: string;
  /** Invoice credits store positive facts and are negated here exactly once. */
  documentKind: 'invoice' | 'credit_note' | 'contract';
  issueDate: string;
  status: string;
  direction: TaxSummaryDirection;
  currency: string;
  taxCodeId: string;
  taxCodeKind: TaxCodeKind;
  taxableMinor: number;
  taxMinor: number;
  recoverableMinor: number;
  taxComponentId: string | null;
  componentName: string | null;
  liabilityAccountId: string | null;
  commitmentId?: string | null;
  commitmentLineId?: string | null;
}

export interface TaxSummaryExpenseFact {
  tenantId: string;
  expenseId: string;
  incurredOn: string;
  currency: string;
  commitmentId: string | null;
  commitmentLineId: string | null;
  /** Null means a legacy fact whose supplier tax is unknown. */
  financialBreakdown: {
    taxes: ReadonlyArray<{
      code: string;
      amount: number;
      recoverableAmount: number;
    }>;
  } | null;
}

export interface TaxSummaryComponentMapping {
  tenantId: string;
  expenseCode: string;
  taxComponentId: string;
  componentName: string;
  liabilityAccountId: string | null;
}

export interface TaxSummaryLedgerMovement {
  tenantId: string;
  entryId: string;
  accountId: string;
  currency: string;
  creditMinusDebit: number;
}

export interface TaxSummaryInput {
  tenantId: string;
  from: string;
  to: string;
  facts: ReadonlyArray<TaxSummaryStoredFact>;
  expenses: ReadonlyArray<TaxSummaryExpenseFact>;
  expenseComponentMappings: ReadonlyArray<TaxSummaryComponentMapping>;
  ledgerMovements: ReadonlyArray<TaxSummaryLedgerMovement>;
}

export interface TaxSummaryComponentRow {
  rowKind: 'component';
  currency: string;
  taxComponentId: string;
  componentName: string;
  liabilityAccountId: string | null;
  collectedMinor: number;
  purchaseRecoverableMinor: number;
  expenseRecoverableMinor: number;
  /** Null when unknown or ambiguous facts make an exact ITC unsafe. */
  inputTaxCreditMinor: number | null;
  /** Null when the corresponding ITC is incomplete. */
  netTaxMinor: number | null;
  documentCount: number;
}

export interface TaxSummaryKindRow {
  rowKind: 'kind';
  currency: string;
  direction: TaxSummaryDirection;
  taxCodeKind: TaxCodeKind;
  taxableMinor: number;
  documentCount: number;
}

export interface TaxSummaryReconciliationRow {
  rowKind: 'reconciliation';
  currency: string;
  taxComponentId: string;
  liabilityAccountId: string | null;
  collectedMinor: number;
  ledgerMovementMinor: number | null;
  differenceMinor: number | null;
  status: 'reconciled' | 'difference' | 'unassigned';
}

export interface TaxSummaryWarning {
  code:
    | 'unknown-expense-tax'
    | 'unmapped-expense-component'
    | 'linked-purchase-expense'
    | 'unassigned-liability-account';
  currency: string;
  sourceId: string;
  message: string;
}

export interface TaxSummaryResult {
  componentRows: TaxSummaryComponentRow[];
  kindRows: TaxSummaryKindRow[];
  reconciliationRows: TaxSummaryReconciliationRow[];
  warnings: TaxSummaryWarning[];
  /** False means no row may be presented as an exact reconciled net tax total. */
  complete: boolean;
}

function assertMinor(value: number, label: string) {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${label} must be a safe integer minor-unit value.`);
}

function inPeriod(date: string, from: string, to: string) {
  return date >= from && date <= to;
}

function sourceSign(kind: TaxSummaryStoredFact['documentKind']) {
  return kind === 'credit_note' ? -1 : 1;
}

function usableFact(fact: TaxSummaryStoredFact, input: TaxSummaryInput) {
  return (
    fact.tenantId === input.tenantId &&
    inPeriod(fact.issueDate, input.from, input.to) &&
    fact.status !== 'draft' &&
    fact.status !== 'cancelled'
  );
}

function componentKey(currency: string, componentId: string) {
  return `${currency}\u0000${componentId}`;
}

/** Aggregate normalized stored facts without querying persistence. */
export function aggregateTaxSummary(input: TaxSummaryInput): TaxSummaryResult {
  if (!input.tenantId || !input.from || !input.to || input.from > input.to)
    throw new TypeError('Tax summary requires a tenant and ordered period.');
  const warnings: TaxSummaryWarning[] = [];
  let complete = true;
  const components = new Map<string, TaxSummaryComponentRow>();
  const kinds = new Map<string, TaxSummaryKindRow>();
  const salesBaseSeen = new Set<string>();
  const linkedPurchaseKeys = new Set<string>();

  const component = (
    currency: string,
    taxComponentId: string,
    componentName: string,
    liabilityAccountId: string | null,
  ) => {
    const key = componentKey(currency, taxComponentId);
    let row = components.get(key);
    if (!row) {
      row = {
        rowKind: 'component',
        currency,
        taxComponentId,
        componentName,
        liabilityAccountId,
        collectedMinor: 0,
        purchaseRecoverableMinor: 0,
        expenseRecoverableMinor: 0,
        inputTaxCreditMinor: 0,
        netTaxMinor: 0,
        documentCount: 0,
      };
      components.set(key, row);
    }
    return row;
  };

  for (const fact of input.facts) {
    assertMinor(fact.taxableMinor, 'taxableMinor');
    assertMinor(fact.taxMinor, 'taxMinor');
    assertMinor(fact.recoverableMinor, 'recoverableMinor');
    if (!usableFact(fact, input)) continue;
    const sign = sourceSign(fact.documentKind);
    const kindKey = `${fact.currency}\u0000${fact.direction}\u0000${fact.taxCodeKind}`;
    const baseKey = `${fact.documentId}\u0000${fact.taxCodeId}\u0000${kindKey}`;
    if (fact.direction === 'purchase' && fact.commitmentId)
      linkedPurchaseKeys.add(
        `${fact.commitmentId}\u0000${fact.commitmentLineId ?? ''}`,
      );
    if (!salesBaseSeen.has(baseKey)) {
      salesBaseSeen.add(baseKey);
      const row = kinds.get(kindKey) ?? {
        rowKind: 'kind' as const,
        currency: fact.currency,
        direction: fact.direction,
        taxCodeKind: fact.taxCodeKind,
        taxableMinor: 0,
        documentCount: 0,
      };
      row.taxableMinor += sign * fact.taxableMinor;
      row.documentCount += 1;
      kinds.set(kindKey, row);
    }
    if (fact.taxComponentId) {
      const row = component(
        fact.currency,
        fact.taxComponentId,
        fact.componentName ?? fact.taxComponentId,
        fact.liabilityAccountId,
      );
      row.documentCount += 1;
      if (fact.direction === 'sales')
        row.collectedMinor += sign * fact.taxMinor;
      else row.purchaseRecoverableMinor += sign * fact.recoverableMinor;
    }
  }

  const mappings = new Map(
    input.expenseComponentMappings
      .filter((mapping) => mapping.tenantId === input.tenantId)
      .map((mapping) => [mapping.expenseCode, mapping]),
  );
  const ambiguousComponents = new Set<string>();
  for (const expense of input.expenses) {
    if (
      expense.tenantId !== input.tenantId ||
      !inPeriod(expense.incurredOn, input.from, input.to)
    )
      continue;
    if (!expense.financialBreakdown) {
      complete = false;
      warnings.push({
        code: 'unknown-expense-tax',
        currency: expense.currency,
        sourceId: expense.expenseId,
        message: 'Expense has no stored supplier tax facts.',
      });
      continue;
    }
    const link = expense.commitmentId
      ? `${expense.commitmentId}\u0000${expense.commitmentLineId ?? ''}`
      : null;
    const linked = link !== null && linkedPurchaseKeys.has(link);
    if (linked) {
      complete = false;
      warnings.push({
        code: 'linked-purchase-expense',
        currency: expense.currency,
        sourceId: expense.expenseId,
        message:
          'Linked purchase and expense need allocation before their ITC can be reconciled.',
      });
    }
    for (const tax of expense.financialBreakdown.taxes) {
      assertMinor(tax.amount, 'expense tax amount');
      assertMinor(tax.recoverableAmount, 'expense recoverable amount');
      const mapping = mappings.get(tax.code);
      if (!mapping) {
        complete = false;
        warnings.push({
          code: 'unmapped-expense-component',
          currency: expense.currency,
          sourceId: expense.expenseId,
          message: `Expense tax component ${tax.code} has no tenant-approved mapping.`,
        });
        continue;
      }
      const row = component(
        expense.currency,
        mapping.taxComponentId,
        mapping.componentName,
        mapping.liabilityAccountId,
      );
      row.expenseRecoverableMinor += tax.recoverableAmount;
      row.documentCount += 1;
      if (linked)
        ambiguousComponents.add(
          componentKey(expense.currency, mapping.taxComponentId),
        );
    }
  }

  const ledgerByAccount = new Map<string, number>();
  for (const movement of input.ledgerMovements) {
    if (movement.tenantId !== input.tenantId) continue;
    assertMinor(movement.creditMinusDebit, 'ledger movement');
    const key = `${movement.currency}\u0000${movement.accountId}`;
    ledgerByAccount.set(
      key,
      (ledgerByAccount.get(key) ?? 0) + movement.creditMinusDebit,
    );
  }

  const componentRows = [...components.values()].sort((a, b) =>
    componentKey(a.currency, a.taxComponentId).localeCompare(
      componentKey(b.currency, b.taxComponentId),
    ),
  );
  for (const row of componentRows) {
    if (
      ambiguousComponents.has(componentKey(row.currency, row.taxComponentId))
    ) {
      row.inputTaxCreditMinor = null;
      row.netTaxMinor = null;
    } else {
      row.inputTaxCreditMinor =
        row.purchaseRecoverableMinor + row.expenseRecoverableMinor;
      row.netTaxMinor = row.collectedMinor - row.inputTaxCreditMinor;
    }
  }
  const reconciliationRows = componentRows.map((row) => {
    if (!row.liabilityAccountId) {
      warnings.push({
        code: 'unassigned-liability-account',
        currency: row.currency,
        sourceId: row.taxComponentId,
        message: 'Tax component has no liability account for reconciliation.',
      });
      return {
        rowKind: 'reconciliation' as const,
        currency: row.currency,
        taxComponentId: row.taxComponentId,
        liabilityAccountId: null,
        collectedMinor: row.collectedMinor,
        ledgerMovementMinor: null,
        differenceMinor: null,
        status: 'unassigned' as const,
      };
    }
    const ledgerMovementMinor =
      ledgerByAccount.get(`${row.currency}\u0000${row.liabilityAccountId}`) ??
      0;
    const differenceMinor = ledgerMovementMinor - row.collectedMinor;
    return {
      rowKind: 'reconciliation' as const,
      currency: row.currency,
      taxComponentId: row.taxComponentId,
      liabilityAccountId: row.liabilityAccountId,
      collectedMinor: row.collectedMinor,
      ledgerMovementMinor,
      differenceMinor,
      status:
        differenceMinor === 0
          ? ('reconciled' as const)
          : ('difference' as const),
    };
  });
  return {
    componentRows,
    kindRows: [...kinds.values()].sort((a, b) =>
      `${a.currency}\u0000${a.direction}\u0000${a.taxCodeKind}`.localeCompare(
        `${b.currency}\u0000${b.direction}\u0000${b.taxCodeKind}`,
      ),
    ),
    reconciliationRows,
    warnings,
    complete,
  };
}
