/** Incomplete supplier evidence is never a calculated or reportable Contract. */
import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import { ContractCollection } from './collections/ContractCollection.js';
import { PurchaseContractCollection } from './collections/PurchaseContractCollection.js';
import { PurchasePriceObservationCollection } from './collections/PurchasePriceObservationCollection.js';
import { VendorCollection } from './collections/VendorCollection.js';
import { PurchasePriceObservation } from './models/PurchasePriceObservation.js';
import { OBSERVED_PURCHASE_WRITE } from './observed-purchase-price-internal.js';
import {
  getReceivedPurchaseMoney,
  type ReceivedPurchaseMoneyFacts,
  recordReceivedPurchaseMoney,
  validateReceivedPurchaseMoneyFacts,
} from './received-purchase-money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';

/** Null means absent from source evidence. No missing value is inferred as zero. */
export interface ObservedPurchaseAmounts {
  netMinor: number | null;
  taxMinor: number | null;
  grossMinor: number | null;
}
export interface ObservedPurchaseLine extends ObservedPurchaseAmounts {
  sourceKey: string;
  description: string;
  quantityText?: string;
  unitRateText?: string;
}
export interface ObservedPurchasePriceFacts extends ObservedPurchaseAmounts {
  currency: string;
  detail:
    | { kind: 'header-only' }
    | { kind: 'lines'; lines: ObservedPurchaseLine[] };
}
export interface PurchasePriceObservationSnapshot {
  version: 1;
  requestId: string;
  sourceNamespace: string;
  sourceKey: string;
  kind: 'supplier-quote' | 'purchase-order';
  vendorId: string;
  /** Source status is retained text, never current approval or acceptance. */
  sourceStatus: string;
  effectiveOn: string;
  evidenceRef: string;
  facts: ObservedPurchasePriceFacts;
}
export interface PurchasePriceCompletion {
  requestId: string;
  reviewEvidenceRef: string;
  contractId: string;
  facts: ReceivedPurchaseMoneyFacts;
}
export interface PurchasePriceObservationView {
  id: string;
  snapshot: PurchasePriceObservationSnapshot;
  completion: PurchasePriceCompletion | null;
  /** Complete, usable aggregates exist only on the explicitly completed Contract. */
  monetaryAggregate: null;
}
function invalid(): never {
  throw new Error(
    'Observed purchase evidence is incomplete, inconsistent or changed',
  );
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) invalid();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function amounts(value: Record<string, unknown>): ObservedPurchaseAmounts {
  const result = {} as ObservedPurchaseAmounts;
  for (const key of ['netMinor', 'taxMinor', 'grossMinor'] as const) {
    const amount = value[key];
    if (
      amount !== null &&
      (typeof amount !== 'number' ||
        !Number.isSafeInteger(amount) ||
        amount < 0)
    )
      invalid();
    result[key] = amount as number | null;
  }
  const { netMinor: net, taxMinor: tax, grossMinor: gross } = result;
  if (net === null && tax === null && gross === null) invalid();
  if (
    gross !== null &&
    ((net !== null && net > gross) || (tax !== null && tax > gross))
  )
    invalid();
  if (
    net !== null &&
    tax !== null &&
    gross !== null &&
    BigInt(net) + BigInt(tax) !== BigInt(gross)
  )
    invalid();
  return result;
}
export function validateObservedPurchasePriceFacts(
  raw: unknown,
): ObservedPurchasePriceFacts {
  const value = object(raw),
    currency = text(value.currency);
  if (
    !ISO_4217_MINOR_UNITS.has(currency) ||
    ISO_4217_MINOR_UNITS.get(currency) === null
  )
    invalid();
  const totals = amounts(value),
    source = object(value.detail);
  let detail: ObservedPurchasePriceFacts['detail'];
  if (source.kind === 'header-only' && !Object.hasOwn(source, 'lines'))
    detail = { kind: 'header-only' };
  else if (
    source.kind === 'lines' &&
    Array.isArray(source.lines) &&
    source.lines.length
  ) {
    const lines = source.lines.map((rawLine) => {
      const line = object(rawLine);
      const result: ObservedPurchaseLine = {
        sourceKey: text(line.sourceKey),
        description: text(line.description),
        ...amounts(line),
      };
      for (const key of ['quantityText', 'unitRateText'] as const) {
        if (line[key] !== undefined) {
          const decimal = text(line[key]);
          if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) invalid();
          result[key] = decimal;
        }
      }
      return result;
    });
    if (new Set(lines.map((line) => line.sourceKey)).size !== lines.length)
      invalid();
    for (const key of ['netMinor', 'taxMinor', 'grossMinor'] as const) {
      if (
        totals[key] !== null &&
        lines.every((line) => line[key] !== null) &&
        lines.reduce((sum, line) => sum + BigInt(line[key]!), 0n) !==
          BigInt(totals[key]!)
      )
        invalid();
    }
    detail = { kind: 'lines', lines };
  } else invalid();
  return { currency, ...totals, detail };
}
function snapshot(raw: unknown): PurchasePriceObservationSnapshot {
  const value = object(raw);
  if (
    value.version !== 1 ||
    (value.kind !== 'supplier-quote' && value.kind !== 'purchase-order')
  )
    invalid();
  const effectiveOn = text(value.effectiveOn);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn) ||
    !Number.isFinite(Date.parse(`${effectiveOn}T00:00:00Z`)) ||
    new Date(`${effectiveOn}T00:00:00Z`).toISOString().slice(0, 10) !==
      effectiveOn
  )
    invalid();
  return {
    version: 1,
    requestId: text(value.requestId),
    sourceNamespace: text(value.sourceNamespace),
    sourceKey: text(value.sourceKey),
    kind: value.kind,
    vendorId: text(value.vendorId),
    sourceStatus: text(value.sourceStatus),
    effectiveOn,
    evidenceRef: text(value.evidenceRef),
    facts: validateObservedPurchasePriceFacts(value.facts),
  };
}
function identity(
  tenantId: string,
  value: PurchasePriceObservationSnapshot,
): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        tenantId,
        value.sourceNamespace,
        value.kind,
        value.sourceKey,
      ]),
    )
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function tenant(value: string): string {
  if (getTenantId() !== text(value))
    throw new Error('Active tenant must own observed purchase evidence');
  return value;
}
function view(row: PurchasePriceObservation): PurchasePriceObservationView {
  const original = snapshot(JSON.parse(row.snapshotJson));
  if (
    identity(row.tenantId, original) !== row.id ||
    row.vendorId !== original.vendorId ||
    row.sourceIdentity !==
      JSON.stringify([
        original.sourceNamespace,
        original.kind,
        original.sourceKey,
      ])
  )
    invalid();
  return {
    id: text(row.id),
    snapshot: original,
    completion: row.completionJson
      ? (JSON.parse(row.completionJson) as PurchasePriceCompletion)
      : null,
    monetaryAggregate: null,
  };
}
/** Host authorizes import/recording; source approval never becomes current contract acceptance. */
export async function recordPurchasePriceObservation(input: {
  db: DatabaseInterface;
  tenantId: string;
  snapshot: PurchasePriceObservationSnapshot;
}): Promise<PurchasePriceObservationView> {
  const tenantId = tenant(input.tenantId),
    original = snapshot(input.snapshot),
    id = identity(tenantId, original);
  return withTenantMoneyRuntime(input.db, tenantId, async ({ db }) => {
    const collection = await PurchasePriceObservationCollection.create({ db });
    const prior = await collection.get({ id, tenantId }, { cache: false });
    if (prior) {
      const retained = view(prior);
      if (JSON.stringify(retained.snapshot) !== JSON.stringify(original))
        invalid();
      return retained;
    }
    const vendor = await (await VendorCollection.create({ db })).get(
      { id: original.vendorId, tenantId },
      { cache: false },
    );
    if (!vendor || vendor.tenantId !== tenantId)
      throw new Error('Observed supplier must belong to active tenant');
    const row = new PurchasePriceObservation({
      db,
      id,
      tenantId,
      vendorId: original.vendorId,
      sourceIdentity: JSON.stringify([
        original.sourceNamespace,
        original.kind,
        original.sourceKey,
      ]),
      snapshotJson: JSON.stringify(original),
    });
    await row.initialize();
    await row.saveObserved(OBSERVED_PURCHASE_WRITE);
    return view(row);
  });
}
export async function readPurchasePriceObservation(input: {
  db: DatabaseInterface;
  tenantId: string;
  id: string;
}): Promise<PurchasePriceObservationView> {
  const tenantId = tenant(input.tenantId);
  const row = await (
    await PurchasePriceObservationCollection.create({ db: input.db })
  ).get({ id: text(input.id), tenantId }, { cache: false });
  if (!row || row.tenantId !== tenantId)
    throw new Error('Observed purchase evidence not found');
  return view(row);
}
function preserves(
  observed: ObservedPurchaseAmounts,
  complete: ObservedPurchaseAmounts,
): void {
  for (const key of ['netMinor', 'taxMinor', 'grossMinor'] as const)
    if (observed[key] !== null && observed[key] !== complete[key]) invalid();
}
/** Explicit reviewed completion creates a separate draft; no source status implies approval. */
export async function completePurchasePriceObservation(input: {
  db: DatabaseInterface;
  tenantId: string;
  id: string;
  requestId: string;
  reviewEvidenceRef: string;
  facts: ReceivedPurchaseMoneyFacts;
}): Promise<PurchasePriceObservationView> {
  const tenantId = tenant(input.tenantId),
    facts = validateReceivedPurchaseMoneyFacts(input.facts);
  const requestId = text(input.requestId),
    reviewEvidenceRef = text(input.reviewEvidenceRef);
  return withTenantMoneyRuntime(input.db, tenantId, async ({ db }) => {
    const row = await (
      await PurchasePriceObservationCollection.create({ db })
    ).get({ id: text(input.id), tenantId }, { cache: false });
    if (!row || row.tenantId !== tenantId)
      throw new Error('Observed purchase evidence not found');
    const retained = view(row),
      original = retained.snapshot;
    if (
      original.facts.currency !== facts.currency ||
      reviewEvidenceRef === original.evidenceRef
    )
      invalid();
    preserves(original.facts, facts);
    if (original.facts.detail.kind === 'lines') {
      const lines = original.facts.detail.lines;
      for (const key of ['netMinor', 'taxMinor', 'grossMinor'] as const)
        if (
          lines.every((line) => line[key] !== null) &&
          lines.reduce((sum, line) => sum + BigInt(line[key]!), 0n) !==
            BigInt(facts[key])
        )
          invalid();
    }
    if (
      facts.detail.kind === 'lines' &&
      original.facts.detail.kind === 'lines'
    ) {
      const completeLines = facts.detail.lines;
      if (completeLines.length !== original.facts.detail.lines.length)
        invalid();
      for (const line of original.facts.detail.lines) {
        const completed = completeLines.find(
          (entry) => entry.sourceKey === line.sourceKey,
        );
        if (
          !completed ||
          completed.description !== line.description ||
          completed.quantityText !== line.quantityText ||
          completed.unitRateText !== line.unitRateText
        )
          invalid();
        preserves(line, completed);
      }
    }
    if (retained.completion) {
      const prior = retained.completion;
      if (
        prior.requestId !== requestId ||
        prior.reviewEvidenceRef !== reviewEvidenceRef ||
        JSON.stringify(prior.facts) !== JSON.stringify(facts)
      )
        invalid();
      const contract = await (await ContractCollection.create({ db })).get(
        { id: prior.contractId, tenantId },
        { cache: false },
      );
      if (
        !contract ||
        JSON.stringify(getReceivedPurchaseMoney(contract)?.facts) !==
          JSON.stringify(facts)
      )
        invalid();
      return retained;
    }
    const contract = await (
      await PurchaseContractCollection.create({ db })
    ).create({
      _meta_type:
        original.kind === 'supplier-quote'
          ? '@happyvertical/smrt-commerce:SupplierQuote'
          : '@happyvertical/smrt-commerce:PurchaseOrder',
      tenantId,
      vendorId: original.vendorId,
      currency: facts.currency,
      issueDate: new Date(`${original.effectiveOn}T00:00:00Z`),
      reference: original.sourceKey,
    });
    await recordReceivedPurchaseMoney({
      db,
      tenantId,
      contractId: text(contract.id),
      requestId,
      evidenceRef: reviewEvidenceRef,
      facts,
    });
    row.completionJson = JSON.stringify({
      requestId,
      reviewEvidenceRef,
      contractId: text(contract.id),
      facts,
    });
    await row.saveObserved(OBSERVED_PURCHASE_WRITE);
    return view(row);
  });
}
