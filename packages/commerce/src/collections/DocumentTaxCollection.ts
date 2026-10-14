/** Owning collection for derived document tax totals. */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  DOCUMENT_MONEY_WRITE,
  type DocumentMoneyWriteCapability,
} from '../document-money-internal.js';
import {
  type CommerceDocumentType,
  DocumentTax,
  type DocumentTaxOptions,
} from '../models/DocumentTax.js';
import { MoneyValidationError } from '../money.js';

export type DocumentTaxWriteInput = Required<
  Pick<
    DocumentTaxOptions,
    | 'tenantId'
    | 'documentType'
    | 'documentId'
    | 'currency'
    | 'taxCodeId'
    | 'taxCodeCode'
    | 'kind'
    | 'taxComponentId'
    | 'taxComponentName'
    | 'percent'
    | 'liabilityAccountId'
    | 'taxableMinor'
    | 'taxMinor'
    | 'recoverableMinor'
  >
>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identity(
  row: Pick<DocumentTaxWriteInput, 'taxCodeId' | 'taxComponentId'>,
): string {
  return `${row.taxCodeId === null ? '0:' : `1:${row.taxCodeId}`}\u0000${
    row.taxComponentId === null ? '0:' : `1:${row.taxComponentId}`
  }`;
}

const BUSINESS_FIELDS = [
  'tenantId',
  'documentType',
  'documentId',
  'currency',
  'taxCodeId',
  'taxCodeCode',
  'kind',
  'taxComponentId',
  'taxComponentName',
  'percent',
  'liabilityAccountId',
  'taxableMinor',
  'taxMinor',
  'recoverableMinor',
] as const;

function unchanged(row: DocumentTax, input: DocumentTaxWriteInput): boolean {
  return BUSINESS_FIELDS.every((field) => {
    const persisted = row[field];
    const proposed = input[field];
    if (field === 'percent' && persisted !== null && proposed !== null) {
      return String(persisted) === String(proposed);
    }
    return (persisted ?? null) === (proposed ?? null);
  });
}

export class DocumentTaxCollection extends SmrtCollection<DocumentTax> {
  static readonly _itemClass = DocumentTax;

  async findByDocument(
    tenantId: string,
    documentType: CommerceDocumentType,
    documentId: string,
  ): Promise<DocumentTax[]> {
    return this.list({
      where: { tenantId, documentType, documentId },
      orderBy: ['taxCodeId ASC', 'taxComponentId ASC'],
    });
  }

  /**
   * Replace one draft document's derived rows on the caller's transaction.
   * Unchanged rows are not saved, preserving their exact persisted bytes.
   *
   * @internal Aggregate persistence only.
   */
  async replaceDerivedForDocument(
    capability: DocumentMoneyWriteCapability,
    input: {
      tenantId: string;
      documentType: CommerceDocumentType;
      documentId: string;
      rows: readonly DocumentTaxWriteInput[];
    },
  ): Promise<DocumentTax[]> {
    if (capability !== DOCUMENT_MONEY_WRITE) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'DocumentTax write capability is required',
      );
    }
    const desired = new Map<string, DocumentTaxWriteInput>();
    for (const row of input.rows) {
      if (
        row.tenantId !== input.tenantId ||
        row.documentType !== input.documentType ||
        row.documentId !== input.documentId
      ) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'DocumentTax replacement rows must share tenant and document identity',
        );
      }
      const key = identity(row);
      if (desired.has(key)) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'DocumentTax replacement contains a duplicate code/component identity',
        );
      }
      desired.set(key, row);
    }

    const existing = await this.findByDocument(
      input.tenantId,
      input.documentType,
      input.documentId,
    );
    const byIdentity = new Map(existing.map((row) => [identity(row), row]));
    const result: DocumentTax[] = [];
    for (const [key, rowInput] of [...desired].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      const current = byIdentity.get(key);
      if (current) {
        byIdentity.delete(key);
        if (!unchanged(current, rowInput)) {
          Object.assign(current, rowInput);
          await current.saveDerived(capability);
        }
        result.push(current);
        continue;
      }
      const created = await this.createUnsaved(rowInput);
      await created.saveDerived(capability);
      result.push(created);
    }
    for (const stale of [...byIdentity.values()].sort((left, right) =>
      compareCodeUnits(String(left.id), String(right.id)),
    )) {
      await stale.deleteDerived(capability, {
        expectedUpdatedAt: stale.updated_at ?? undefined,
      });
    }
    return result;
  }
}
