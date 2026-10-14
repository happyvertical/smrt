/** Transactional Contract money aggregate persistence. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ContractCollection } from './collections/ContractCollection.js';
import { ContractLineItemCollection } from './collections/ContractLineItemCollection.js';
import { CustomerCollection } from './collections/CustomerCollection.js';
import {
  DocumentTaxCollection,
  type DocumentTaxWriteInput,
} from './collections/DocumentTaxCollection.js';
import { TaxCodeCollection } from './collections/TaxCodeCollection.js';
import { TaxComponentCollection } from './collections/TaxComponentCollection.js';
import { VendorCollection } from './collections/VendorCollection.js';
import {
  DOCUMENT_MONEY_WRITE,
  lockDocumentMoneyParents,
} from './document-money-internal.js';
import type { Contract } from './models/Contract.js';
import type { ContractLineItem } from './models/ContractLineItem.js';
import {
  calculateMoneyDocument,
  MoneyValidationError,
  resolveLineTaxCode,
} from './money.js';
import {
  lockTenantMoneyMigrationOwner,
  withTenantMoneyRuntime,
} from './tenant-money-barrier.js';
import {
  ContractStatus,
  type ContractTaxComponentSnapshot,
} from './types/index.js';

type DeleteOptions = { expectedUpdatedAt?: Date | string };

const FROZEN_CONTRACT_FIELDS = [
  'tenantId',
  'subtotal',
  'discountTotal',
  'taxAmount',
  'totalAmount',
  'currency',
  'lineAmountType',
  'taxRoundingScope',
  'sellerTaxRegistrationsJson',
  'partyTaxId',
  'moneySnapshotId',
  'reference',
  'issueDate',
] as const;
const FROZEN_LINE_FIELDS = [
  'tenantId',
  'contractId',
  'description',
  'productId',
  'sku',
  'quantity',
  'unitPrice',
  'discountType',
  'discountRate',
  'discount',
  'taxMode',
  'taxCodeId',
  'taxCodeCode',
  'taxCodeName',
  'taxComponentsJson',
  'taxAmount',
  'taxRate',
  'amount',
  'sortOrder',
  'moneySnapshotId',
] as const;

function required(value: string | null | undefined, label: string): string {
  if (!value)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} requires an ID`,
    );
  return value;
}
function same(a: unknown, b: unknown): boolean {
  const value = (item: unknown) =>
    item instanceof Date ? item.toISOString() : (item ?? null);
  return value(a) === value(b);
}
function assertUnchanged<T extends object>(
  proposed: T,
  stored: T,
  fields: readonly (keyof T)[],
  label: string,
): void {
  for (const field of fields)
    if (!same(proposed[field], stored[field]))
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        `${label} ${String(field)} is frozen`,
      );
}
function isFrozen(contract: Contract): boolean {
  return contract.status !== ContractStatus.DRAFT || !!contract.moneySnapshotId;
}
function direction(contract: Contract): 'sales' | 'purchases' {
  return 'vendorId' in contract ? 'purchases' : 'sales';
}
function discount(line: ContractLineItem) {
  if (line.discountType === 'percent')
    return { kind: 'percent' as const, rate: line.discountRate };
  if (line.discountType === 'amount')
    return { kind: 'amount' as const, minor: line.discount };
  return { kind: 'none' as const };
}

async function loadContract(
  db: DatabaseInterface,
  id: string,
): Promise<Contract | null> {
  return (await ContractCollection.create({ db })).get(
    { id },
    { cache: false },
  );
}
async function withLockedContract<T>(
  db: DatabaseInterface,
  tenantId: string,
  contractId: string,
  operation: (contract: Contract, lines: ContractLineItem[]) => Promise<T>,
): Promise<T> {
  const contracts = await ContractCollection.create({ db });
  await lockDocumentMoneyParents([
    { id: contractId, tenantId, collection: contracts },
  ]);
  const contract = await contracts.get({ id: contractId }, { cache: false });
  if (!contract || contract.tenantId !== tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Contract was not found in its tenant',
    );
  const lines = await (
    await ContractLineItemCollection.create({ db })
  ).findByContract(contractId);
  return operation(contract, lines);
}

async function recompute(
  db: DatabaseInterface,
  contract: Contract,
  lines: ContractLineItem[],
  settings: NonNullable<
    Awaited<ReturnType<typeof lockTenantMoneyMigrationOwner>>
  >,
  persist: boolean,
  snapshotId = '',
): Promise<DocumentTaxWriteInput[]> {
  const tenantId = required(contract.tenantId, 'Contract tenant');
  const codes = await (await TaxCodeCollection.create({ db })).list({
    where: { tenantId },
  });
  const components = await (await TaxComponentCollection.create({ db })).list({
    where: { tenantId },
  });
  const byCode = Object.fromEntries(
    codes.flatMap((code) => {
      if (!code.id) return [];
      return [
        [
          code.id,
          {
            id: code.id,
            kind: code.kind,
            active: code.active,
            appliesTo: code.appliesTo,
            components: code.components.map((part) => ({
              taxComponentId: part.taxComponentId,
              percent:
                components.find(
                  (component) => component.id === part.taxComponentId,
                )?.percent ?? '0',
              compound: part.compound,
            })),
          },
        ],
      ] as const;
    }),
  );
  const codeById = new Map(
    codes.flatMap((code) => (code.id ? ([[code.id, code]] as const) : [])),
  );
  const customer =
    'customerId' in contract && contract.customerId
      ? await (await CustomerCollection.create({ db })).get(
          { id: contract.customerId },
          { cache: false },
        )
      : null;
  const vendor =
    'vendorId' in contract && contract.vendorId
      ? await (await VendorCollection.create({ db })).get(
          { id: contract.vendorId },
          { cache: false },
        )
      : null;
  const resolved = new Map<string, string | null>();
  const result = calculateMoneyDocument({
    currency: contract.currency,
    lineAmountType: contract.lineAmountType,
    roundingScope: contract.taxRoundingScope,
    lines: lines.map((line) => {
      const selected = resolveLineTaxCode(
        {
          lineAmountType: contract.lineAmountType,
          lineOverride: line.taxMode === 'override' ? line.taxCodeId : null,
        },
        {
          direction: direction(contract),
          codes: byCode,
          customerTaxExempt: customer?.taxExempt ?? false,
          exemptCodeId:
            codes.find((code) => code.kind === 'exempt')?.id ?? null,
          productCodeId: null,
          partyCodeId:
            customer?.defaultTaxCodeId ?? vendor?.defaultTaxCodeId ?? null,
          appDefaultCodeId:
            direction(contract) === 'sales'
              ? settings.defaultSalesTaxCodeId
              : settings.defaultPurchaseTaxCodeId,
          outOfScopeCodeId:
            codes.find((code) => code.kind === 'out-of-scope')?.id ?? null,
        },
      );
      resolved.set(
        required(line.id, 'Contract line'),
        selected.taxCode?.id ?? null,
      );
      return {
        id: required(line.id, 'Contract line'),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: discount(line),
        taxCode: selected.taxCode,
      };
    }),
  });
  const resultById = new Map(result.lines.map((row) => [row.id, row]));
  for (const line of lines) {
    const lineId = required(line.id, 'Contract line');
    const row = resultById.get(lineId);
    if (!row)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `Calculated Contract line ${lineId} was not loaded`,
      );
    const codeId = resolved.get(lineId) ?? null;
    const code = codeId ? (codeById.get(codeId) ?? null) : null;
    line.discount = row.discountMinor;
    line.amount = row.amountMinor;
    line.taxAmount = row.taxMinor;
    line.taxCodeId = code?.id ?? null;
    line.taxCodeCode = code?.code ?? null;
    line.taxCodeName = code?.name ?? null;
    line.taxComponents = row.components.map(
      (part): ContractTaxComponentSnapshot => {
        const component = components.find(
          (item) => item.id === part.taxComponentId,
        );
        if (!component)
          throw new MoneyValidationError(
            'TAX_CODE_NOT_FOUND',
            `Tax component ${part.taxComponentId} was not loaded`,
          );
        return {
          taxComponentId: part.taxComponentId,
          name: component.name,
          percent: component.percent,
          taxMinor: part.taxMinor,
        };
      },
    );
    line.taxRate = line.taxComponents.reduce(
      (sum, part) => sum + Number(part.percent) / 100,
      0,
    );
    if (snapshotId) line.moneySnapshotId = snapshotId;
    if (persist) await line.saveDerived(DOCUMENT_MONEY_WRITE, false);
  }
  const taxRows = result.taxes.map((tax): DocumentTaxWriteInput => {
    const code = tax.taxCodeId ? (codeById.get(tax.taxCodeId) ?? null) : null;
    const component = tax.taxComponentId
      ? (components.find((item) => item.id === tax.taxComponentId) ?? null)
      : null;
    return {
      tenantId,
      documentType: 'contract',
      documentId: required(contract.id, 'Contract'),
      currency: contract.currency,
      taxCodeId: code?.id ?? null,
      taxCodeCode: code?.code ?? null,
      kind: code?.kind ?? null,
      taxComponentId: component?.id ?? null,
      taxComponentName: component?.name ?? null,
      percent: component?.percent ?? null,
      liabilityAccountId: component?.liabilityAccountId ?? null,
      taxableMinor: tax.taxableMinor,
      taxMinor: tax.taxMinor,
      recoverableMinor:
        direction(contract) === 'purchases' && component?.recoverable
          ? tax.taxMinor
          : 0,
    };
  });
  contract.subtotal = result.subtotalMinor;
  contract.discountTotal = result.discountTotalMinor;
  contract.taxAmount = result.taxMinor;
  contract.totalAmount = result.totalMinor;
  if (persist)
    await (
      await DocumentTaxCollection.create({ db })
    ).replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
      tenantId,
      documentType: 'contract',
      documentId: required(contract.id, 'Contract'),
      rows: taxRows,
    });
  return taxRows;
}

/** Save a Contract through legacy compatibility or the v2 aggregate. */
export async function saveContract(input: Contract): Promise<Contract> {
  const tenantId = input.tenantId ?? getTenantId() ?? null;
  if (!tenantId) return input.saveDerived(DOCUMENT_MONEY_WRITE);
  return withTenantMoneyRuntime(
    input.db,
    tenantId,
    'legacy-or-v2',
    async (scope) =>
      input.withDatabase(scope.db, async (contract) => {
        if (scope.barrier.moneyModel === 'legacy')
          return contract.saveDerived(DOCUMENT_MONEY_WRITE);
        const settings = scope.barrier.settings;
        const existing = contract.id
          ? await loadContract(scope.db, contract.id)
          : null;
        if (existing && existing.tenantId !== scope.tenantId)
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Contract tenant identity cannot change',
          );
        if (!existing) {
          contract.tenantId = tenantId;
          contract.lineAmountType = settings.defaultLineAmountType;
          contract.taxRoundingScope = settings.taxRoundingScope;
          if (contract.status !== ContractStatus.DRAFT) {
            contract.moneySnapshotId = crypto.randomUUID();
            contract.sellerTaxRegistrations = structuredClone(
              settings.taxRegistrations,
            );
          }
          return contract.saveDerived(DOCUMENT_MONEY_WRITE);
        }
        return withLockedContract(
          scope.db,
          tenantId,
          required(existing.id, 'Contract'),
          async (stored, lines) => {
            if (isFrozen(stored)) {
              assertUnchanged(
                contract,
                stored,
                FROZEN_CONTRACT_FIELDS,
                'Contract',
              );
              return contract.saveDerived(DOCUMENT_MONEY_WRITE);
            }
            const freezing = contract.status !== ContractStatus.DRAFT;
            const snapshotId = freezing
              ? stored.moneySnapshotId || crypto.randomUUID()
              : '';
            await recompute(
              scope.db,
              contract,
              lines,
              settings,
              true,
              snapshotId,
            );
            if (freezing) {
              const party =
                'customerId' in contract && contract.customerId
                  ? await (
                      await CustomerCollection.create({ db: scope.db })
                    ).get({ id: contract.customerId }, { cache: false })
                  : 'vendorId' in contract && contract.vendorId
                    ? await (
                        await VendorCollection.create({ db: scope.db })
                      ).get({ id: contract.vendorId }, { cache: false })
                    : null;
              contract.sellerTaxRegistrations = structuredClone(
                settings.taxRegistrations,
              );
              contract.partyTaxId = party?.taxId ?? '';
              contract.moneySnapshotId = snapshotId;
            }
            return contract.saveDerived(DOCUMENT_MONEY_WRITE);
          },
        );
      }),
  );
}

