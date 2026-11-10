/** Pure projection of frozen commerce money snapshots into accounting SDK inputs. */

import {
  type AccountingProvider,
  type CreditMemoInput,
  type InvoiceInput,
  type InvoiceLineItemInput,
  requireCreditMemoOperations,
  type SyncResult,
  type TaxComponentSnapshot,
} from '@happyvertical/accounting';

import { minorToMajorUnits } from './billing/units.js';
import {
  type LineAmountType,
  MoneyValidationError,
  type TaxRoundingScope,
} from './money.js';

export type FrozenAccountingDocumentKind = 'invoice' | 'creditMemo';

/** Realm-specific references are configuration, never inferred from a tax name or rate. */
export interface FrozenQuickBooksTaxMapping {
  readonly lines: Readonly<
    Record<
      string,
      {
        readonly itemRef: string;
        readonly taxCodeRef: string;
        /** Caller-verified configuration of the referenced realm TaxCode. */
        readonly taxComponents?: readonly {
          readonly taxRateRef: string;
          readonly compound: boolean;
        }[];
      }
    >
  >;
  readonly components: Readonly<
    Record<string, { readonly quickbooksTaxRateRef: string }>
  >;
}

/** Frozen component fact persisted with a line; all values are minor units except percent. */
export interface FrozenAccountingTaxComponent {
  readonly taxComponentId: string;
  readonly name: string;
  /** Exact percent text: `5` means 5 percent. */
  readonly percent: string;
  readonly taxMinor: number;
  readonly compound?: boolean;
  readonly taxableMinor?: number;
}

/** A frozen commerce line. `unitPriceMinor` and `discountMinor` are pre-discount document-mode values. */
export interface FrozenAccountingLineSnapshot {
  readonly id: string;
  readonly description: string;
  readonly sku?: string;
  readonly quantity: number;
  /** Pre-discount unit price: net for exclusive, gross for inclusive. */
  readonly unitPriceMinor: number;
  /** Pre-discount reduction: net for exclusive, gross for inclusive. */
  readonly discountMinor: number;
  /** Persisted post-discount net amount. */
  readonly amountMinor: number;
  readonly taxMinor: number;
  readonly taxComponents: readonly FrozenAccountingTaxComponent[];
}

/** Immutable facts required to project one approved document. */
export interface FrozenAccountingDocumentSnapshot {
  readonly kind: FrozenAccountingDocumentKind;
  readonly id: string;
  readonly number: string;
  readonly customerId: string;
  readonly customerExternalId?: string;
  readonly issueDate: Date;
  readonly dueDate?: Date;
  readonly currency: string;
  readonly lineAmountType: LineAmountType;
  readonly taxRoundingScope: TaxRoundingScope;
  readonly subtotalMinor: number;
  readonly taxAmountMinor: number;
  /** Header-only provider tax has no frozen component and cannot be sent to QBO. */
  readonly providerTaxMinor: number;
  readonly totalAmountMinor: number;
  readonly lineItems: readonly FrozenAccountingLineSnapshot[];
  /** Required only for a positive credit memo. */
  readonly creditedInvoiceExternalId?: string;
  readonly externalId?: string;
  readonly reference?: string;
  readonly memo?: string;
}

/** Public SDK types retained as named aliases for commerce callers. */
export type AccountingTaxComponentInput = TaxComponentSnapshot;
export type AccountingSnapshotLineInput = InvoiceLineItemInput;
export type AccountingSnapshotInvoiceInput = InvoiceInput;
export type AccountingSnapshotCreditMemoInput = CreditMemoInput;
export type AccountingSnapshotInput = InvoiceInput | CreditMemoInput;

/**
 * Map and submit a positive credit memo only when the provider exposes that
 * capability. Mapping runs before the provider is touched, so a malformed
 * frozen snapshot cannot trigger a network write.
 */
