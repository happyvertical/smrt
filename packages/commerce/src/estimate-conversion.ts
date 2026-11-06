/** Convert an accepted, frozen Estimate into the Order that milestone billing starts from. */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ContractCollection } from './collections/ContractCollection.js';
import { ContractLineItemCollection } from './collections/ContractLineItemCollection.js';
import { allowConversionLineageWrite } from './contract-money.js';
import { lockDocumentMoneyParents } from './document-money-internal.js';
import { Estimate, Order } from './models/Contract.js';
import type { ContractLineItem } from './models/ContractLineItem.js';
import { MoneyValidationError } from './money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';
import { ContractStatus, ContractType } from './types/index.js';

/** Input to {@link convertEstimateToOrder}. */
export interface ConvertEstimateToOrderInput {
  db: DatabaseInterface;
  tenantId: string;
  estimateId: string;
  /** Idempotency identity; an exact replay returns the existing Order. */
  requestId: string;
  /** Host-owned acceptance evidence (who accepted, when, from where). */
  acceptanceEvidenceRef: string;
}
/** Identity of the Order a conversion created (or replayed). */
export interface ConvertedEstimateOrder {
  orderId: string;
  estimateId: string;
  requestId: string;
}

function invalid(message: string): never {
  throw new MoneyValidationError('INVALID_MONEY_INPUT', message);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value)
    invalid(`${label} must be nonempty trimmed text`);
  return value;
}
function requireContext(tenantId: string): void {
  text(tenantId, 'Tenant');
  if (getTenantId() !== tenantId)
    invalid('Estimate conversion requires its active tenant context');
}
function assertTotalsMatch(estimate: Estimate, order: Order): void {
  if (
    order.subtotal !== estimate.subtotal ||
    order.taxAmount !== estimate.taxAmount ||
    order.totalAmount !== estimate.totalAmount
  )
    invalid(
      'Converted Order totals differ from the accepted Estimate; tax settings may have changed since it was quoted',
    );
}
/** Orders carrying conversion lineage; meta fields are not queryable columns. */
async function convertedOrders(
  contracts: ContractCollection,
  tenantId: string,
): Promise<Order[]> {
  const rows = await contracts.list({
    where: {
      tenantId,
      contractType: ContractType.ORDER,
    },
  });
  return rows.filter(
    (row): row is Order => row instanceof Order && !!row.sourceEstimateId,
  );
}

/**
 * Convert an accepted, frozen, calculated Estimate into one accepted Order with
 * copied lines and lineage. Raises no invoice; hosts continue with the billing
 * schedule commands on the returned Order. Replays with the same request return
 * the existing Order; any other repeat is refused.
 */
export async function convertEstimateToOrder(
  input: ConvertEstimateToOrderInput,
): Promise<ConvertedEstimateOrder> {
  requireContext(input.tenantId);
  const estimateId = text(input.estimateId, 'Estimate');
  const requestId = text(input.requestId, 'Request');
  const evidence = text(input.acceptanceEvidenceRef, 'Acceptance evidence');
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const contracts = await ContractCollection.create({ db });
    await lockDocumentMoneyParents([
      { id: estimateId, tenantId: input.tenantId, collection: contracts },
    ]);
    const estimate = await contracts.get({ id: estimateId }, { cache: false });
    if (!(estimate instanceof Estimate) || estimate.tenantId !== input.tenantId)
      invalid('Estimate was not found in the active tenant');

    const orders = await convertedOrders(contracts, input.tenantId);
    const existing = orders.find(
      (order) => order.sourceEstimateId === estimateId,
    );
    if (existing) {
      if (existing.conversionRequestId !== requestId)
        invalid('Estimate was already converted under another request');
      if (existing.acceptanceEvidenceRef !== evidence)
        invalid('Conversion request changed');
      // A replay never hands back an Order whose money drifted from the quote.
      assertTotalsMatch(estimate, existing);
      return { orderId: existing.id as string, estimateId, requestId };
    }
    if (orders.some((order) => order.conversionRequestId === requestId))
      invalid('Request identity already used');

    if (
      estimate.status !== ContractStatus.ACCEPTED ||
      !estimate.moneySnapshotId ||
      estimate.moneyAuthority !== 'calculated' ||
      !estimate.customerId
    )
      invalid(
        'Conversion requires an accepted, frozen, calculated Estimate with a customer',
      );

    const lines = await (
      await ContractLineItemCollection.create({ db })
    ).findByContract(estimateId);
    if (!db.transaction)
      invalid('Estimate conversion requires transaction support');
    // Command-local savepoint: a failure leaves no Order even when the caller
    // catches the error inside its own money runtime.
    return db.transaction((tx) =>
      withTenantMoneyRuntime(tx, input.tenantId, ({ db: write }) =>
        writeConvertedOrder(write, estimate, lines, requestId, evidence),
      ),
    );
  });
}

async function writeConvertedOrder(
  db: DatabaseInterface,
  estimate: Estimate,
  lines: ContractLineItem[],
  requestId: string,
  evidence: string,
): Promise<ConvertedEstimateOrder> {
  const estimateId = estimate.id as string;
  const contracts = await ContractCollection.create({ db });
  {
    const order = (await contracts.create({
      _meta_type: '@happyvertical/smrt-commerce:Order',
      customerId: estimate.customerId,
      currency: estimate.currency,
      terms: estimate.terms,
      reference: estimate.reference,
      notes: estimate.notes,
      channelId: estimate.channelId,
    })) as Order;
    allowConversionLineageWrite(order);
    order.sourceEstimateId = estimateId;
    order.conversionRequestId = requestId;
    order.acceptanceEvidenceRef = evidence;
    await order.save();
    const orderId = order.id as string;
    const lineCollection = await ContractLineItemCollection.create({ db });
    for (const line of lines) {
      const copy = await lineCollection.create({
        contractId: orderId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        discountType: line.discountType,
        discountRate: line.discountRate,
        taxMode: line.taxMode,
        taxCodeId: line.taxCodeId,
        productId: line.productId,
        sku: line.sku,
        startDate: line.startDate,
        endDate: line.endDate,
        billingPeriod: line.billingPeriod,
        sortOrder: line.sortOrder,
      });
      await copy.save();
    }
    const draft = await contracts.get({ id: orderId }, { cache: false });
    if (!(draft instanceof Order)) invalid('Converted Order did not reload');
    draft.status = ContractStatus.ACCEPTED;
    await draft.save();
    const accepted = await contracts.get({ id: orderId }, { cache: false });
    if (!(accepted instanceof Order) || !accepted.moneySnapshotId)
      invalid('Converted Order was not frozen');
    assertTotalsMatch(estimate, accepted);
    return { orderId, estimateId, requestId };
  }
}

/** The Order converted from an Estimate, or null when none exists. */
export async function findOrderForEstimate(
  db: DatabaseInterface,
  tenantId: string,
  estimateId: string,
): Promise<Order | null> {
  requireContext(tenantId);
  text(estimateId, 'Estimate');
  const contracts = await ContractCollection.create({ db });
  const estimate = await contracts.get({ id: estimateId }, { cache: false });
  if (!(estimate instanceof Estimate) || estimate.tenantId !== tenantId)
    return null;
  const orders = await convertedOrders(contracts, tenantId);
  return orders.find((order) => order.sourceEstimateId === estimateId) ?? null;
}
