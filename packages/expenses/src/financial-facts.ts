/** Exact validation of optional supplier facts. No tax policy is inferred. */
import {
  type ExpenseCostBasis,
  ExpenseError,
  type ExpenseFinancialBreakdown,
} from './types.js';
import { assertIsoCurrency } from './validation.js';

function invalid(message: string): never {
  throw new ExpenseError(
    'EXPENSE_INVALID',
    `Expense financial breakdown: ${message}`,
  );
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('expected an object.');
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(object, key))
  ) {
    return invalid('missing or unknown fields.');
  }
  return object;
}

function minor(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalid('amounts must be safe integer minor units.');
  }
  return BigInt(value);
}

function safe(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    return invalid('unsafe calculated amount.');
  return result;
}

/** Validate facts and derive an exact signed basis, without rounding or defaults. */
export function expenseCostBasis(
  value: unknown,
  amount: number,
  currency: string,
): ExpenseCostBasis {
  const facts = record(value, ['currency', 'subtotal', 'taxes', 'total']);
  if (typeof facts.currency !== 'string' || facts.currency !== currency) {
    return invalid('currency must match the expense.');
  }
  assertIsoCurrency('Expense', '<financial-breakdown>', facts.currency);
  const total = minor(facts.total);
  const subtotal = minor(facts.subtotal);
  if (total !== minor(amount))
    return invalid('total must match the expense amount.');
  const consistent = (part: bigint) =>
    part === 0n || (total > 0n ? part > 0n : total < 0n && part < 0n);
  if (!consistent(subtotal)) return invalid('subtotal sign must match total.');
  if (!Array.isArray(facts.taxes))
    return invalid('taxes must be an explicit array.');
  let tax = 0n;
  let recoverable = 0n;
  const codes = new Set<string>();
  for (const item of facts.taxes) {
    const component = record(item, ['code', 'amount', 'recoverableAmount']);
    if (
      typeof component.code !== 'string' ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(component.code) ||
      component.code.length > 64 ||
      codes.has(component.code)
    ) {
      return invalid(
        'tax codes must be unique lower-case kebab-case identifiers.',
      );
    }
    codes.add(component.code);
    const charged = minor(component.amount);
    const recovered = minor(component.recoverableAmount);
    const chargedMagnitude = charged < 0n ? -charged : charged;
    const recoveredMagnitude = recovered < 0n ? -recovered : recovered;
    if (
      !consistent(charged) ||
      !consistent(recovered) ||
      recoveredMagnitude > chargedMagnitude
    ) {
      return invalid(
        'tax and recovery must share the total sign, with recovery bounded by tax.',
      );
    }
    tax += charged;
    recoverable += recovered;
  }
  if (subtotal + tax !== total)
    return invalid('subtotal plus taxes must equal total.');
  return {
    currency,
    subtotal: safe(subtotal),
    taxTotal: safe(tax),
    recoverableTax: safe(recoverable),
    nonRecoverableTax: safe(tax - recoverable),
    total: safe(total),
    costBasis: safe(total - recoverable),
  };
}

/** Decode stored facts, failing closed for corrupt or unknown persisted values. */
export function parseExpenseFinancialBreakdown(
  stored: string | null,
  amount: number,
  currency: string,
): ExpenseFinancialBreakdown | null {
  if (stored === '' || stored === null || stored === undefined) return null;
  if (typeof stored !== 'string') return invalid('storage must be JSON text.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return invalid('invalid JSON.');
  }
  expenseCostBasis(parsed, amount, currency);
  return parsed as ExpenseFinancialBreakdown;
}
