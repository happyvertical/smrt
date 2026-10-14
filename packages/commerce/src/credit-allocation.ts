/** Pure allocation of positive credit requests against frozen invoice lines. */

import { MoneyValidationError } from './money.js';
import { roundSignedRational } from './money-rational.js';
import type { InvoiceCreditCalculationBasis } from './types/index.js';

const QUANTITY_SCALE = 1_000_000n;

function quantityUnits(value: string, label: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value))
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} must be a nonnegative decimal with at most six places`,
    );
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(6, '0'));
}

function safeSigned(value: bigint, label: string): number {
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new MoneyValidationError('UNSAFE_MONEY', `${label} is unsafe`);
  return Number(value);
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export interface FrozenCreditSourceLine {
  id: string;
  quantity: string;
  netMinor: number;
  discountMinor: number;
  unitPrice: number;
  discountType: 'none' | 'percent' | 'amount';
  discountRate: string;
}

export interface IssuedCreditConsumption {
  creditedLineId: string;
  quantity: string;
  netMinor: number;
  discountMinor: number;
}

export type FrozenCreditRequest =
  | { creditedLineId: string; quantity: string }
  | { creditedLineId: string; netMinor: number };

export interface FrozenCreditAllocation {
  creditedLineId: string;
  basis: InvoiceCreditCalculationBasis;
  netMinor: number | null;
  discountMinor: number;
  exhaustsLine: boolean;
}

export interface FrozenCreditAllocationResult {
  allocations: FrozenCreditAllocation[];
  exhaustsDocument: boolean;
}

export interface AvailableRefundInput {
  sourceTotalMinor: number;
  sourcePaidMinor: number;
  issuedCreditMinor: number;
  settledRefundMinor: number;
}

/** Exact unapplied credit available to refund across one source invoice. */
export function calculateAvailableRefund(input: AvailableRefundInput): number {
  for (const [label, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new MoneyValidationError(
        'UNSAFE_MONEY',
        `${label} must be a nonnegative safe integer`,
      );
  }
  const outstanding = Math.max(
    0,
    input.sourceTotalMinor - input.sourcePaidMinor,
  );
  return Math.max(
    0,
    Math.max(0, input.issuedCreditMinor - outstanding) -
      input.settledRefundMinor,
  );
}

/** Validate caps and normalize flat-discount/final-residual allocation. */
export function allocateFrozenCredit(
  sourceLines: readonly FrozenCreditSourceLine[],
  issued: readonly IssuedCreditConsumption[],
  requests: readonly FrozenCreditRequest[],
): FrozenCreditAllocationResult {
  for (const source of sourceLines) {
    if (
      !source.id ||
      !Number.isSafeInteger(source.netMinor) ||
      !Number.isSafeInteger(source.discountMinor) ||
      !Number.isSafeInteger(source.unitPrice)
    )
      throw new MoneyValidationError(
        'UNSAFE_MONEY',
        'Frozen source money must use safe integer minor units',
      );
    if (quantityUnits(source.quantity, 'Source quantity') <= 0n)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Frozen source quantity must be positive',
      );
  }
  const sources = new Map(sourceLines.map((line) => [line.id, line]));
  if (sources.size !== sourceLines.length || !requests.length)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Credit allocation requires distinct source lines and requests',
    );
  const requestedIds = new Set<string>();
  const consumed = new Map<
    string,
    { quantity: bigint; net: bigint; discount: bigint }
  >();
  for (const row of issued) {
    if (
      !row.creditedLineId ||
      !Number.isInteger(row.netMinor) ||
      !Number.isInteger(row.discountMinor)
    )
      throw new MoneyValidationError(
        'UNSAFE_MONEY',
        'Issued credit money must use safe integer minor units',
      );
    if (
      !Number.isSafeInteger(row.netMinor) ||
      !Number.isSafeInteger(row.discountMinor)
    )
      throw new MoneyValidationError(
        'UNSAFE_MONEY',
        'Issued credit money must use safe integer minor units',
      );
    if (!sources.has(row.creditedLineId))
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `Issued credit references unknown line ${row.creditedLineId}`,
      );
    const current = consumed.get(row.creditedLineId) ?? {
      quantity: 0n,
      net: 0n,
      discount: 0n,
    };
    current.quantity += quantityUnits(row.quantity, 'Issued credit quantity');
    current.net += BigInt(row.netMinor);
    current.discount += BigInt(row.discountMinor);
    consumed.set(row.creditedLineId, current);
  }
  const allocations = [...requests]
    .sort((left, right) =>
      left.creditedLineId < right.creditedLineId ? -1 : 1,
    )
    .map((request): FrozenCreditAllocation => {
      if (requestedIds.has(request.creditedLineId))
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'A credit may reference a source line only once',
        );
      requestedIds.add(request.creditedLineId);
      const source = sources.get(request.creditedLineId);
      if (!source)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          `Unknown credited line ${request.creditedLineId}`,
        );
      const used = consumed.get(source.id) ?? {
        quantity: 0n,
        net: 0n,
        discount: 0n,
      };
      const sourceQuantity = quantityUnits(source.quantity, 'Source quantity');
      const remainingQuantity = sourceQuantity - used.quantity;
      const sourceNet = BigInt(source.netMinor);
      const sourceDiscount = BigInt(source.discountMinor);
      const sign = sourceNet < 0n ? -1n : 1n;
      if (
        (used.net !== 0n && (used.net < 0n ? -1n : 1n) !== sign) ||
        (used.discount !== 0n &&
          sourceDiscount !== 0n &&
          (used.discount < 0n ? -1n : 1n) !== (sourceDiscount < 0n ? -1n : 1n))
      )
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Issued credit signs must match the frozen source line',
        );
      const remainingNet = magnitude(sourceNet) - magnitude(used.net);
      const remainingDiscount =
        magnitude(sourceDiscount) - magnitude(used.discount);
      if (remainingQuantity < 0n || remainingNet < 0n || remainingDiscount < 0n)
        throw new MoneyValidationError(
          'CREDIT_EXCEEDS_LINE',
          'Persisted credits already exceed the frozen source line',
        );
      const snapshot = {
        sourceQuantity: source.quantity,
        sourceUnitPrice: source.unitPrice,
        sourceDiscountType: source.discountType,
        sourceDiscountRate: String(source.discountRate),
        sourceDiscountMinor: source.discountMinor,
      } as const;
      if ('quantity' in request) {
        const quantity = quantityUnits(request.quantity, 'Credit quantity');
        if (quantity <= 0n || quantity > remainingQuantity)
          throw new MoneyValidationError(
            'CREDIT_EXCEEDS_LINE',
            'Credit quantity exceeds the remaining frozen quantity',
          );
        const exhaustsLine = quantity === remainingQuantity;
        const discount =
          source.discountType !== 'amount'
            ? 0n
            : exhaustsLine
              ? (sourceDiscount < 0n ? -1n : 1n) * remainingDiscount
              : roundSignedRational(
                  BigInt(source.discountMinor) * quantity,
                  sourceQuantity,
                );
        return {
          creditedLineId: source.id,
          basis: { kind: 'quantity', quantity: request.quantity, ...snapshot },
          netMinor: null,
          discountMinor: safeSigned(discount, 'Credit discount'),
          exhaustsLine,
        };
      }
      if (!Number.isSafeInteger(request.netMinor) || request.netMinor <= 0)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Credit net amount must be a positive safe integer',
        );
      const amount = BigInt(request.netMinor);
      if (amount > remainingNet)
        throw new MoneyValidationError(
          'CREDIT_EXCEEDS_LINE',
          'Credit net amount exceeds the remaining frozen net amount',
        );
      return {
        creditedLineId: source.id,
        basis: { kind: 'net_amount', netMinor: request.netMinor, ...snapshot },
        netMinor: safeSigned(sign * amount, 'Credit net amount'),
        discountMinor: 0,
        exhaustsLine: amount === remainingNet,
      };
    });
  const exhausted = new Set(
    allocations
      .filter((row) => row.exhaustsLine)
      .map((row) => row.creditedLineId),
  );
  return {
    allocations,
    exhaustsDocument: sourceLines.every((line) => {
      const used = consumed.get(line.id);
      return (
        magnitude(BigInt(line.netMinor)) - magnitude(used?.net ?? 0n) === 0n ||
        exhausted.has(line.id)
      );
    }),
  };
}
