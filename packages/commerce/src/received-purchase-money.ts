/** Exact monetary evidence received from a supplier, independent of calculated pricing. */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import { ContractCollection } from './collections/ContractCollection.js';
import { ContractLineItemCollection } from './collections/ContractLineItemCollection.js';
import { CustomerCollection } from './collections/CustomerCollection.js';
import { TaxCodeCollection } from './collections/TaxCodeCollection.js';
import { TaxComponentCollection } from './collections/TaxComponentCollection.js';
import { VendorCollection } from './collections/VendorCollection.js';
import {
  DOCUMENT_MONEY_WRITE,
  lockDocumentMoneyParents,
} from './document-money-internal.js';
import {
  Agreement,
  type Contract,
  Order,
  PurchaseOrder,
  SupplierQuote,
} from './models/Contract.js';
import { MoneyValidationError, type TaxCodeKind } from './money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';
import { ContractStatus } from './types/index.js';

/** A supplier tax component. Null explicitly retains an unknown fact. */
export interface ReceivedPurchaseTaxComponent {
  sourceKey: string;
  label: string;
  amountMinor: number;
  classification: TaxCodeKind | null;
  /** Explicit report identity/basis; omission retains unknown, never implies a rate. */
  taxCodeId?: string | null;
  taxComponentId?: string | null;
  taxableMinor?: number | null;
  /** Explicit net allocation when supplier taxable basis includes prior taxes. */
  netMinor?: number | null;
  recoverableMinor: number | null;
}
/** Complete source line money; optional source decimal text is evidence, not a calculator input. */
export interface ReceivedPurchaseMoneyLine {
  sourceKey: string;
  description: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  quantityText?: string;
  unitRateText?: string;
}
/** Monetary evidence without a fabricated rate, quantity, or line allocation. */
export interface ReceivedPurchaseMoneyFacts {
  currency: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  taxComponents: ReceivedPurchaseTaxComponent[] | null;
  detail:
    | { kind: 'header-only' }
    | { kind: 'lines'; lines: ReceivedPurchaseMoneyLine[] };
}
/** Immutable request and supplier evidence identity retained with the amounts. */
export interface ReceivedPurchaseMoneySnapshot {
  version: 1;
  requestId: string;
  evidenceRef: string;
  facts: ReceivedPurchaseMoneyFacts;
  sourceQuote: ReceivedPurchaseQuoteSource | null;
}
export interface ReceivedPurchaseQuoteSource {
  contractId: string;
  relationship: 'copy' | 'negotiated';
}
/** Public command input. The host authorizes the human before calling this command. */
export interface RecordReceivedPurchaseMoneyInput {
  db: DatabaseInterface;
  tenantId: string;
  contractId: string;
  requestId: string;
  evidenceRef: string;
  facts: ReceivedPurchaseMoneyFacts;
  sourceQuote?: ReceivedPurchaseQuoteSource;
}

/** Complete received sales agreement evidence; recording is not revenue/tax recognition. */
export type ReceivedSalesContractMoneyFacts = ReceivedPurchaseMoneyFacts;
export type ReceivedSalesContractMoneySnapshot = ReceivedPurchaseMoneySnapshot;
export type RecordReceivedSalesContractMoneyInput = Omit<
  RecordReceivedPurchaseMoneyInput,
  'sourceQuote'
>;

/** Record supplied complete facts on one empty draft Order/Agreement. */
export async function recordReceivedSalesContractMoney(
  input: RecordReceivedSalesContractMoneyInput,
): Promise<ReceivedSalesContractMoneySnapshot> {
  if (Object.hasOwn(input, 'sourceQuote'))
    invalid('Sales agreement evidence cannot reference a supplier quote');
  if (
    input.facts.taxComponents?.some(
      (component) => component.recoverableMinor !== null,
    )
  )
    invalid(
      'Purchase tax recovery is not applicable to sales agreement evidence; retain null',
    );
  return recordReceivedContractMoney(input, 'sales');
}

