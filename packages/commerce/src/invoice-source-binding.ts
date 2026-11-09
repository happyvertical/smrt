/** Generic invoice binding to an owning package's existing reservation. No money capacity lives here. */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import type { Invoice } from './models/Invoice.js';
import type { InvoiceLineItem } from './models/InvoiceLineItem.js';
import { MoneyValidationError } from './money.js';

/** A trusted package registers one protected source namespace and verifies its own authoritative reservation. */
export type InvoiceSourceBindingHandler = (input: {
  executor: DatabaseInterface;
  invoice: Invoice;
  line: InvoiceLineItem;
  reservationId: string;
  phase: 'bind' | 'release' | 'validate';
}) => Promise<void>;
const handlers = new Map<string, InvoiceSourceBindingHandler>();
const writes = new WeakMap<InvoiceLineItem, string | null>();
function invalid(message: string): never {
  throw new MoneyValidationError('FROZEN_DOCUMENT', message);
}
/** Register from trusted package code at import time, never from request data. Protected names are qualified. */
export function registerInvoiceSourceBinding(
  sourceType: string,
  handler: InvoiceSourceBindingHandler,
): void {
  if (
    !/^billable:@[a-z0-9-]+\/[a-z0-9-]+:[A-Za-z][A-Za-z0-9]*$/.test(sourceType)
  )
    invalid('Billable source type must be package qualified');
  if (handlers.has(sourceType) && handlers.get(sourceType) !== handler)
    invalid('Billable source handler already registered');
  handlers.set(sourceType, handler);
}
async function handlerFor(type: string): Promise<InvoiceSourceBindingHandler> {
  if (!handlers.has(type) && type.startsWith('billable:'))
    await ObjectRegistry.tryLoadFromExternalPackage(type.slice(9));
  const handler = handlers.get(type);
  if (!handler) invalid('Protected invoice source handler is unavailable');
  return handler;
}
/** Enforce old and proposed identity; clearing the namespace never clears a persisted binding. */
export async function assertInvoiceLineSource(
  executor: DatabaseInterface,
  invoice: Invoice,
  line: InvoiceLineItem,
  persisted: InvoiceLineItem | null,
  issuing = false,
): Promise<void> {
  const old = persisted?.sourceReservationId ?? null;
  const next = line.sourceReservationId ?? null;
  const authorized = writes.has(line) && writes.get(line) === next;
  if (old !== next && !authorized)
    invalid('Invoice source reservation is command-owned');
  if (
    old &&
    (line.sourceType !== persisted?.sourceType ||
      line.sourceId !== persisted?.sourceId)
  )
    invalid('Bound invoice source identity cannot change');
  if (old && line.sourceType !== persisted?.sourceType)
    invalid('Bound source namespace cannot change');
  if (line.sourceType.startsWith('billable:') || old || next) {
    const handler = await handlerFor(line.sourceType);
    if (issuing && !next)
      invalid('Protected invoice source must be reserved before issue');
    if (next)
      await handler({
        executor,
        invoice,
        line,
        reservationId: next,
        phase: authorized ? 'bind' : 'validate',
      });
  }
}
/** Guard physical line or cascading invoice deletion independently of caller-mutated fields. */
export function assertInvoiceSourceDelete(
  lines: readonly InvoiceLineItem[],
): void {
  if (lines.some((line) => line.sourceReservationId))
    invalid('Release invoice source reservations before deletion');
}
/** Attach an already-authorized owning-package reservation. It must identify exactly this tenant/invoice/line. */
export async function bindInvoiceLineSource(input: {
  db: DatabaseInterface;
  tenantId: string;
  lineId: string;
  reservationId: string;
}): Promise<void> {
  if (
    !input.tenantId ||
    getTenantId() !== input.tenantId ||
    !input.reservationId
  )
    invalid('Active tenant and reservation required');
  const line = await (
    await InvoiceLineItemCollection.create({ db: input.db })
  ).get({ id: input.lineId, tenantId: input.tenantId }, { cache: false });
  if (!line || line.tenantId !== input.tenantId)
    invalid('Owned invoice line required');
  await line.withTransaction(async (bound) => {
    const invoice = await (
      await InvoiceCollection.create({ db: bound.db })
    ).get({ id: bound.invoiceId, tenantId: input.tenantId }, { cache: false });
    if (!invoice || invoice.status !== 'draft')
      invalid('Unissued owned invoice required');
    if (
      bound.sourceReservationId &&
      bound.sourceReservationId !== input.reservationId
    )
      invalid('Invoice line already bound');
    await (await handlerFor(bound.sourceType))({
      executor: bound.db,
      invoice,
      line: bound,
      reservationId: input.reservationId,
      phase: 'bind',
    });
    bound.sourceReservationId = input.reservationId;
    writes.set(bound, input.reservationId);
    try {
      await bound.save();
    } finally {
      writes.delete(bound);
    }
  });
}
/** Withdraw only after the owning package released its draft claim, in the same caller transaction. */
export async function unbindInvoiceLineSource(input: {
  db: DatabaseInterface;
  tenantId: string;
  lineId: string;
  reservationId: string;
}): Promise<void> {
  if (!input.tenantId || getTenantId() !== input.tenantId)
    invalid('Active tenant required');
  const line = await (
    await InvoiceLineItemCollection.create({ db: input.db })
  ).get({ id: input.lineId, tenantId: input.tenantId }, { cache: false });
  if (!line || line.sourceReservationId !== input.reservationId)
    invalid('Owned bound invoice line required');
  await line.withTransaction(async (bound) => {
    const invoice = await (
      await InvoiceCollection.create({ db: bound.db })
    ).get({ id: bound.invoiceId, tenantId: input.tenantId }, { cache: false });
    if (!invoice || invoice.status !== 'draft')
      invalid('Issued invoice source cannot be unbound');
    await (await handlerFor(bound.sourceType))({
      executor: bound.db,
      invoice,
      line: bound,
      reservationId: input.reservationId,
      phase: 'release',
    });
    bound.sourceReservationId = null;
    writes.set(bound, null);
    try {
      await bound.save();
    } finally {
      writes.delete(bound);
    }
  });
}
