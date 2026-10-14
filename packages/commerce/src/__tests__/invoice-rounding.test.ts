import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allocateInvoiceTax } from '../invoice-rounding.js';
import { validateInvoiceRoundingPolicy } from '../invoice-rounding-policy.js';

const line = { quantity: 1, unitPrice: 10, discount: 0, taxRate: 0.05 };

describe('canonical invoice tax allocation', () => {
  it('conserves one invoice tax unit with stable-ID ties independent of order', () => {
    const input = [
      { ...line, id: 'b' },
      { ...line, id: 'a' },
    ];
    const result = allocateInvoiceTax(input);
    expect(result).toEqual({
      subtotalMinor: 20,
      taxMinor: 1,
      totalMinor: 21,
      lines: [
        { id: 'a', subtotalMinor: 10, taxMinor: 1, totalMinor: 11 },
        { id: 'b', subtotalMinor: 10, taxMinor: 0, totalMinor: 10 },
      ],
    });
    expect(allocateInvoiceTax([...input].reverse())).toEqual(result);
    expect(input[0]).toEqual({ ...line, id: 'b' });
  });

  it('retains discounted bases, separate rates and explicit exemption', () => {
    const result = allocateInvoiceTax([
      { ...line, id: 'a', unitPrice: 100, discount: 20 },
      { ...line, id: 'b', unitPrice: 100, taxRate: 0.1 },
      { ...line, id: 'c', unitPrice: 100, taxRate: 0 },
    ]);
    expect(result).toMatchObject({
      subtotalMinor: 280,
      taxMinor: 14,
      totalMinor: 294,
    });
    expect(result.lines.map((item) => item.taxMinor)).toEqual([4, 10, 0]);
  });

  it('returns zero for removal of the final draft line', () => {
    expect(allocateInvoiceTax([])).toEqual({
      lines: [],
      subtotalMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
    });
  });

  it('rejects ambiguous identity and unsafe aggregate amounts', () => {
    expect(() =>
      allocateInvoiceTax([
        { ...line, id: 'a' },
        { ...line, id: 'a' },
      ]),
    ).toThrow();
    expect(() => allocateInvoiceTax([{ ...line, id: '' }])).toThrow();
    expect(() =>
      allocateInvoiceTax([
        { ...line, id: 'a', unitPrice: Number.MAX_SAFE_INTEGER, taxRate: 0 },
        { ...line, id: 'b', taxRate: 0 },
      ]),
    ).toThrow();
  });
});

describe('explicit rounding policy and generated surfaces', () => {
  const policy = {
    tenantId: 'tenant-a',
    id: 'approved',
    version: '1',
    currency: 'CAD',
    scope: 'invoice',
    allocation: 'signed-largest-remainder',
    calculation: 'invoice-resolved-v1',
  };
  it('requires explicit recognized policy conventions and returns a detached snapshot', () => {
    const retained = validateInvoiceRoundingPolicy(policy);
    expect(retained).toEqual(policy);
    expect(retained).not.toBe(policy);
    for (const invalid of [
      null,
      {},
      { ...policy, scope: 'regional-default' },
      { ...policy, allocation: undefined },
      { ...policy, calculation: 'future-v2' },
      { ...policy, tenantId: '' },
      { ...policy, currency: 'cad' },
    ])
      expect(() => validateInvoiceRoundingPolicy(invalid)).toThrow();
  });
  it('keeps policy, frozen history and allocated money outside generated write allowlists', () => {
    const paths = [
      new URL('../../.smrt/manifest.json', import.meta.url),
      new URL('../../dist/manifest.json', import.meta.url),
    ];
    const manifest = JSON.parse(
      readFileSync(paths.find((path) => existsSync(path))!, 'utf8'),
    );
    for (const name of ['Invoice', 'InvoiceLineItem']) {
      const api =
        manifest.objects[`@happyvertical/smrt-commerce:${name}`].decoratorConfig
          .api;
      expect(api.writable).toBeDefined();
      for (const field of [
        'invoiceRoundingPolicyJson',
        'invoiceRoundingFrozenJson',
        'invoiceTaxAllocationJson',
        'amount',
        'totalAmount',
      ])
        expect(api.writable).not.toContain(field);
      expect(api.include).not.toContain('configureRoundingPolicy');
    }
  });
});