/** Read exact sales agreement evidence without calculating or recognizing an invoice. */
export function getReceivedSalesContractMoney(
  contract: Contract,
): ReceivedSalesContractMoneySnapshot | null {
  if (!(contract instanceof Order || contract instanceof Agreement))
    return null;
  return getReceivedPurchaseMoney(contract);
}

function invalid(message: string): never {
  throw new MoneyValidationError('INVALID_MONEY_INPUT', message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value)
    invalid(`${label} must be nonempty trimmed text`);
  return value;
}
function minor(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalid(`${label} must be a nonnegative safe integer`);
  return value;
}
function amounts(value: Record<string, unknown>, label: string) {
  const netMinor = minor(value.netMinor, `${label} net`);
  const taxMinor = minor(value.taxMinor, `${label} tax`);
  const grossMinor = minor(value.grossMinor, `${label} gross`);
  if (BigInt(netMinor) + BigInt(taxMinor) !== BigInt(grossMinor))
    invalid(`${label} net plus tax must equal gross`);
  return { netMinor, taxMinor, grossMinor };
}
function unique(keys: string[], label: string): void {
  if (new Set(keys).size !== keys.length)
    invalid(`${label} source keys must be unique`);
}

/** Validate and canonicalize exact received money, retaining unknowns as null. */
export function validateReceivedPurchaseMoneyFacts(
  value: unknown,
): ReceivedPurchaseMoneyFacts {
  const input = object(value, 'Received purchase facts');
  const currency = text(input.currency, 'Currency');
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    !ISO_4217_MINOR_UNITS.has(currency) ||
    ISO_4217_MINOR_UNITS.get(currency) === null
  )
    invalid('Currency must be a supported uppercase ISO 4217 code');
  const totals = amounts(input, 'Document');
  let taxComponents: ReceivedPurchaseTaxComponent[] | null = null;
  if (input.taxComponents !== null) {
    if (!Array.isArray(input.taxComponents))
      invalid('Tax components must be an array or explicit null');
    taxComponents = input.taxComponents.map((raw) => {
      const component = object(raw, 'Tax component');
      const amountMinor = minor(component.amountMinor, 'Component amount');
      const recoverableMinor =
        component.recoverableMinor === null
          ? null
          : minor(component.recoverableMinor, 'Recoverable amount');
      if (recoverableMinor !== null && recoverableMinor > amountMinor)
        invalid('Recoverable tax cannot exceed component tax');
      const classification = component.classification;
      if (
        classification !== null &&
        !['taxable', 'zero-rated', 'exempt', 'out-of-scope'].includes(
          String(classification),
        )
      )
        invalid('Unknown tax classification');
      const taxableMinor =
        component.taxableMinor == null
          ? null
          : minor(component.taxableMinor, 'Taxable basis');
      const netMinor =
        component.netMinor == null
          ? null
          : minor(component.netMinor, 'Component net basis');
      if (netMinor !== null && netMinor > totals.netMinor)
        invalid('Component net basis exceeds document net');
      if (
        classification !== null &&
        classification !== 'taxable' &&
        amountMinor !== 0
      )
        invalid('A non-taxable classification cannot contain tax');
      return {
        sourceKey: text(component.sourceKey, 'Component source key'),
        label: text(component.label, 'Component label'),
        amountMinor,
        classification: classification as TaxCodeKind | null,
        taxCodeId:
          component.taxCodeId == null
            ? null
            : text(component.taxCodeId, 'Tax code identity'),
        taxComponentId:
          component.taxComponentId == null
            ? null
            : text(component.taxComponentId, 'Tax component identity'),
        taxableMinor,
        ...(netMinor !== null ? { netMinor } : {}),
        recoverableMinor,
      };
    });
    unique(
      taxComponents.map((item) => item.sourceKey),
      'Tax component',
    );
    if (
      taxComponents.reduce(
        (sum, item) => sum + BigInt(item.amountMinor),
        0n,
      ) !== BigInt(totals.taxMinor)
    )
      invalid('Component tax sum must equal document tax');
  }
  const rawDetail = object(input.detail, 'Source detail');
  let detail: ReceivedPurchaseMoneyFacts['detail'];
  if (rawDetail.kind === 'header-only') {
    if ('lines' in rawDetail)
      invalid('Header-only evidence cannot contain monetary lines');
    detail = { kind: 'header-only' };
  } else if (rawDetail.kind === 'lines') {
    if (!Array.isArray(rawDetail.lines) || !rawDetail.lines.length)
      invalid('Complete source lines are required');
    const lines = rawDetail.lines.map((raw) => {
      const line = object(raw, 'Source line');
      const result: ReceivedPurchaseMoneyLine = {
        sourceKey: text(line.sourceKey, 'Line source key'),
        description: text(line.description, 'Line description'),
        ...amounts(line, 'Source line'),
      };
      for (const key of ['quantityText', 'unitRateText'] as const) {
        if (line[key] === undefined) continue;
        const decimal = text(line[key], key);
        if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal))
          invalid(`${key} must be nonnegative decimal source text`);
        result[key] = decimal;
      }
      return result;
    });
    unique(
      lines.map((item) => item.sourceKey),
      'Line',
    );
    for (const key of ['netMinor', 'taxMinor', 'grossMinor'] as const) {
      if (
        lines.reduce((sum, line) => sum + BigInt(line[key]), 0n) !==
        BigInt(totals[key])
      )
        invalid(`Source line ${key} sum must equal document amount`);
    }
    detail = { kind: 'lines', lines };
  } else invalid('Unknown received source detail kind');
  return { currency, ...totals, taxComponents, detail };
}

