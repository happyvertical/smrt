import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import {
  DOCUMENT_MONEY_WRITE,
  lockDocumentMoneyParents,
  withDocumentMoneyTransaction,
} from '../document-money-internal.js';
import { MoneyValidationError } from '../money.js';

describe('DocumentTax persistence primitives (#3933)', () => {
  let db: DatabaseInterface;
  let taxes: DocumentTaxCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    taxes = await DocumentTaxCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('declares a read-only generated surface and nullable conflict identity', () => {
    const config = ObjectRegistry.getConfig('DocumentTax');
    expect(config?.api).toEqual({ include: ['list', 'get'] });
    expect(config?.mcp).toEqual({ include: ['list', 'get'] });
    expect(config?.cli).toEqual({ include: ['list', 'get'] });

    const schema = ObjectRegistry.getSchema('DocumentTax');
    expect(schema?.tableName).toBe('document_taxes');
    expect(schema?.columns.tax_code_id?.notNull).toBe(false);
    expect(schema?.columns.tax_component_id?.notNull).toBe(false);
    expect(
      schema?.indexes.some(
        (index) =>
          index.unique === true &&
          index.nullsNotDistinct === true &&
          index.columns.join(',') ===
            'document_type,document_id,tax_code_id,tax_component_id',
      ),
    ).toBe(true);
  });

  it('persists a genuine unassigned null/null row without a synthetic id', async () => {
    const [created] = await withTenant({ tenantId: 'tenant-a' }, () =>
      taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId: 'tenant-a',
        documentType: 'invoice',
        documentId: 'invoice-a',
        rows: [
          {
            tenantId: 'tenant-a',
            documentType: 'invoice',
            documentId: 'invoice-a',
            currency: 'CAD',
            taxCodeId: null,
            taxCodeCode: null,
            kind: null,
            taxComponentId: null,
            taxComponentName: null,
            percent: null,
            liabilityAccountId: null,
            taxableMinor: 1250,
            taxMinor: 0,
            recoverableMinor: 0,
          },
        ],
      }),
    );

    expect(created.taxCodeId).toBeNull();
    expect(created.taxComponentId).toBeNull();
    const reloaded = await withTenant({ tenantId: 'tenant-a' }, () =>
      taxes.findByDocument('tenant-a', 'invoice', 'invoice-a'),
    );
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      taxableMinor: 1250,
      taxMinor: 0,
      taxCodeId: null,
      taxComponentId: null,
    });
  });

  it('keeps unchanged replacement bytes and removes stale derived rows', async () => {
    const input = {
      tenantId: 'tenant-a',
      documentType: 'contract' as const,
      documentId: 'contract-a',
      rows: [
        {
          tenantId: 'tenant-a',
          documentType: 'contract' as const,
          documentId: 'contract-a',
          currency: 'CAD',
          taxCodeId: 'gst',
          taxCodeCode: 'GST',
          kind: 'taxable' as const,
          taxComponentId: 'gst-component',
          taxComponentName: 'GST',
          percent: '5',
          liabilityAccountId: 'gst-payable',
          taxableMinor: 1000,
          taxMinor: 50,
          recoverableMinor: 50,
        },
      ],
    };
    const [first] = await withTenant({ tenantId: 'tenant-a' }, () =>
      taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, input),
    );
    const firstUpdatedAt = first.updated_at?.toISOString();
    const [second] = await withTenant({ tenantId: 'tenant-a' }, () =>
      taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, input),
    );
    expect(second.id).toBe(first.id);
    expect(second.updated_at?.toISOString()).toBe(firstUpdatedAt);

    await withTenant({ tenantId: 'tenant-a' }, () =>
      taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        ...input,
        rows: [],
      }),
    );
    await expect(
      withTenant({ tenantId: 'tenant-a' }, () =>
        taxes.findByDocument('tenant-a', 'contract', 'contract-a'),
      ),
    ).resolves.toEqual([]);
  });

  it('rejects duplicate null identities and every direct write path', async () => {
    const nullRow = {
      tenantId: 'tenant-a',
      documentType: 'invoice' as const,
      documentId: 'invoice-duplicate',
      currency: 'USD',
      taxCodeId: null,
      taxCodeCode: null,
      kind: null,
      taxComponentId: null,
      taxComponentName: null,
      percent: null,
      liabilityAccountId: null,
      taxableMinor: 100,
      taxMinor: 0,
      recoverableMinor: 0,
    };
    await expect(
      withTenant({ tenantId: 'tenant-a' }, () =>
        taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
          tenantId: 'tenant-a',
          documentType: 'invoice',
          documentId: 'invoice-duplicate',
          rows: [nullRow, { ...nullRow, taxableMinor: 200 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });

    await expect(
      withTenant({ tenantId: 'tenant-a' }, () => taxes.create(nullRow)),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });

    const [derived] = await withTenant({ tenantId: 'tenant-a' }, () =>
      taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId: 'tenant-a',
        documentType: 'invoice',
        documentId: 'invoice-direct',
        rows: [{ ...nullRow, documentId: 'invoice-direct' }],
      }),
    );
    derived.taxableMinor = 999;
    await expect(derived.save()).rejects.toBeInstanceOf(MoneyValidationError);
    await expect(
      withTenant({ tenantId: 'tenant-a' }, () => taxes.delete(derived.id)),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
  });

  it('locks parents sequentially in stable code-unit order', async () => {
    const calls: string[] = [];
    const collection = {
      tableName: 'invoices',
      async query(_sql: string, params: unknown[]) {
        calls.push(String(params[0]));
        return [{}];
      },
    };
    await lockDocumentMoneyParents([
      { id: 'line-z', tenantId: 'tenant-a', collection },
      { id: 'line-A', tenantId: 'tenant-a', collection },
      { id: 'line-a', tenantId: 'tenant-a', collection },
    ]);
    expect(calls).toEqual(['line-A', 'line-a', 'line-z']);
  });

  it('requires transaction support and returns the callback result', async () => {
    const tx = {
      query: async () => ({ rows: [] }),
    } as unknown as DatabaseInterface;
    const root = {
      transaction: async (
        operation: (bound: DatabaseInterface) => Promise<string>,
      ) => operation(tx),
    } as unknown as DatabaseInterface;
    await expect(
      withDocumentMoneyTransaction(root, async (bound) =>
        bound === tx ? 'committed' : 'wrong executor',
      ),
    ).resolves.toBe('committed');
    await expect(
      withDocumentMoneyTransaction({} as DatabaseInterface, async () => 'no'),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
  });
});
