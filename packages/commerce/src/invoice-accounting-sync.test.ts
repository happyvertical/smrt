import {
  type CreditMemoInput,
  type InvoiceInput,
  QuickBooksWriteError,
  type SyncResult,
} from '@happyvertical/accounting';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerCollection } from './collections/CustomerCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from './collections/TaxCodeCollection.js';
import { TaxComponentCollection } from './collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from './collections/TaxSettingsCollection.js';
import {
  type QuickBooksFrozenInvoiceMapping,
  readFrozenAccountingSyncState,
  reconcileFrozenInvoiceAccountingSync,
  runQuickBooksPilot,
  syncFrozenInvoiceToAccounting,
  toFrozenInvoiceAccountingInput,
} from './invoice-accounting-sync.js';
import type { Invoice } from './models/Invoice.js';
import {
  type QuickBooksPilotInvoiceEvidence,
  quickBooksPilotInvoiceId,
} from './quickbooks-pilot-evidence.js';
import { ensureTenantTaxCodes } from './tax/standard-codes.js';
import { InvoiceStatus } from './types/index.js';

describe('frozen invoice accounting sync (#3937)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function issuedInvoice(
    tenantId: string,
    options: {
      lineAmountType?: 'exclusive' | 'inclusive';
      discount?: number;
      quantity?: number;
      invoiceId?: string;
    } = {},
  ): Promise<{
    invoice: Invoice;
    lineId: string;
    componentId: string;
  }> {
    await ensureTenantTaxCodes(db, tenantId);
    return withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const component = await components.create({ name: 'GST', percent: '5' });
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: component.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = code.id;
      current.defaultLineAmountType = options.lineAmountType ?? 'exclusive';
      current.taxRoundingScope = 'document';
      await current.save();

      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: code.id,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        id: options.invoiceId,
        customerId: customer.id,
        customerExternalId: 'qbo-customer',
        invoiceNumber: `INV-${tenantId}`,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: 'Consulting',
        quantity: options.quantity ?? 2,
        unitPrice: 100,
        discountType: options.discount ? 'amount' : 'none',
        discount: options.discount ?? 0,
        taxMode: 'override',
        taxCodeId: code.id,
      });
      const stored = await invoices.get({ id: invoice.id }, { cache: false });
      if (!stored) throw new Error('Expected invoice');
      stored.status = InvoiceStatus.SENT;
      await stored.save();
      return { invoice: stored, lineId: line.id, componentId: component.id };
    });
  }

  function mapping(
    lineId: string,
    componentId: string,
    realmId = 'realm-a',
  ): QuickBooksFrozenInvoiceMapping {
    return {
      realmId,
      environment: 'sandbox',
      lines: {
        [lineId]: { itemRef: 'item-consulting', taxCodeRef: 'tax-gst' },
      },
      components: {
        [componentId]: { quickbooksTaxRateRef: 'rate-gst' },
      },
    };
  }

  function provider(
    push: (input: InvoiceInput) => Promise<SyncResult>,
    creditPush?: (input: CreditMemoInput) => Promise<SyncResult>,
  ): Parameters<typeof syncFrozenInvoiceToAccounting>[0]['provider'] {
    return {
      type: 'quickbooks',
      invoices: { push } as Parameters<
        typeof syncFrozenInvoiceToAccounting
      >[0]['provider']['invoices'],
      ...(creditPush
        ? {
            creditMemos: { push: creditPush, sync: creditPush },
          }
        : {}),
    };
  }

  it('maps stored exclusive facts through the released SDK contract and no-ops unchanged sync', async () => {
    const seeded = await issuedInvoice('tenant-sync');
    await withTenant({ tenantId: 'tenant-sync' }, async () => {
      const push = vi.fn(
        async (input: InvoiceInput): Promise<SyncResult> => ({
          action: 'created',
          externalId: 'qbo-invoice-1',
          syncedAt: new Date('2026-10-14T12:00:00.000Z'),
        }),
      );
      const explicitMapping = mapping(seeded.lineId, seeded.componentId);
      const converted = await toFrozenInvoiceAccountingInput({
        db,
        tenantId: 'tenant-sync',
        invoiceId: seeded.invoice.id,
        mapping: explicitMapping,
      });
      expect(converted).toMatchObject({
        subtotal: 2,
        taxAmount: 0.1,
        totalAmount: 2.1,
        quickbooksMapping: { globalTaxCalculation: 'TaxExcluded' },
        lineItems: [
          {
            quantity: 2,
            unitPrice: 1,
            amount: 2,
            quickbooksMapping: {
              itemRef: 'item-consulting',
              taxCodeRef: 'tax-gst',
            },
          },
        ],
      });
      expect(converted.lineItems[0]).not.toHaveProperty('taxRate');
      expect(converted.lineItems[0]).not.toHaveProperty('discount');

      const first = await syncFrozenInvoiceToAccounting({
        db,
        tenantId: 'tenant-sync',
        invoiceId: seeded.invoice.id,
        mapping: explicitMapping,
        provider: provider(push),
      });
      expect(first).toMatchObject({
        status: 'synced',
        externalId: 'qbo-invoice-1',
      });
      expect(push).toHaveBeenCalledTimes(1);
      const sent = push.mock.calls[0]?.[0];
      expect(sent?.quickbooksRequest?.requestId).toMatch(/^smrt_[a-f0-9]{40}$/);
      expect(sent?.idempotencyKey).toBe(sent?.quickbooksRequest?.requestId);

      const lifecycle = await (await InvoiceCollection.create({ db })).get(
        { id: seeded.invoice.id },
        { cache: false },
      );
      if (!lifecycle) throw new Error('Expected synced invoice');
      lifecycle.status = InvoiceStatus.VIEWED;
      await lifecycle.save();
      expect(lifecycle.moneySnapshotId).toBe(seeded.invoice.moneySnapshotId);

      const unchanged = await syncFrozenInvoiceToAccounting({
        db,
        tenantId: 'tenant-sync',
        invoiceId: seeded.invoice.id,
        mapping: explicitMapping,
        provider: provider(push),
      });
      expect(unchanged.status).toBe('unchanged');
      expect(push).toHaveBeenCalledTimes(1);
      const stored = await (await InvoiceCollection.create({ db })).get(
        { id: seeded.invoice.id },
        { cache: false },
      );
      expect(stored && readFrozenAccountingSyncState(stored)).toMatchObject({
        status: 'synced',
        realmId: 'realm-a',
        moneySnapshotId: seeded.invoice.moneySnapshotId,
      });
    });
  });

  it('serializes competing calls before provider I/O', async () => {
    const seeded = await issuedInvoice('tenant-race');
    await withTenant({ tenantId: 'tenant-race' }, async () => {
      let release!: (value: SyncResult) => void;
      const pending = new Promise<SyncResult>((resolve) => {
        release = resolve;
      });
      const push = vi.fn(() => pending);
      const input = {
        db,
        tenantId: 'tenant-race',
        invoiceId: seeded.invoice.id,
        mapping: mapping(seeded.lineId, seeded.componentId),
        provider: provider(push),
      };
      const first = syncFrozenInvoiceToAccounting(input);
      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
      await expect(syncFrozenInvoiceToAccounting(input)).rejects.toMatchObject({
        code: 'ACCOUNTING_SYNC_IN_PROGRESS',
      });
      const owned = await (await InvoiceCollection.create({ db })).get(
        { id: seeded.invoice.id },
        { cache: false },
      );
      if (!owned) throw new Error('Expected owned invoice');
      const state = readFrozenAccountingSyncState(owned);
      if (!state) throw new Error('Expected accounting state');
      await expect(
        reconcileFrozenInvoiceAccountingSync({
          db,
          tenantId: 'tenant-race',
          invoiceId: seeded.invoice.id,
          mapping: input.mapping,
          requestId: state.requestId,
          attemptId: state.attemptId,
          outcome: { status: 'absent' },
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNTING_SYNC_IN_PROGRESS' });
      expect(push).toHaveBeenCalledTimes(1);
      release({
        action: 'created',
        externalId: 'qbo-race',
        syncedAt: new Date('2026-10-14T12:00:00.000Z'),
      });
      await expect(first).resolves.toMatchObject({ status: 'synced' });
    });
  });

  it('reconciles confirmed absence and retries the identical request after an unknown outcome', async () => {
    const unknown = await issuedInvoice('tenant-unknown');
    await withTenant({ tenantId: 'tenant-unknown' }, async () => {
      const requests: string[] = [];
      const push = vi.fn(async (invoice: InvoiceInput): Promise<SyncResult> => {
        requests.push(JSON.stringify(invoice.quickbooksRequest));
        if (requests.length === 1) throw new Error('socket closed after write');
        return {
          action: 'created',
          externalId: 'qbo-after-absence',
          syncedAt: new Date('2026-10-14T12:30:00.000Z'),
        };
      });
      const explicitMapping = mapping(unknown.lineId, unknown.componentId);
      const input = {
        db,
        tenantId: 'tenant-unknown',
        invoiceId: unknown.invoice.id,
        mapping: explicitMapping,
        provider: provider(push),
      };
      await expect(syncFrozenInvoiceToAccounting(input)).rejects.toThrow(
        'socket closed after write',
      );
      await expect(syncFrozenInvoiceToAccounting(input)).rejects.toMatchObject({
        code: 'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
      });
      expect(push).toHaveBeenCalledTimes(1);
      const unresolved = await (await InvoiceCollection.create({ db })).get(
        { id: unknown.invoice.id },
        { cache: false },
      );
      if (!unresolved) throw new Error('Expected unresolved invoice');
      const state = readFrozenAccountingSyncState(unresolved);
      if (!state) throw new Error('Expected accounting state');
      await expect(
        reconcileFrozenInvoiceAccountingSync({
          db,
          tenantId: 'tenant-unknown',
          invoiceId: unknown.invoice.id,
          mapping: explicitMapping,
          requestId: state.requestId,
          attemptId: 'stale-attempt',
          outcome: { status: 'absent' },
        }),
      ).rejects.toMatchObject({
        code: 'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
      });
      await expect(
        reconcileFrozenInvoiceAccountingSync({
          db,
          tenantId: 'tenant-unknown',
          invoiceId: unknown.invoice.id,
          mapping: explicitMapping,
          requestId: state.requestId,
          attemptId: state.attemptId,
          outcome: { status: 'absent' },
        }),
      ).resolves.toMatchObject({
        status: 'ready',
        requestId: state.requestId,
      });
      await expect(syncFrozenInvoiceToAccounting(input)).resolves.toMatchObject(
        { status: 'synced', externalId: 'qbo-after-absence' },
      );
      expect(requests[1]).toBe(requests[0]);
    });
  });

  it('records a provider-found document while reconciling an unknown outcome', async () => {
    const seeded = await issuedInvoice('tenant-found');
    await withTenant({ tenantId: 'tenant-found' }, async () => {
      const push = vi.fn(async (): Promise<SyncResult> => {
        throw new Error('provider response lost');
      });
      const explicitMapping = mapping(seeded.lineId, seeded.componentId);
      const input = {
        db,
        tenantId: 'tenant-found',
        invoiceId: seeded.invoice.id,
        mapping: explicitMapping,
        provider: provider(push),
      };
      await expect(syncFrozenInvoiceToAccounting(input)).rejects.toThrow(
        'provider response lost',
      );
      const current = await (await InvoiceCollection.create({ db })).get(
        { id: seeded.invoice.id },
        { cache: false },
      );
      if (!current) throw new Error('Expected in-flight invoice');
      const state = readFrozenAccountingSyncState(current);
      if (!state) throw new Error('Expected accounting state');
      await expect(
        reconcileFrozenInvoiceAccountingSync({
          db,
          tenantId: 'tenant-found',
          invoiceId: seeded.invoice.id,
          mapping: explicitMapping,
          requestId: state.requestId,
          attemptId: state.attemptId,
          outcome: {
            status: 'found',
            externalId: 'qbo-found',
            syncedAt: new Date('2026-10-14T12:45:00.000Z'),
          },
        }),
      ).resolves.toMatchObject({ status: 'synced', externalId: 'qbo-found' });
      await expect(syncFrozenInvoiceToAccounting(input)).resolves.toMatchObject(
        { status: 'unchanged', externalId: 'qbo-found' },
      );
      expect(push).toHaveBeenCalledTimes(1);
    });
  });

  it('requires reconciliation on realm changes', async () => {
    const synced = await issuedInvoice('tenant-realm');
    await withTenant({ tenantId: 'tenant-realm' }, async () => {
      const push = vi.fn(
        async (): Promise<SyncResult> => ({
          action: 'created',
          externalId: 'qbo-realm',
          syncedAt: new Date('2026-10-14T12:00:00.000Z'),
        }),
      );
      await syncFrozenInvoiceToAccounting({
        db,
        tenantId: 'tenant-realm',
        invoiceId: synced.invoice.id,
        mapping: mapping(synced.lineId, synced.componentId),
        provider: provider(push),
      });
      await expect(
        syncFrozenInvoiceToAccounting({
          db,
          tenantId: 'tenant-realm',
          invoiceId: synced.invoice.id,
          mapping: mapping(synced.lineId, synced.componentId, 'realm-b'),
          provider: provider(push),
        }),
      ).rejects.toMatchObject({
        code: 'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
      });
      expect(push).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps accounting coordination state off public and generated write surfaces', async () => {
    const seeded = await issuedInvoice('tenant-sync-policy');
    await withTenant({ tenantId: 'tenant-sync-policy' }, async () => {
      const stored = await (await InvoiceCollection.create({ db })).get(
        { id: seeded.invoice.id },
        { cache: false },
      );
      if (!stored) throw new Error('Expected invoice');
      stored.accountingSyncStateJson = '{"server":"owned"}';
      expect(stored.toPublicJSON()).not.toHaveProperty(
        'accountingSyncStateJson',
      );
      const config = ObjectRegistry.getConfig('Invoice');
      const stateField = ObjectRegistry.getFields('Invoice').get(
        'accountingSyncStateJson',
      );
      expect(stateField).toMatchObject({ sensitive: true });
      const writable = (config.api as { writable?: string[] })?.writable;
      expect(writable).toBeDefined();
      expect(writable).not.toContain('accountingSyncStateJson');
      expect((config.mcp as { include?: string[] })?.include).toEqual([
        'list',
        'get',
      ]);
    });
  });

  it('reuses the identical prepared request after a confirmed provider rejection', async () => {
    const seeded = await issuedInvoice('tenant-rejected');
    await withTenant({ tenantId: 'tenant-rejected' }, async () => {
      const requests: string[] = [];
      const push = vi.fn(async (invoice: InvoiceInput): Promise<SyncResult> => {
        const request = invoice.quickbooksRequest;
        if (!request) throw new Error('Expected prepared request');
        requests.push(JSON.stringify(request));
        if (requests.length === 1)
          throw new QuickBooksWriteError({
            outcome: 'rejected',
            realmId: request.realmId,
            environment: request.environment,
            endpoint: 'invoice',
            requestId: request.requestId,
            payloadHash: request.payloadHash,
            status: 400,
            cause: new Error('invalid request'),
          });
        return {
          action: 'created',
          externalId: 'qbo-after-rejection',
          syncedAt: new Date('2026-10-14T12:00:00.000Z'),
        };
      });
      const input = {
        db,
        tenantId: 'tenant-rejected',
        invoiceId: seeded.invoice.id,
        mapping: mapping(seeded.lineId, seeded.componentId),
        provider: provider(push),
      };
      await expect(syncFrozenInvoiceToAccounting(input)).rejects.toMatchObject({
        code: 'QBO_WRITE_ERROR',
        outcome: 'rejected',
      });
      await expect(syncFrozenInvoiceToAccounting(input)).resolves.toMatchObject(
        { status: 'synced', externalId: 'qbo-after-rejection' },
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
    });
  });

  it.each([
    ['inclusive', { lineAmountType: 'inclusive' as const }],
    ['discount', { discount: 10 }],
    ['fractional-unit discount', { discount: 1, quantity: 3 }],
  ])('syncs public SDK %s snapshots with frozen request facts', async (_name, options) => {
    const seeded = await issuedInvoice(`tenant-${_name}`, options);
    await withTenant({ tenantId: `tenant-${_name}` }, async () => {
      const push = vi.fn(
        async (): Promise<SyncResult> => ({
          action: 'created',
          externalId: `qbo-${_name}`,
          syncedAt: new Date('2026-10-15T00:00:00.000Z'),
        }),
      );
      await expect(
        syncFrozenInvoiceToAccounting({
          db,
          tenantId: `tenant-${_name}`,
          invoiceId: seeded.invoice.id,
          mapping: mapping(seeded.lineId, seeded.componentId),
          provider: provider(push),
        }),
      ).resolves.toMatchObject({
        status: 'synced',
        externalId: `qbo-${_name}`,
      });
      expect(push).toHaveBeenCalledTimes(1);
      const sent = push.mock.calls[0]?.[0];
      expect(sent?.quickbooksRequest).toMatchObject({
        requestId: expect.stringMatching(/^smrt_[a-f0-9]{40}$/),
        realmId: 'realm-a',
        environment: 'sandbox',
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(sent?.quickbooksMapping?.globalTaxCalculation).toBe(
        _name === 'inclusive' ? 'TaxInclusive' : 'TaxExcluded',
      );
      if (_name === 'inclusive') {
        expect(sent?.lineItems[0]).toMatchObject({
          amount: 1.9,
          taxAmount: 0.1,
          taxInclusiveAmount: 2,
        });
      } else if (_name === 'fractional-unit discount') {
        expect(sent?.lineItems[0]).toMatchObject({
          quantity: 3,
          unitPrice: 1,
          discount: 0.01,
          amount: 2.99,
          taxAmount: 0.15,
        });
      } else {
        expect(sent?.lineItems[0]).toMatchObject({
          unitPrice: 1,
          discount: 0.1,
          amount: 1.9,
          taxAmount: 0.1,
        });
      }
      const stored = await (await InvoiceCollection.create({ db })).get(
        { id: seeded.invoice.id },
        { cache: false },
      );
      expect(stored && readFrozenAccountingSyncState(stored)).toMatchObject({
        status: 'synced',
        documentKind: 'invoice',
      });
    });
  });

  it('syncs a positive frozen credit memo with source linkage and fails unsupported providers before ownership', async () => {
    const tenantId = 'tenant-credit-memo';
    const source = await issuedInvoice(tenantId, { discount: 10 });
    await withTenant({ tenantId }, async () => {
      const sourcePush = vi.fn(
        async (): Promise<SyncResult> => ({
          action: 'created',
          externalId: 'qbo-source-invoice',
          syncedAt: new Date('2026-10-15T01:00:00.000Z'),
        }),
      );
      await syncFrozenInvoiceToAccounting({
        db,
        tenantId,
        invoiceId: source.invoice.id,
        mapping: mapping(source.lineId, source.componentId),
        provider: provider(sourcePush),
      });

      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const credit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: source.invoice.id,
        customerId: source.invoice.customerId,
        invoiceNumber: 'CN-SDK-1',
        currency: 'CAD',
      });
      const creditLine = await lines.create({
        invoiceId: credit.id,
        creditedLineId: source.lineId,
        description: 'Full service credit',
        quantity: 2,
        unitPrice: 0,
      });
      const issuedCredit = await invoices.get(
        { id: credit.id },
        { cache: false },
      );
      if (!issuedCredit) throw new Error('Expected credit note');
      issuedCredit.status = InvoiceStatus.SENT;
      await issuedCredit.save();
      const creditMapping = mapping(creditLine.id, source.componentId);

      const invoicePush = vi.fn(
        async (): Promise<SyncResult> => ({
          action: 'created',
          externalId: 'unexpected-invoice',
          syncedAt: new Date('2026-10-15T01:01:00.000Z'),
        }),
      );
      const wrongRealmCreditPush = vi.fn(
        async (): Promise<SyncResult> => ({
          action: 'created',
          externalId: 'unexpected-cross-realm-credit',
          syncedAt: new Date('2026-10-15T01:01:00.000Z'),
        }),
      );
      await expect(
        syncFrozenInvoiceToAccounting({
          db,
          tenantId,
          invoiceId: issuedCredit.id,
          mapping: { ...creditMapping, realmId: 'realm-b' },
          provider: provider(invoicePush, wrongRealmCreditPush),
        }),
      ).rejects.toMatchObject({
        code: 'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
      });
      expect(wrongRealmCreditPush).not.toHaveBeenCalled();
      await expect(
        syncFrozenInvoiceToAccounting({
          db,
          tenantId,
          invoiceId: issuedCredit.id,
          mapping: creditMapping,
          provider: provider(invoicePush),
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNTING_SYNC_UNSUPPORTED' });
      const unsupported = await invoices.get(
        { id: issuedCredit.id },
        { cache: false },
      );
      expect(unsupported?.accountingSyncStateJson).toBe('');
      expect(invoicePush).not.toHaveBeenCalled();

      const descriptors: string[] = [];
      const creditPush = vi.fn(
        async (memo: CreditMemoInput): Promise<SyncResult> => {
          descriptors.push(JSON.stringify(memo.quickbooksCreditMemoRequest));
          if (descriptors.length === 1)
            throw new Error('credit response lost after write');
          return {
            action: 'created',
            externalId: 'qbo-credit-memo',
            syncedAt: new Date('2026-10-15T01:02:00.000Z'),
          };
        },
      );
      const syncCredit = () =>
        syncFrozenInvoiceToAccounting({
          db,
          tenantId,
          invoiceId: issuedCredit.id,
          mapping: creditMapping,
          provider: provider(invoicePush, creditPush),
        });
      await expect(syncCredit()).rejects.toThrow(
        'credit response lost after write',
      );
      const unresolved = await invoices.get(
        { id: issuedCredit.id },
        { cache: false },
      );
      if (!unresolved) throw new Error('Expected unresolved credit note');
      const unresolvedState = readFrozenAccountingSyncState(unresolved);
      if (!unresolvedState) throw new Error('Expected unresolved credit state');
      await expect(
        reconcileFrozenInvoiceAccountingSync({
          db,
          tenantId,
          invoiceId: issuedCredit.id,
          mapping: creditMapping,
          requestId: unresolvedState.requestId,
          attemptId: unresolvedState.attemptId,
          outcome: { status: 'absent' },
        }),
      ).resolves.toMatchObject({ status: 'ready' });
      await expect(syncCredit()).resolves.toMatchObject({
        status: 'synced',
        externalId: 'qbo-credit-memo',
      });
      expect(invoicePush).not.toHaveBeenCalled();
      expect(creditPush).toHaveBeenCalledTimes(2);
      expect(descriptors[1]).toBe(descriptors[0]);
      const sent = creditPush.mock.calls[1]?.[0];
      expect(sent).toMatchObject({
        creditMemoNumber: 'CN-SDK-1',
        creditedInvoiceExternalId: 'qbo-source-invoice',
        subtotal: 1.9,
        taxAmount: 0.1,
        totalAmount: 2,
        lineItems: [
          {
            amount: 1.9,
            taxAmount: 0.1,
            discount: 0.1,
          },
        ],
        quickbooksCreditMemoRequest: {
          requestId: expect.stringMatching(/^smrt_[a-f0-9]{40}$/),
          realmId: 'realm-a',
          environment: 'sandbox',
          creditedInvoiceExternalId: 'qbo-source-invoice',
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      const stored = await invoices.get(
        { id: issuedCredit.id },
        { cache: false },
      );
      expect(stored && readFrozenAccountingSyncState(stored)).toMatchObject({
        status: 'synced',
        documentKind: 'creditMemo',
        request: {
          creditedInvoiceExternalId: 'qbo-source-invoice',
        },
      });
    });
  });
  async function pilot(
    tenantId = 'pilot-tenant',
    obligationId = 'obligation-a',
  ) {
    const invoiceId = await quickBooksPilotInvoiceId(tenantId, obligationId);
    const { invoice, lineId, componentId } = await issuedInvoice(tenantId, {
      invoiceId,
      discount: 10,
    });
    const scope = {
      tenantId,
      realmId: 'realm-a',
      environment: 'sandbox',
    } as const;
    const evidence: QuickBooksPilotInvoiceEvidence = {
      ...scope,
      externalId: 'qbo-pilot-invoice',
      customerExternalId: invoice.customerExternalId,
      currency: invoice.currency,
      subtotalMinor: invoice.subtotal,
      discountMinor: invoice.discountTotal,
      taxMinor: invoice.taxAmount,
      totalMinor: invoice.totalAmount,
      balanceMinor: invoice.totalAmount,
      dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
      voided: false,
      complete: true,
      transactions: [],
    };
    const fixture = {
      mode: 'fixture' as const,
      scope,
      pushInvoice: vi.fn(
        async (_input: InvoiceInput): Promise<SyncResult> => ({
          action: 'created',
          externalId: evidence.externalId,
          syncedAt: new Date('2026-10-14T12:00:00.000Z'),
        }),
      ),
      readInvoice: vi.fn(async (_id: string) => evidence),
      findInvoiceForRequest: vi.fn(
        async (request: NonNullable<InvoiceInput['quickbooksRequest']>) => ({
          requestId: request.requestId,
          payloadHash: request.payloadHash,
          invoice: evidence,
        }),
      ),
    };
    const args = {
      db,
      tenantId,
      invoiceId,
      fixture,
      mapping: mapping(lineId, componentId),
      acceptance: {
        obligationId,
        quoteVersionId: 'quote-v1',
        moneySnapshotId: invoice.moneySnapshotId,
      },
    };
    async function state() {
      const invoices = await InvoiceCollection.create({ db });
      const stored = await invoices.get({ id: invoiceId }, { cache: false });
      if (!stored) throw new Error('Expected pilot invoice');
      return readFrozenAccountingSyncState(stored);
    }
    return { args, fixture, evidence, state };
  }

  it('reserves one pilot create, blocks ambiguous replay and recovers the exact descriptor', async () => {
    const { args, fixture, evidence, state } = await pilot();
    await withTenant({ tenantId: args.tenantId }, async () => {
      fixture.pushInvoice.mockRejectedValueOnce(new Error('lost response'));
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).rejects.toThrow('lost response');
      const unresolved = await state();
      expect(unresolved?.status).toBe('unknown');
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).rejects.toThrow('unknown');
      await expect(
        runQuickBooksPilot({
          ...args,
          action: 'link',
          externalId: evidence.externalId,
        }),
      ).rejects.toThrow('no verified');
      fixture.findInvoiceForRequest.mockImplementationOnce(async (request) => ({
        requestId: request.requestId,
        payloadHash: 'different-payload',
        invoice: evidence,
      }));
      await expect(
        runQuickBooksPilot({ ...args, action: 'recover' }),
      ).rejects.toThrow('verified request identity');
      await expect(
        runQuickBooksPilot({ ...args, action: 'recover' }),
      ).resolves.toMatchObject({ state: 'unpaid' });
      expect(fixture.findInvoiceForRequest).toHaveBeenLastCalledWith(
        unresolved?.request,
      );
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).resolves.toMatchObject({ state: 'unpaid' });
      expect(fixture.pushInvoice).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a competing issue or manual link while the pilot create owns the invoice', async () => {
    const { args, fixture, evidence } = await pilot();
    await withTenant({ tenantId: args.tenantId }, async () => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const push = fixture.pushInvoice.getMockImplementation();
      if (!push) throw new Error('Expected fixture push');
      fixture.pushInvoice.mockImplementationOnce(async (input) => {
        started.resolve();
        await release.promise;
        return push(input);
      });
      const issuance = runQuickBooksPilot({ ...args, action: 'issue' });
      try {
        await Promise.race([started.promise, issuance]);
        await expect(
          runQuickBooksPilot({ ...args, action: 'issue' }),
        ).rejects.toThrow('owns this invoice');
        await expect(
          runQuickBooksPilot({
            ...args,
            action: 'link',
            externalId: evidence.externalId,
          }),
        ).rejects.toThrow('no verified');
        expect(fixture.readInvoice).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await issuance;
      }
      expect(fixture.pushInvoice).toHaveBeenCalledTimes(1);
    });
  });

  it('links manually only after exact readback and blocks a second create', async () => {
    const { args, fixture, evidence, state } = await pilot();
    const link = {
      ...args,
      action: 'link' as const,
      externalId: evidence.externalId,
    };
    await withTenant({ tenantId: args.tenantId }, async () => {
      for (const wrong of [
        { tenantId: 'another-tenant' },
        { realmId: 'another-realm' },
        { customerExternalId: 'another-customer' },
        { currency: 'USD' },
        { subtotalMinor: evidence.subtotalMinor + 1 },
        { totalMinor: evidence.totalMinor + 1 },
        { taxMinor: evidence.taxMinor + 1 },
        { discountMinor: evidence.discountMinor + 1 },
        { dueDate: '2099-01-01' },
      ]) {
        fixture.readInvoice.mockResolvedValueOnce({ ...evidence, ...wrong });
        await expect(runQuickBooksPilot(link)).rejects.toThrow(
          'frozen money differs',
        );
      }
      expect(await state()).toBeNull();
      await expect(runQuickBooksPilot(link)).resolves.toMatchObject({
        state: 'unpaid',
      });
      await expect(
        runQuickBooksPilot({
          ...args,
          action: 'issue',
          acceptance: { ...args.acceptance, quoteVersionId: 'quote-v2' },
        }),
      ).rejects.toThrow('existing reservation');
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).resolves.toMatchObject({ state: 'unpaid' });
      expect(fixture.pushInvoice).not.toHaveBeenCalled();
    });
  });

  it('refuses to bind one QuickBooks invoice to two local obligations', async () => {
    const first = await pilot();
    const second = await pilot(first.args.tenantId, 'obligation-b');
    await withTenant({ tenantId: first.args.tenantId }, async () => {
      await runQuickBooksPilot({
        ...first.args,
        action: 'link',
        externalId: first.evidence.externalId,
      });
      await expect(
        runQuickBooksPilot({
          ...second.args,
          action: 'link',
          externalId: second.evidence.externalId,
        }),
      ).rejects.toThrow('already bound to another local invoice');
      expect(await second.state()).toBeNull();
    });
  });

  it('fails closed on live and mismatched scope before touching the fixture', async () => {
    const { args, fixture } = await pilot();
    await withTenant({ tenantId: 'another-tenant' }, async () => {
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).rejects.toThrow('active principal tenant');
    });
    await withTenant({ tenantId: args.tenantId }, async () => {
      await expect(
        runQuickBooksPilot({
          ...args,
          action: 'issue',
          mapping: { ...args.mapping, environment: 'production' },
        }),
      ).rejects.toThrow('scoped sandbox fixture');
      await expect(
        runQuickBooksPilot({
          ...args,
          action: 'issue',
          mapping: { ...args.mapping, realmId: 'another-realm' },
        }),
      ).rejects.toThrow('scoped sandbox fixture');
      await expect(
        runQuickBooksPilot({
          ...args,
          action: 'issue',
          acceptance: { ...args.acceptance, moneySnapshotId: 'wrong-snapshot' },
        }),
      ).rejects.toThrow('frozen invoice');
    });
    expect(fixture.pushInvoice).not.toHaveBeenCalled();
    expect(fixture.readInvoice).not.toHaveBeenCalled();
  });

  it('polls current linked money, preserves combinations and refuses unsupported zero balances', async () => {
    const { args, fixture, evidence, state } = await pilot();
    await withTenant({ tenantId: args.tenantId }, async () => {
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).resolves.toMatchObject({ state: 'unpaid' });
      const poll = { ...args, action: 'poll' as const };
      const { totalMinor } = evidence;
      const payment = {
        id: 'p',
        kind: 'payment',
        amountMinor: totalMinor,
      } as const;
      fixture.readInvoice.mockResolvedValueOnce({
        ...evidence,
        balanceMinor: 0,
      });
      await expect(runQuickBooksPilot(poll)).rejects.toThrow(
        'disagrees with linked transaction',
      );
      expect((await state())?.pilotProjection?.state).toBe('unpaid');
      const partial = {
        ...evidence,
        balanceMinor: totalMinor - 5,
        transactions: [{ ...payment, amountMinor: 5 }],
      };
      fixture.readInvoice.mockResolvedValueOnce(partial);
      await expect(runQuickBooksPilot(poll)).resolves.toMatchObject({
        state: 'partial',
        paidMinor: 5,
      });
      fixture.readInvoice.mockResolvedValue({
        ...evidence,
        balanceMinor: 0,
        transactions: [payment],
      });
      for (let n = 0; n < 2; n++) {
        await expect(runQuickBooksPilot(poll)).resolves.toMatchObject({
          state: 'paid',
          paidMinor: totalMinor,
        });
      }
      fixture.readInvoice.mockResolvedValueOnce({
        ...evidence,
        balanceMinor: 0,
        transactions: [
          { ...payment, amountMinor: totalMinor - 5 },
          { id: 'c', kind: 'credit', amountMinor: 5 },
        ],
      });
      await expect(runQuickBooksPilot(poll)).resolves.toMatchObject({
        state: 'credited',
        creditedMinor: 5,
      });
      fixture.readInvoice.mockResolvedValueOnce({
        ...evidence,
        balanceMinor: 5,
        transactions: [payment, { id: 'r', kind: 'refund', amountMinor: 5 }],
      });
      await expect(runQuickBooksPilot(poll)).resolves.toMatchObject({
        state: 'refunded',
        refundedMinor: 5,
        paidMinor: totalMinor - 5,
      });
      fixture.readInvoice.mockResolvedValueOnce({
        ...evidence,
        balanceMinor: 0,
        voided: true,
      });
      await expect(runQuickBooksPilot(poll)).resolves.toMatchObject({
        state: 'voided',
      });
      expect((await state())?.pilotProjection?.state).toBe('voided');
      expect(fixture.pushInvoice).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps a create unresolved when post-create readback mismatches', async () => {
    const { args, fixture, evidence, state } = await pilot();
    await withTenant({ tenantId: args.tenantId }, async () => {
      fixture.readInvoice.mockResolvedValueOnce({
        ...evidence,
        taxMinor: evidence.taxMinor + 1,
      });
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).rejects.toThrow('frozen money differs');
      expect((await state())?.status).toBe('unknown');
      await expect(
        runQuickBooksPilot({ ...args, action: 'issue' }),
      ).rejects.toThrow('unknown');
      expect(fixture.pushInvoice).toHaveBeenCalledTimes(1);
    });
  });
});
