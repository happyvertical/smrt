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
  documentType: 'invoice' | 'credit_note' | 'contract';
  documentId: string;
  /** Invoice credits store positive facts and are negated here exactly once. */
  documentKind: 'invoice' | 'credit_note' | 'contract';
  issueDate: string;
  status: string;
  direction: TaxSummaryDirection;
  currency: string;
  /** Null means the stored snapshot cannot be assigned to a tax code. */
  taxCodeId: string | null;
  /** Null is an incomplete/unassigned stored snapshot, never out-of-scope. */
  taxCodeKind: TaxCodeKind | null;
  taxableMinor: number;
  netMinor?: number;
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
  /** Sum of stored component taxable bases; components intentionally overlap. */
  taxableMinor: number;
  collectedMinor: number;
  purchaseRecoverableMinor: number;
  expenseRecoverableMinor: number;
  /** Null when unknown or ambiguous facts make an exact ITC unsafe. */
  inputTaxCreditMinor: number | null;
  /** Null when the corresponding ITC is incomplete. */
  netTaxMinor: number | null;
  documentCount: number;
  /** Stable source classes used to reproduce a materialized drilldown. */
  sourceScopes: readonly TaxSummarySourceScope[];
}

export interface TaxSummaryKindRow {
  rowKind: 'kind';
  currency: string;
  direction: TaxSummaryDirection;
  taxCodeKind: TaxCodeKind;
  taxableMinor: number;
  documentCount: number;
  sourceScopes: readonly TaxSummarySourceScope[];
}

export interface TaxSummaryReconciliationRow {
  rowKind: 'reconciliation';
  currency: string;
  taxComponentId: string;
  liabilityAccountId: string | null;
  collectedMinor: number;
  ledgerMovementMinor: number | null;
  differenceMinor: number | null;
  status: 'reconciled' | 'difference' | 'unassigned' | 'ambiguous';
  sourceScopes: readonly TaxSummarySourceScope[];
}

/** Source classes persisted for drilldown; amounts remain in the report rows. */
export type TaxSummarySourceScope =
  | 'invoice'
  | 'purchase'
  | 'expense'
  | 'ledger';

export interface TaxSummaryWarning {
  code:
    | 'unknown-expense-tax'
    | 'unmapped-expense-component'
    | 'linked-purchase-expense'
    | 'unassigned-liability-account'
    | 'shared-liability-account'
    | 'unassigned-tax-code';
  currency: string;
  sourceId: string;
  sourceType: 'document' | 'expense' | 'component' | 'account';
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

function addMinor(left: number, right: number, label: string) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum))
    throw new RangeError(`${label} exceeds the safe integer minor-unit range.`);
  return sum;
}

function inPeriod(date: string, from: string, to: string) {
  return date >= from && date <= to;
}

/** Expenses use calendar dates, even when a report range is an ISO timestamp. */
function expenseCalendarDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(value);
  return match?.[1] ?? value;
}