export async function pushFrozenCreditMemo(
  provider: Pick<AccountingProvider, 'type' | 'creditMemos'>,
  snapshot: FrozenAccountingDocumentSnapshot,
  mapping: FrozenQuickBooksTaxMapping,
): Promise<SyncResult> {
  if (snapshot.kind !== 'creditMemo') {
    throw new Error('Credit-memo submission requires a creditMemo snapshot');
  }
  const input = mapFrozenAccountingSnapshot(snapshot, mapping);
  if (!('creditMemoNumber' in input)) {
    throw new Error('Credit-memo submission did not produce a credit memo');
  }
  return requireCreditMemoOperations(provider).push(input);
}

function requireText(value: string | undefined, label: string): string {
  if (!value || value.trim() !== value) {
    throw new Error(`${label} must be a nonempty trimmed string`);
  }
  return value;
}

function requireSafeMinor(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer minor amount`);
  }
  return value;
}

function requirePositiveQuantity(quantity: number, lineId: string): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(
      `Line '${lineId}' quantity must be a positive finite number`,
    );
  }
  return quantity;
}

/** Convert exact percent text to the SDK's fraction text without float arithmetic. */
function percentToFraction(percent: string, componentId: string): string {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(percent)) {
    throw new Error(
      `Tax component '${componentId}' percent must be exact decimal text from 0 through 100`,
    );
  }
  const [whole, fraction = ''] = percent.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * scale + BigInt(fraction || '0');
  const denominator = 100n * scale;
  if (numerator > denominator) {
    throw new Error(`Tax component '${componentId}' percent exceeds 100`);
  }
  if (numerator === 0n) return '0';
  if (numerator === denominator) return '1';
  const padded = numerator
    .toString()
    .padStart(denominator.toString().length - 1, '0');
  return `0.${padded}`.replace(/0+$/, '');
}

function globalTaxCalculation(
  lineAmountType: LineAmountType,
): NonNullable<InvoiceInput['quickbooksMapping']>['globalTaxCalculation'] {
  switch (lineAmountType) {
    case 'exclusive':
      return 'TaxExcluded';
    case 'inclusive':
      return 'TaxInclusive';
    case 'none':
      return 'NotApplicable';
  }
}

function mapLine(
  line: FrozenAccountingLineSnapshot,
  currency: string,
  lineAmountType: LineAmountType,
  mapping: FrozenQuickBooksTaxMapping,
): AccountingSnapshotLineInput {
  requireText(line.id, 'Line ID');
  const lineMapping = mapping.lines[line.id];
  if (!lineMapping) {
    throw new Error(
      `Missing explicit QuickBooks mapping for line '${line.id}'`,
    );
  }
  requireText(
    lineMapping.itemRef,
    `QuickBooks item reference for line '${line.id}'`,
  );
  requireText(
    lineMapping.taxCodeRef,
    `QuickBooks tax-code reference for line '${line.id}'`,
  );

  const amountMinor = requireSafeMinor(
    line.amountMinor,
    `Line '${line.id}' amount`,
  );
  const taxMinor = requireSafeMinor(line.taxMinor, `Line '${line.id}' tax`);
  const componentIds = new Set<string>();
  let componentTotalMinor = 0;
  const taxComponents = line.taxComponents.map((component) => {
    if (
      component.compound !== undefined &&
      typeof component.compound !== 'boolean'
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Frozen component compound flag must be boolean',
      );
    if (component.compound && !lineMapping.taxComponents)
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_UNSUPPORTED',
        'Compound accounting sync requires caller-verified ordered realm tax-code mapping',
      );
    if (component.compound && component.taxableMinor === undefined)
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_UNSUPPORTED',
        'Compound accounting sync requires the frozen component taxable basis',
      );
    const basisMinor =
      component.taxableMinor === undefined
        ? undefined
        : requireSafeMinor(
            component.taxableMinor,
            `Line '${line.id}' component taxable basis`,
          );
    if (
      basisMinor !== undefined &&
      basisMinor !==
        amountMinor + (component.compound ? componentTotalMinor : 0)
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_UNSUPPORTED',
        'Frozen component taxable basis does not match ordered source facts',
      );
    requireText(component.taxComponentId, `Line '${line.id}' tax component ID`);
    if (componentIds.has(component.taxComponentId)) {
      throw new Error(
        `Line '${line.id}' repeats tax component '${component.taxComponentId}'`,
      );
    }
    componentIds.add(component.taxComponentId);
    const taxAmountMinor = requireSafeMinor(
      component.taxMinor,
      `Line '${line.id}' component '${component.taxComponentId}' tax`,
    );
    componentTotalMinor += taxAmountMinor;
    const componentMapping = mapping.components[component.taxComponentId];
    if (!componentMapping) {
      throw new Error(
        `Missing explicit QuickBooks tax-rate reference for component '${component.taxComponentId}'`,
      );
    }
    requireText(
      componentMapping.quickbooksTaxRateRef,
      `QuickBooks tax-rate reference for component '${component.taxComponentId}'`,
    );
    return {
      taxCode: component.taxComponentId,
      rate: percentToFraction(component.percent, component.taxComponentId),
      quickbooksTaxRateRef: componentMapping.quickbooksTaxRateRef,
      taxAmount: minorToMajorUnits(taxAmountMinor, currency),
      ...(component.compound ? { compound: true } : {}),
      ...(basisMinor !== undefined
        ? { taxableAmount: minorToMajorUnits(basisMinor, currency) }
        : {}),
    };
  });
  if (
    lineMapping.taxComponents &&
    (lineMapping.taxComponents.length !== taxComponents.length ||
      lineMapping.taxComponents.some(
        (part, index) =>
          part.taxRateRef !== taxComponents[index].quickbooksTaxRateRef ||
          typeof part.compound !== 'boolean' ||
          part.compound !== (taxComponents[index].compound ?? false),
      ))
  )
    throw new MoneyValidationError(
      'ACCOUNTING_SYNC_UNSUPPORTED',
      'Ordered realm tax-code mapping does not match frozen components',
    );
  if (componentTotalMinor !== taxMinor) {
    throw new Error(
      `Line '${line.id}' frozen component tax ${componentTotalMinor} does not equal line tax ${taxMinor}`,
    );
  }
  if (taxMinor > 0 && taxComponents.length === 0) {
    throw new Error(`Line '${line.id}' tax requires frozen tax components`);
  }

  const discountMinor = requireSafeMinor(
    line.discountMinor,
    `Line '${line.id}' discount`,
  );
  const unitPriceMinor = requireSafeMinor(
    line.unitPriceMinor,
    `Line '${line.id}' unit price`,
  );
  const result = {
    description: requireText(line.description, `Line '${line.id}' description`),
    sku: line.sku || undefined,
    quantity: requirePositiveQuantity(line.quantity, line.id),
    unitPrice: minorToMajorUnits(unitPriceMinor, currency),
    ...(discountMinor === 0
      ? {}
      : { discount: minorToMajorUnits(discountMinor, currency) }),
    amount: minorToMajorUnits(amountMinor, currency),
    taxAmount: minorToMajorUnits(taxMinor, currency),
    taxComponents,
    quickbooksMapping: {
      itemRef: lineMapping.itemRef,
      taxCodeRef: lineMapping.taxCodeRef,
      ...(lineMapping.taxComponents
        ? {
            taxComponents: lineMapping.taxComponents.map((part) => ({
              ...part,
            })),
          }
        : {}),
    },
  };
  if (lineAmountType === 'inclusive') {
    // This is an exact representation of two stored facts, never a tax calculation.
    return {
      ...result,
      taxInclusiveAmount: minorToMajorUnits(amountMinor + taxMinor, currency),
    };
  }
  return result;
}

/**
 * Project an approved frozen snapshot into the companion SDK's request shape.
 * It does not calculate discounts, taxes, rates, or document allocation.
 */
export function mapFrozenAccountingSnapshot(
  snapshot: FrozenAccountingDocumentSnapshot,
  mapping: FrozenQuickBooksTaxMapping,
): AccountingSnapshotInput {
  const currency = requireText(snapshot.currency, 'Currency');
  requireText(snapshot.id, 'Document ID');
  requireText(snapshot.number, 'Document number');
  requireText(snapshot.customerId, 'Customer ID');
  if (
    !(snapshot.issueDate instanceof Date) ||
    Number.isNaN(snapshot.issueDate.valueOf())
  ) {
    throw new Error('Issue date must be a valid Date');
  }
  if (!Array.isArray(snapshot.lineItems) || snapshot.lineItems.length === 0) {
    throw new Error('Frozen document requires at least one line item');
  }
  const subtotalMinor = requireSafeMinor(snapshot.subtotalMinor, 'Subtotal');
  const taxAmountMinor = requireSafeMinor(
    snapshot.taxAmountMinor,
    'Tax amount',
  );
  const providerTaxMinor = requireSafeMinor(
    snapshot.providerTaxMinor,
    'Provider tax',
  );
  const totalAmountMinor = requireSafeMinor(snapshot.totalAmountMinor, 'Total');
  if (providerTaxMinor !== 0) {
    throw new Error(
      'Frozen provider tax cannot be mapped to QuickBooks without a stored component snapshot and explicit tax-rate reference',
    );
  }
  if (subtotalMinor + taxAmountMinor !== totalAmountMinor) {
    throw new Error('Frozen subtotal plus tax must equal frozen total');
  }

  const lineItems = snapshot.lineItems.map((line) =>
    mapLine(line, currency, snapshot.lineAmountType, mapping),
  );
  const linesSubtotalMinor = snapshot.lineItems.reduce(
    (sum, line) => sum + line.amountMinor,
    0,
  );
  const linesTaxMinor = snapshot.lineItems.reduce(
    (sum, line) => sum + line.taxMinor,
    0,
  );
  if (linesSubtotalMinor !== subtotalMinor) {
    throw new Error('Frozen line net amounts do not equal frozen subtotal');
  }
  if (linesTaxMinor !== taxAmountMinor) {
    throw new Error('Frozen line tax amounts do not equal frozen tax total');
  }

  const base = {
    id: snapshot.id,
    externalId: snapshot.externalId,
    customerId: snapshot.customerId,
    customerExternalId: snapshot.customerExternalId,
    issueDate: snapshot.issueDate,
    currency,
    subtotal: minorToMajorUnits(subtotalMinor, currency),
    taxAmount: minorToMajorUnits(taxAmountMinor, currency),
    totalAmount: minorToMajorUnits(totalAmountMinor, currency),
    lineItems,
    quickbooksMapping: {
      globalTaxCalculation: globalTaxCalculation(snapshot.lineAmountType),
    },
    reference: snapshot.reference,
    memo: snapshot.memo,
  } as const;

  if (snapshot.kind === 'invoice') {
    if (
      !(snapshot.dueDate instanceof Date) ||
      Number.isNaN(snapshot.dueDate.valueOf())
    ) {
      throw new Error('Invoice due date must be a valid Date');
    }
    return {
      ...base,
      invoiceNumber: snapshot.number,
      dueDate: snapshot.dueDate,
    };
  }
  const creditedInvoiceExternalId = requireText(
    snapshot.creditedInvoiceExternalId,
    'Credited invoice external ID',
  );
  if (subtotalMinor === 0 || totalAmountMinor === 0) {
    throw new Error('Credit memo amounts must be positive');
  }
  return {
    ...base,
    creditMemoNumber: snapshot.number,
    creditedInvoiceExternalId,
  };
}