function quoteSource(value: unknown): ReceivedPurchaseQuoteSource | null {
  if (value == null) return null;
  const input = object(value, 'Source quote');
  if (input.relationship !== 'copy' && input.relationship !== 'negotiated')
    invalid('Unknown source quote relationship');
  return {
    contractId: text(input.contractId, 'Source quote identity'),
    relationship: input.relationship,
  };
}

/** Read validated received evidence; calculated contracts return null. */
export function getReceivedPurchaseMoney(
  contract: Pick<Contract, 'moneyAuthority' | 'receivedPurchaseMoneyJson'>,
): ReceivedPurchaseMoneySnapshot | null {
  if (contract.moneyAuthority === 'calculated') {
    if (contract.receivedPurchaseMoneyJson)
      invalid('Calculated money cannot contain received evidence');
    return null;
  }
  if (contract.moneyAuthority !== 'received')
    invalid('Unknown contract money authority');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract.receivedPurchaseMoneyJson);
  } catch {
    invalid('Stored received money is invalid');
  }
  const input = object(parsed, 'Received snapshot');
  if (input.version !== 1) invalid('Unknown received money version');
  return {
    version: 1,
    requestId: text(input.requestId, 'Request identity'),
    evidenceRef: text(input.evidenceRef, 'Evidence reference'),
    facts: validateReceivedPurchaseMoneyFacts(input.facts),
    sourceQuote: quoteSource(input.sourceQuote),
  };
}

/** Record immutable source facts on one empty draft SupplierQuote or PurchaseOrder, retry safely. */
export async function recordReceivedPurchaseMoney(
  input: RecordReceivedPurchaseMoneyInput,
): Promise<ReceivedPurchaseMoneySnapshot> {
  return recordReceivedContractMoney(input, 'purchase');
}

