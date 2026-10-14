/** Exact invoice-scope allocation over the existing resolved line model. */
import { calculateOrderedCostBillingTax } from './cost-billing.js';
import {
  calculateInvoiceMinorLine,
  type InvoiceMinorLineInput,
} from './svelte/invoices/calculations.js';

/** Resolved model inputs with stable persisted line identity. */
export interface InvoiceRoundingLine extends InvoiceMinorLineInput {
  /** Stable line ID; tie allocation never depends on display order. */
  id: string;
}

/** Canonical amounts for one line after invoice-scope allocation. */
export interface InvoiceAllocatedLine {
  /** Persisted line ID. */
  id: string;
  /** Discounted net in integer minor units. */
  subtotalMinor: number;
  /** Allocated tax in integer minor units. */
  taxMinor: number;
  /** Net plus allocated tax in integer minor units. */
  totalMinor: number;
}

/** Conservative invoice allocation and its exact aggregate. */
export interface InvoiceAllocatedAmounts {
  /** Lines sorted by stable code-unit ID order. */
  lines: InvoiceAllocatedLine[];
  /** Sum of discounted line nets. */
  subtotalMinor: number;
  /** Sum of allocated tax. */
  taxMinor: number;
  /** Net plus tax. */
  totalMinor: number;
}

function safeMinor(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError('Invoice allocated amount exceeds safe minor units');
  return result;
}

/** Convert an already validated eight-place fractional rate without float multiplication. */
function percentOf(rate: number): string {
  const [whole, fractional = ''] = rate.toFixed(8).split('.');
  const coefficient = BigInt(whole + fractional);
  const percentWhole = coefficient / 1000000n;
  const percentFraction = (coefficient % 1000000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${percentWhole}${percentFraction ? `.${percentFraction}` : ''}`;
}

/**
 * Allocate the explicitly selected invoice scope using the public cost-billing
 * convention. This pure helper neither selects tenant policy nor persists rows.
 * Gross/discount semantics remain those of the existing InvoiceLineItem model.
 */
export function allocateInvoiceTax(
  input: readonly InvoiceRoundingLine[],
): InvoiceAllocatedAmounts {
  const ids = new Set<string>();
  const resolved = input.map((line) => {
    if (typeof line.id !== 'string' || !line.id || ids.has(line.id))
      throw new RangeError(
        'Invoice allocation requires distinct stable line IDs',
      );
    ids.add(line.id);
    const amounts = calculateInvoiceMinorLine(line);
    return {
      id: line.id,
      amountMinor: amounts.subtotalMinor,
      category: percentOf(line.taxRate),
    };
  });
  const rates = [...new Set(resolved.map((line) => line.category))].sort();
  const allocation = calculateOrderedCostBillingTax({
    lines: resolved,
    categories: rates.map((percent) => ({
      category: percent,
      componentIds: [percent],
    })),
    components: rates.map((percent) => ({
      id: percent,
      percent,
      priorComponentIds: [],
    })),
    roundingScope: 'invoice',
    invoiceAllocation: 'signed-largest-remainder',
  });
  const taxes = new Map(
    allocation.components.flatMap((component) =>
      component.lines.map((line) => [line.id, line.taxMinor] as const),
    ),
  );
  const lines = resolved
    .map((line) => {
      const taxMinor = taxes.get(line.id) ?? 0;
      return {
        id: line.id,
        subtotalMinor: line.amountMinor,
        taxMinor,
        totalMinor: safeMinor(BigInt(line.amountMinor) + BigInt(taxMinor)),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const subtotal = lines.reduce(
    (sum, line) => sum + BigInt(line.subtotalMinor),
    0n,
  );
  return {
    lines,
    subtotalMinor: safeMinor(subtotal),
    taxMinor: allocation.taxMinor,
    totalMinor: safeMinor(subtotal + BigInt(allocation.taxMinor)),
  };
}