function expenseInPeriod(date: string, from: string, to: string) {
  return inPeriod(
    expenseCalendarDate(date),
    expenseCalendarDate(from),
    expenseCalendarDate(to),
  );
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

function mergeSourceScopes(
  current: readonly TaxSummarySourceScope[],
  next: TaxSummarySourceScope,
): TaxSummarySourceScope[] {
  return [...new Set<TaxSummarySourceScope>([...current, next])];
}

/** Aggregate normalized stored facts without querying persistence. */
export function aggregateTaxSummary(input: TaxSummaryInput): TaxSummaryResult {
  if (!input.tenantId || !input.from || !input.to || input.from > input.to)
    throw new TypeError('Tax summary requires a tenant and ordered period.');
  const warnings: TaxSummaryWarning[] = [];
  let complete = true;
  const components = new Map<string, TaxSummaryComponentRow>();
  const kinds = new Map<string, TaxSummaryKindRow>();
  const baseSeen = new Set<string>();
  const componentDocuments = new Map<string, Set<string>>();
  const kindDocuments = new Map<string, Set<string>>();
  const purchaseLinks: Array<{
    currency: string;
    commitmentId: string;
    lineId: string | null;
  }> = [];

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
        taxableMinor: 0,
        collectedMinor: 0,
        purchaseRecoverableMinor: 0,
        expenseRecoverableMinor: 0,
        inputTaxCreditMinor: 0,
        netTaxMinor: 0,
        documentCount: 0,
        sourceScopes: [],
      };
      components.set(key, row);
    }
    return row;
  };

  for (const fact of input.facts) {
    assertMinor(fact.taxableMinor, 'taxableMinor');
    if (fact.netMinor !== undefined) assertMinor(fact.netMinor, 'netMinor');
    assertMinor(fact.taxMinor, 'taxMinor');
    assertMinor(fact.recoverableMinor, 'recoverableMinor');
    if (!usableFact(fact, input)) continue;
    const sign = sourceSign(fact.documentKind);
    const documentIdentity = `${fact.documentType}\u0000${fact.documentId}`;
    if (!fact.taxCodeId || !fact.taxCodeKind) {
      complete = false;
      warnings.push({
        code: 'unassigned-tax-code',
        currency: fact.currency,
        // Persisted warning identities cannot contain NUL (PostgreSQL text
        // rejects it and SQLite truncates it), unlike in-memory map keys.
        sourceId: JSON.stringify([fact.documentType, fact.documentId]),
        sourceType: 'document',
        message:
          'Document tax snapshot has no tax-code kind and cannot be classified.',
      });
      continue;
    }
    const kindKey = `${fact.currency}\u0000${fact.direction}\u0000${fact.taxCodeKind}`;
    const baseKey = `${documentIdentity}\u0000${fact.taxCodeId}\u0000${kindKey}`;
    if (fact.direction === 'purchase' && fact.commitmentId)
      purchaseLinks.push({
        currency: fact.currency,
        commitmentId: fact.commitmentId,
        lineId: fact.commitmentLineId ?? null,
      });
    if (!baseSeen.has(baseKey)) {
      baseSeen.add(baseKey);
      const row = kinds.get(kindKey) ?? {
        rowKind: 'kind' as const,
        currency: fact.currency,
        direction: fact.direction,
        taxCodeKind: fact.taxCodeKind,
        taxableMinor: 0,
        documentCount: 0,
        sourceScopes: [fact.direction === 'sales' ? 'invoice' : 'purchase'],
      };
      row.taxableMinor = addMinor(
        row.taxableMinor,
        sign * (fact.netMinor ?? fact.taxableMinor),
        'kind taxable total',
      );
      const documents = kindDocuments.get(kindKey) ?? new Set<string>();
      documents.add(documentIdentity);
      kindDocuments.set(kindKey, documents);
      row.documentCount = documents.size;
      kinds.set(kindKey, row);
    }
    if (fact.taxComponentId) {
      const row = component(
        fact.currency,
        fact.taxComponentId,
        fact.componentName ?? fact.taxComponentId,
        fact.liabilityAccountId,
      );
      row.taxableMinor = addMinor(
        row.taxableMinor,
        sign * fact.taxableMinor,
        'component taxable total',
      );
      const documents =
        componentDocuments.get(
          componentKey(fact.currency, fact.taxComponentId),
        ) ?? new Set<string>();
      documents.add(documentIdentity);
      componentDocuments.set(
        componentKey(fact.currency, fact.taxComponentId),
        documents,
      );
      row.documentCount = documents.size;
      row.sourceScopes = mergeSourceScopes(
        row.sourceScopes,
        fact.direction === 'sales' ? 'invoice' : 'purchase',
      );
      if (fact.direction === 'sales')
        row.collectedMinor = addMinor(
          row.collectedMinor,
          sign * fact.taxMinor,
          'collected tax total',
        );
      else
        row.purchaseRecoverableMinor = addMinor(
          row.purchaseRecoverableMinor,
          sign * fact.recoverableMinor,
          'purchase ITC total',
        );
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
      !expenseInPeriod(expense.incurredOn, input.from, input.to)
    )
      continue;
    if (!expense.financialBreakdown) {
      complete = false;
      warnings.push({
        code: 'unknown-expense-tax',
        currency: expense.currency,
        sourceId: expense.expenseId,
        sourceType: 'expense',
        message: 'Expense has no stored supplier tax facts.',
      });
      continue;
    }
    const linked =
      expense.commitmentId !== null &&
      purchaseLinks.some(
        (purchase) =>
          purchase.currency === expense.currency &&
          purchase.commitmentId === expense.commitmentId &&
          (purchase.lineId === null ||
            expense.commitmentLineId === null ||
            purchase.lineId === expense.commitmentLineId),
      );
    if (linked) {
      complete = false;
      warnings.push({
        code: 'linked-purchase-expense',
        currency: expense.currency,
        sourceId: expense.expenseId,
        sourceType: 'expense',
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
          sourceType: 'expense',
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
      row.expenseRecoverableMinor = addMinor(
        row.expenseRecoverableMinor,
        tax.recoverableAmount,
        'expense ITC total',
      );
      row.sourceScopes = mergeSourceScopes(row.sourceScopes, 'expense');
      const documents =
        componentDocuments.get(
          componentKey(expense.currency, mapping.taxComponentId),
        ) ?? new Set<string>();
      documents.add(`expense\u0000${expense.expenseId}`);
      componentDocuments.set(
        componentKey(expense.currency, mapping.taxComponentId),
        documents,
      );
      row.documentCount = documents.size;
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
      addMinor(
        ledgerByAccount.get(key) ?? 0,
        movement.creditMinusDebit,
        'ledger movement total',
      ),
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
      row.inputTaxCreditMinor = addMinor(
        row.purchaseRecoverableMinor,
        row.expenseRecoverableMinor,
        'input tax credit total',
      );
      row.netTaxMinor = addMinor(
        row.collectedMinor,
        -row.inputTaxCreditMinor,
        'net tax total',
      );
    }
  }
  const sharedAccounts = new Map<string, TaxSummaryComponentRow[]>();
  for (const row of componentRows) {
    if (!row.liabilityAccountId) continue;
    const key = `${row.currency}\u0000${row.liabilityAccountId}`;
    sharedAccounts.set(key, [...(sharedAccounts.get(key) ?? []), row]);
  }
  const reconciliationRows = componentRows.map((row) => {
    if (!row.liabilityAccountId) {
      warnings.push({
        code: 'unassigned-liability-account',
        currency: row.currency,
        sourceId: row.taxComponentId,
        sourceType: 'component',
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
        sourceScopes: row.sourceScopes,
      };
    }
    if (
      (sharedAccounts.get(`${row.currency}\u0000${row.liabilityAccountId}`)
        ?.length ?? 0) > 1
    ) {
      complete = false;
      warnings.push({
        code: 'shared-liability-account',
        currency: row.currency,
        sourceId: row.liabilityAccountId,
        sourceType: 'account',
        message:
          'Multiple tax components share one liability account, so per-component reconciliation is ambiguous.',
      });
      return {
        rowKind: 'reconciliation' as const,
        currency: row.currency,
        taxComponentId: row.taxComponentId,
        liabilityAccountId: row.liabilityAccountId,
        collectedMinor: row.collectedMinor,
        ledgerMovementMinor: null,
        differenceMinor: null,
        status: 'ambiguous' as const,
        sourceScopes: mergeSourceScopes(row.sourceScopes, 'ledger'),
      };
    }
    const ledgerMovementMinor =
      ledgerByAccount.get(`${row.currency}\u0000${row.liabilityAccountId}`) ??
      0;
    const differenceMinor = addMinor(
      ledgerMovementMinor,
      -row.collectedMinor,
      'reconciliation difference',
    );
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
      sourceScopes: mergeSourceScopes(row.sourceScopes, 'ledger'),
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
