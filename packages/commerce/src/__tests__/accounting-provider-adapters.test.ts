/** Provider adapters for the accounting ports (#5154): fixtures only, no SDK calls. */
import { describe, expect, it, vi } from 'vitest';
import {
  customerDirectoryFromProvider,
  invoiceReaderFromProvider,
  paymentPortFromProvider,
} from '../accounting-provider-adapters.js';

const request = {
  requestId: 'smrt_pay_abc',
  payloadHash: 'hash',
  realmId: 'realm-a',
  environment: 'sandbox' as const,
  paymentId: 'p-1',
  customerExternalId: 'qb-cust',
  depositAccountRef: 'qb-clearing',
  currency: 'CAD',
  amountMinor: 21050,
  paidAt: new Date('2026-11-02T23:30:00Z'),
  transactionId: 'ch_1234567890abcdefghijklmnop',
  applications: [
    { invoiceId: 'i-1', invoiceExternalId: 'qb-inv-1', amountMinor: 20000 },
    { invoiceId: 'i-2', invoiceExternalId: 'qb-inv-2', amountMinor: 1050 },
  ],
};

describe('paymentPortFromProvider', () => {
  it('maps fields, converts minor to major units and forwards the request identity', async () => {
    const create = vi.fn(async () => ({ externalId: 'qb-pay-1' }));
    const port = paymentPortFromProvider({ payments: { create } });
    const result = await port.create(request);
    expect(result).toMatchObject({ externalId: 'qb-pay-1' });
    expect(result.syncedAt).toBeInstanceOf(Date);
    expect(create).toHaveBeenCalledWith(
      {
        customerRef: 'qb-cust',
        depositToAccountRef: 'qb-clearing',
        paidOn: '2026-11-02',
        currency: 'CAD',
        amount: 210.5,
        applications: [
          { invoiceRef: 'qb-inv-1', amount: 200 },
          { invoiceRef: 'qb-inv-2', amount: 10.5 },
        ],
        reference: 'ch_1234567890abcdefgh',
      },
      {
        requestId: 'smrt_pay_abc',
        realmId: 'realm-a',
        environment: 'sandbox',
        payloadHash: 'hash',
      },
    );
  });

  it('uses the currency exponent, refuses unknown currencies before any call, and passes write errors through', async () => {
    const create = vi.fn(async () => ({ externalId: 'x' }));
    const port = paymentPortFromProvider({ payments: { create } });
    await port.create({
      ...request,
      currency: 'JPY',
      amountMinor: 500,
      applications: [
        { invoiceId: 'i', invoiceExternalId: 'q', amountMinor: 500 },
      ],
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ amount: 500 });
    await expect(port.create({ ...request, currency: 'ZZZ' })).rejects.toThrow(
      /Unsupported currency/,
    );
    expect(create).toHaveBeenCalledTimes(1);

    const refused = Object.assign(new Error('refused'), {
      outcome: 'rejected',
    });
    const failing = paymentPortFromProvider({
      payments: { create: async () => Promise.reject(refused) },
    });
    await expect(failing.create(request)).rejects.toBe(refused);
    await expect(
      paymentPortFromProvider({ payments: {} }).create(request),
    ).rejects.toThrow(/does not support payment creation/);
  });
});

describe('invoiceReaderFromProvider', () => {
  it('adds the tenant scope to the SDK readback', async () => {
    const readback = vi.fn(async () => ({
      realmId: 'realm-a',
      environment: 'sandbox',
      externalId: 'qb-inv-1',
      totalMinor: 1,
    }));
    const reader = invoiceReaderFromProvider(
      { invoices: { readback } },
      'tenant-1',
    );
    expect(await reader.readInvoice('qb-inv-1')).toMatchObject({
      tenantId: 'tenant-1',
      externalId: 'qb-inv-1',
    });
    expect(readback).toHaveBeenCalledWith('qb-inv-1');
    await expect(
      invoiceReaderFromProvider({ invoices: {} }, 't').readInvoice('x'),
    ).rejects.toThrow(/does not support invoice readback/);
  });
});

describe('customerDirectoryFromProvider', () => {
  it('finds by display name and email and normalizes the candidates', async () => {
    const find = vi.fn(async () => [
      { externalId: '7', name: 'Acme Ltd', email: 'ap@acme.test' },
      { id: '8', name: 'Acme Ltd.' },
    ]);
    const dir = customerDirectoryFromProvider({
      customers: { find, findOrCreate: vi.fn() },
    });
    expect(await dir.find({ name: 'Acme Ltd', email: 'ap@acme.test' })).toEqual(
      [
        { externalId: '7', name: 'Acme Ltd', email: 'ap@acme.test' },
        { externalId: '8', name: 'Acme Ltd.' },
      ],
    );
    expect(find).toHaveBeenCalledWith({
      displayName: 'Acme Ltd',
      email: 'ap@acme.test',
    });
  });

  it('creates through find-or-create with the request id, and refuses to create over a match', async () => {
    const findOrCreate = vi.fn(async () => ({
      match: 'created' as const,
      candidates: [{ id: '99' }],
    }));
    const dir = customerDirectoryFromProvider({
      customers: { find: vi.fn(), findOrCreate },
    });
    expect(
      await dir.create({ name: 'Acme', requestId: 'smrt_cust_1' }),
    ).toEqual({ externalId: '99' });
    expect(findOrCreate).toHaveBeenCalledWith({
      id: 'smrt_cust_1',
      name: 'Acme',
    });
    const clash = customerDirectoryFromProvider({
      customers: {
        find: vi.fn(),
        findOrCreate: async () => ({
          match: 'existing' as const,
          candidates: [{ id: '5' }],
        }),
      },
    });
    await expect(
      clash.create({ name: 'Acme', requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NEEDS_CONFIRMATION' });
    await expect(
      customerDirectoryFromProvider({ customers: {} }).find({ name: 'x' }),
    ).rejects.toThrow(/does not support customer find/);
  });
});