/** Save a line and atomically recompute its Contract aggregate. */
export async function saveContractLineItem(
  input: ContractLineItem,
): Promise<ContractLineItem> {
  const tenantId = input.tenantId ?? getTenantId() ?? null;
  if (!tenantId) return input.saveDerived(DOCUMENT_MONEY_WRITE, true);
  return withTenantMoneyRuntime(
    input.db,
    tenantId,
    'legacy-or-v2',
    async (scope) =>
      input.withDatabase(scope.db, async (line) => {
        const persisted = line.id
          ? await (
              await ContractLineItemCollection.create({ db: scope.db })
            ).get({ id: line.id }, { cache: false })
          : null;
        const contractId = persisted?.contractId ?? line.contractId;
        if (scope.barrier.moneyModel === 'legacy')
          return line.saveDerived(DOCUMENT_MONEY_WRITE, true);
        const settings = scope.barrier.settings;
        return withLockedContract(
          scope.db,
          scope.tenantId,
          contractId,
          async (contract, lines) => {
            if (persisted && line.contractId !== persisted.contractId)
              throw new MoneyValidationError(
                'FROZEN_DOCUMENT',
                'Contract line cannot move between parents',
              );
            if (isFrozen(contract)) {
              if (!persisted)
                throw new MoneyValidationError(
                  'FROZEN_DOCUMENT',
                  'Cannot add a line to a frozen Contract',
                );
              assertUnchanged(
                line,
                persisted,
                FROZEN_LINE_FIELDS,
                'Contract line',
              );
              return line.saveDerived(DOCUMENT_MONEY_WRITE, false);
            }
            line.contractId = contractId;
            line.tenantId = scope.tenantId;
            await line.saveDerived(DOCUMENT_MONEY_WRITE, false);
            const all = [
              ...lines.filter((candidate) => candidate.id !== line.id),
              line,
            ];
            await recompute(scope.db, contract, all, settings, true);
            await contract.saveDerived(DOCUMENT_MONEY_WRITE);
            return line;
          },
        );
      }),
  );
}

