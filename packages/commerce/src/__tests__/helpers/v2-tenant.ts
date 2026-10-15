import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, it as vitestIt } from 'vitest';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../../collections/TaxSettingsCollection.js';
import type { Invoice } from '../../models/Invoice.js';
import { ensureCommerceTenant } from '../../tax/tenant-bootstrap.js';
import { InvoiceStatus } from '../../types/index.js';

/**
 * Tenant every money-v2 suite runs in when the test itself is not about
 * tenancy. Commerce money documents (Invoice, Contract and their lines)
 * cannot be saved without one (#4021).
 */
export const V2_TENANT = 'tenant-v2-test';

// biome-ignore lint/suspicious/noExplicitAny: wraps arbitrary vitest bodies
type AnyFn = (...args: any[]) => any;

function requireId(id: string | null | undefined): string {
  if (!id) throw new Error('expected a persisted id');
  return id;
}

/** Run a test or hook body inside a tenant context. */
export function inTenant<T extends AnyFn>(fn: T, tenantId = V2_TENANT): T {
  return ((...args: unknown[]) =>
    withTenant({ tenantId }, async () => fn(...args))) as T;
}

type TenantIt = ((name: string, fn?: AnyFn, timeout?: number) => void) & {
  skip: (name: string, fn?: AnyFn, timeout?: number) => void;
  only: (name: string, fn?: AnyFn, timeout?: number) => void;
  todo: (name: string) => void;
  each: <R>(
    table: readonly R[],
  ) => (name: string, fn: (...args: R[]) => unknown, timeout?: number) => void;
};

/**
 * A drop-in `it` whose bodies run inside a tenant. Suites that only need a
 * tenant to satisfy the money-document invariant shadow vitest's `it` with
 * `const it = tenantIt();`.
 */
export function tenantIt(tenantId = V2_TENANT): TenantIt {
  const wrap = (fn?: AnyFn) => (fn ? inTenant(fn, tenantId) : undefined);
  const base = ((name: string, fn?: AnyFn, timeout?: number) =>
    vitestIt(name, wrap(fn), timeout)) as TenantIt;
  base.skip = (name, fn, timeout) => vitestIt.skip(name, wrap(fn), timeout);
  base.only = (name, fn, timeout) => vitestIt.only(name, wrap(fn), timeout);
  base.todo = (name) => vitestIt.todo(name);
  base.each =
    <R>(table: readonly R[]) =>
    (name: string, fn: (...args: R[]) => unknown, timeout?: number) =>
      // biome-ignore lint/suspicious/noExplicitAny: vitest each overloads
      (vitestIt.each as any)(table)(name, inTenant(fn, tenantId), timeout);
  return base;
}

/**
 * Seed a tenant with TaxSettings and the standard codes, plus a taxable
 * code (`percent`) set as the tenant default so untagged lines are taxed.
 * Returns the default code id; pass `percent: null` to leave the tenant
 * default untouched (lines then resolve through the standard codes).
 */
export async function seedV2Tenant(
  db: DatabaseInterface,
  tenantId = V2_TENANT,
  options: { percent?: string | null; code?: string } = {},
): Promise<{ taxCodeId: string | null; taxComponentId: string | null }> {
  await ensureCommerceTenant(db, tenantId);
  const percent = options.percent === undefined ? '5' : options.percent;
  if (percent === null) return { taxCodeId: null, taxComponentId: null };
  return withTenant({ tenantId }, async () => {
    const component = await (
      await TaxComponentCollection.create({ db })
    ).create({ tenantId, name: `Tax ${percent}%`, percent });
    const code = await (await TaxCodeCollection.create({ db })).create({
      tenantId,
      code: options.code ?? `tax-${percent}`,
      name: `Tax ${percent}%`,
      kind: 'taxable',
      components: [
        { taxComponentId: requireId(component.id), compound: false },
      ],
    });
    const settings = await (
      await TaxSettingsCollection.create({ db })
    ).getOrCreateForTenant(tenantId);
    settings.defaultSalesTaxCodeId = requireId(code.id);
    await settings.save();
    return {
      taxCodeId: requireId(code.id),
      taxComponentId: requireId(component.id),
    };
  });
}

/**
 * Turn the tenancy interceptor on for every test in the enclosing suite, so
 * rows saved inside a tenant (payments, allocations, customers, accounts)
 * are stamped with it and match the money documents they reference.
 */
export function useTenancy(): void {
  beforeEach(() => enableTenancy());
  afterEach(() => disableTenancy());
}

export interface V2InvoiceInput {
  invoiceNumber: string;
  currency?: string;
  customerId?: string | null;
  contractId?: string | null;
  /** Net (exclusive) amount per line, one unit each, in minor units. */
  lines?: readonly number[];
  /** Leave the invoice a draft instead of issuing it (status SENT). */
  draft?: boolean;
}

/**
 * Create a v2 invoice whose totals come from its lines, in the current
 * tenant, and issue it (DRAFT -> SENT) so its money facts freeze. Lines
 * carry no tax unless the tenant has a default sales tax code. Returns the
 * reloaded invoice.
 */
export async function createV2Invoice(
  db: DatabaseInterface,
  input: V2InvoiceInput,
): Promise<Invoice> {
  const invoices = await InvoiceCollection.create({ db });
  const invoice = await invoices.create({
    invoiceNumber: input.invoiceNumber,
    currency: input.currency ?? 'USD',
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.contractId ? { contractId: input.contractId } : {}),
  });
  const lines = await InvoiceLineItemCollection.create({ db });
  for (const [index, amount] of (input.lines ?? []).entries()) {
    const line = await lines.create({
      invoiceId: requireId(invoice.id),
      description: `Line ${index + 1}`,
      quantity: 1,
      unitPrice: amount,
    });
    await line.save();
  }
  const reloaded = await invoices.get({ id: invoice.id }, { cache: false });
  if (!reloaded) throw new Error('invoice did not reload');
  if (!input.draft && reloaded.status === InvoiceStatus.DRAFT) {
    reloaded.markSent();
    await reloaded.save();
  }
  return reloaded;
}