async function recordReceivedContractMoney(
  input: RecordReceivedPurchaseMoneyInput,
  direction: 'purchase' | 'sales',
): Promise<ReceivedPurchaseMoneySnapshot> {
  const tenantId = text(input.tenantId, 'Tenant');
  if (getTenantId() !== tenantId)
    invalid('Received contract money requires its active tenant context');
  const contractId = text(input.contractId, 'Contract');
  const snapshot: ReceivedPurchaseMoneySnapshot = {
    version: 1,
    requestId: text(input.requestId, 'Request identity'),
    evidenceRef: text(input.evidenceRef, 'Evidence reference'),
    facts: validateReceivedPurchaseMoneyFacts(input.facts),
    sourceQuote: quoteSource(input.sourceQuote),
  };
  const serialized = JSON.stringify(snapshot);
  return withTenantMoneyRuntime(input.db, tenantId, async ({ db }) => {
    const contracts = await ContractCollection.create({ db });
    await lockDocumentMoneyParents([
      { id: contractId, tenantId, collection: contracts },
      ...(snapshot.sourceQuote
        ? [
            {
              id: snapshot.sourceQuote.contractId,
              tenantId,
              collection: contracts,
            },
          ]
        : []),
    ]);
    const contract = await contracts.get({ id: contractId }, { cache: false });
    const validParty =
      direction === 'purchase'
        ? (contract instanceof SupplierQuote ||
            contract instanceof PurchaseOrder) &&
          contract.vendorId
        : (contract instanceof Order || contract instanceof Agreement) &&
          contract.customerId;
    if (!contract || contract.tenantId !== tenantId || !validParty)
      invalid(
        direction === 'purchase'
          ? 'Received money requires a supplier quote or purchase order in the active tenant'
          : 'Received money requires an Order or Agreement with a customer in the active tenant',
      );
    const stored = getReceivedPurchaseMoney(contract);
    if (stored) {
      if (JSON.stringify(stored) !== serialized)
        invalid(
          'Received money request changed; create a separate contract revision',
        );
      return stored;
    }
    if (
      direction === 'purchase' &&
      (contract instanceof SupplierQuote || contract instanceof PurchaseOrder)
    ) {
      const vendor = await (await VendorCollection.create({ db })).get(
        { id: contract.vendorId },
        { cache: false },
      );
      if (!vendor || vendor.tenantId !== tenantId)
        invalid('Supplier must belong to the active tenant');
    } else if (contract instanceof Order || contract instanceof Agreement) {
      const customer = await (await CustomerCollection.create({ db })).get(
        { id: contract.customerId },
        { cache: false },
      );
      if (!customer || customer.tenantId !== tenantId)
        invalid('Customer must belong to the active tenant');
    }
    if (snapshot.sourceQuote) {
      if (!(contract instanceof PurchaseOrder))
        invalid('Only a purchase order can reference a source quote');
      const source = await contracts.get(
        { id: snapshot.sourceQuote.contractId },
        { cache: false },
      );
      if (
        !(source instanceof SupplierQuote) ||
        source.tenantId !== tenantId ||
        source.vendorId !== contract.vendorId ||
        source.currency !== contract.currency ||
        source.status !== ContractStatus.ACCEPTED ||
        !source.moneySnapshotId
      )
        invalid(
          'Source quote must be accepted with matching tenant, vendor and currency',
        );
      const sourceMoney = getReceivedPurchaseMoney(source);
      if (!sourceMoney)
        invalid('Source quote must have received monetary evidence');
      if (
        snapshot.sourceQuote.relationship === 'copy' &&
        JSON.stringify(sourceMoney.facts) !== JSON.stringify(snapshot.facts)
      )
        invalid('Copied quote monetary facts must match exactly');
      if (
        snapshot.sourceQuote.relationship === 'negotiated' &&
        snapshot.evidenceRef === sourceMoney.evidenceRef
      )
        invalid(
          'Negotiated award requires separate approved monetary evidence',
        );
    }
    for (const component of snapshot.facts.taxComponents ?? []) {
      if (component.taxCodeId) {
        const code = await (await TaxCodeCollection.create({ db })).get(
          { id: component.taxCodeId },
          { cache: false },
        );
        if (!code || code.tenantId !== tenantId)
          invalid('Tax report code must belong to the active tenant');
        if (
          component.classification !== null &&
          code.kind !== component.classification
        )
          invalid('Explicit tax classification must match its selected code');
        if (
          component.taxComponentId &&
          !code.components.some(
            (entry) => entry.taxComponentId === component.taxComponentId,
          )
        )
          invalid('Tax component must belong to its selected tax code');
      }
      if (component.taxComponentId) {
        const tax = await (await TaxComponentCollection.create({ db })).get(
          { id: component.taxComponentId },
          { cache: false },
        );
        if (!tax || tax.tenantId !== tenantId)
          invalid('Tax report component must belong to the active tenant');
      }
    }
    if (contract.status !== ContractStatus.DRAFT || contract.moneySnapshotId)
      invalid('Received money requires an unfrozen draft');
    if (contract.currency !== snapshot.facts.currency)
      invalid('Received money currency must match the contract');
    const lines = await (
      await ContractLineItemCollection.create({ db })
    ).findByContract(contractId);
    if (lines.length)
      invalid('Received money cannot mix with calculated contract lines');
    contract.moneyAuthority = 'received';
    contract.receivedPurchaseMoneyJson = serialized;
    contract.subtotal = snapshot.facts.netMinor;
    contract.discountTotal = 0;
    contract.taxAmount = snapshot.facts.taxMinor;
    contract.totalAmount = snapshot.facts.grossMinor;
    await contract.saveDerived(DOCUMENT_MONEY_WRITE);
    return snapshot;
  });
}