export async function deleteContractLineItem(
  input: ContractLineItem,
  options: DeleteOptions,
): Promise<void> {
  const tenantId = input.tenantId ?? getTenantId() ?? null;
  if (!tenantId) return input.deleteDerived(DOCUMENT_MONEY_WRITE, options);
  await withTenantMoneyRuntime(
    input.db,
    tenantId,
    'legacy-or-v2',
    async (scope) =>
      input.withDatabase(scope.db, async (line) => {
        const persisted = line.id
          ? await (
              await ContractLineItemCollection.create({ db: scope.db })
            ).get({ id: line.id }, { cache: false })
          : null;
        if (!persisted) return;
        if (scope.barrier.moneyModel === 'legacy')
          return line.deleteDerived(DOCUMENT_MONEY_WRITE, options);
        const settings = scope.barrier.settings;
        await withLockedContract(
          scope.db,
          scope.tenantId,
          persisted.contractId,
          async (contract, lines) => {
            if (isFrozen(contract))
              throw new MoneyValidationError(
                'FROZEN_DOCUMENT',
                'Cannot delete a line from a frozen Contract',
              );
            await line.deleteDerived(DOCUMENT_MONEY_WRITE, options);
            await recompute(
              scope.db,
              contract,
              lines.filter((candidate) => candidate.id !== persisted.id),
              settings,
              true,
            );
            await contract.saveDerived(DOCUMENT_MONEY_WRITE);
          },
        );
      }),
  );
}

/** Recompute a Contract through its normal runtime gate. */
export async function recalculateContractTotals(
  contract: Contract,
): Promise<void> {
  await saveContract(contract);
}

/** Migration-only materializer; caller already owns the tenant migration transaction. */
export async function materializeContractMoneySnapshot(input: {
  db: DatabaseInterface;
  contractId: string;
  tenantId: string;
  migrationId: string;
}): Promise<{ contractId: string; taxRows: DocumentTaxWriteInput[] }> {
  const settings = await lockTenantMoneyMigrationOwner(
    input.db,
    input.tenantId,
    input.migrationId,
  );
  return withLockedContract(
    input.db,
    input.tenantId,
    input.contractId,
    async (contract, lines) => {
      if (contract.status !== ContractStatus.DRAFT)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Only a draft Contract can be migration-recomputed',
        );
      const taxRows = await recompute(
        input.db,
        contract,
        lines,
        settings,
        true,
      );
      await contract.saveDerived(DOCUMENT_MONEY_WRITE);
      return { contractId: input.contractId, taxRows };
    },
  );
}