/** A received order cannot silently disappear from tax reporting when facts are unknown. */
export class ReceivedPurchaseTaxClassificationRequired extends Error {
  readonly code = 'RECEIVED_PURCHASE_TAX_CLASSIFICATION_REQUIRED';
  constructor(readonly contractId: string) {
    super(
      `Purchase order ${contractId} needs explicit tax classification, tax-code/component identity, taxable basis and recoverability in its received evidence before tax reporting. Record a reviewed replacement revision; do not infer tax rates.`,
    );
    this.name = 'ReceivedPurchaseTaxClassificationRequired';
  }
}

/** @internal Project explicitly classified source facts without inventing DocumentTax rates. */
export function receivedPurchaseReportFacts(
  contract: Contract,
): import('./collections/DocumentTaxCollection.js').DocumentTaxReportFact[] {
  const snapshot = getReceivedPurchaseMoney(contract);
  if (!snapshot || !(contract instanceof PurchaseOrder)) return [];
  const id = text(contract.id, 'Purchase order identity');
  const components = snapshot.facts.taxComponents;
  if (!components?.length)
    throw new ReceivedPurchaseTaxClassificationRequired(id);
  return components.map((component) => {
    if (
      component.classification === null ||
      !component.taxCodeId ||
      component.taxableMinor == null ||
      component.recoverableMinor === null ||
      (component.taxableMinor > snapshot.facts.netMinor &&
        component.netMinor == null) ||
      (component.classification === 'taxable' && !component.taxComponentId)
    )
      throw new ReceivedPurchaseTaxClassificationRequired(id);
    return {
      tenantId: text(contract.tenantId, 'Tenant'),
      documentType: 'contract',
      documentId: id,
      documentNumber: contract.reference.trim() || id,
      partyId: contract.vendorId,
      documentKind: 'contract',
      issueDate: contract.issueDate.toISOString(),
      status: contract.status,
      direction: 'purchase',
      currency: snapshot.facts.currency,
      taxCodeId: component.taxCodeId,
      taxCodeKind: component.classification,
      taxableMinor: component.taxableMinor,
      ...(component.netMinor != null ? { netMinor: component.netMinor } : {}),
      taxMinor: component.amountMinor,
      recoverableMinor: component.recoverableMinor,
      taxComponentId: component.taxComponentId ?? null,
      componentName: component.label,
      liabilityAccountId: null,
      commitmentId: id,
      commitmentLineId: null,
    };
  });
}
