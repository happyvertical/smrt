/**
 * The sample tenant's money on smrt-commerce's money model: tax codes (the
 * seeded ones, the cookbook default, the example pack) and documents settled
 * by the package's own calculator, in both pricing modes, with percent and
 * amount discounts, per-component tax and both rounding scopes.
 */
import { COMMON_TAX_CODE_EXAMPLE_PACK } from '@happyvertical/smrt-commerce';
import { describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { isMoneyField } from '../src/lib/data/fakes.ts';
import {
  defaultTaxCode,
  EXAMPLE_TAX_CODES,
  examplePackCodeFor,
  lineAmount,
  type MoneyContext,
  percentText,
  SEEDED_TAX_CODES,
  sampleTaxCodes,
  settleDocument,
  storedTaxRows,
  TAX_CODE_EXAMPLE_PACK,
} from '../src/lib/data/money.ts';
import { setSampleTaxRate } from '../src/lib/data/packs.ts';
import { createPlannerDataSource } from '../src/lib/data/planner-source.ts';
import { plumbingReason } from '../src/lib/recipes/plumbing.ts';

const code = (value: string) => {
  const found = sampleTaxCodes(0.12).find((c) => c.code === value);
  if (!found) throw new Error(value);
  return found;
};

const context = (patch: Partial<MoneyContext> = {}): MoneyContext => {
  const codes = sampleTaxCodes(0.12);
  return {
    lineAmountType: 'exclusive',
    roundingScope: 'line',
    currency: 'CAD',
    codes,
    // Chosen explicitly here, so its two components show.
    appDefaultCodeId: code('ca-gst-pst-bc').id,
    ...patch,
  };
};

describe('sample tax codes', () => {
  it("restates smrt-commerce's example pack exactly", () => {
    expect(TAX_CODE_EXAMPLE_PACK).toEqual(COMMON_TAX_CODE_EXAMPLE_PACK);
    expect(EXAMPLE_TAX_CODES.map((c) => c.code)).toEqual([
      'ca-gst',
      'ca-gst-pst-bc',
      'ca-hst-on',
      'uk-vat-standard',
      'au-gst',
      'nz-gst',
    ]);
    expect(code('ca-gst-pst-bc').components.map((c) => c.name)).toEqual([
      'Canada GST 5%',
      'BC PST 7%',
    ]);
  });

  it('seeds exempt, zero-rated and out-of-scope', () => {
    expect(SEEDED_TAX_CODES.map((c) => c.kind)).toEqual([
      'exempt',
      'zero-rated',
      'out-of-scope',
    ]);
    expect(SEEDED_TAX_CODES.every((c) => c.components.length === 0)).toBe(true);
  });

  it("maps the tax rate to the app default as smrt's cookbook activation does", () => {
    expect(defaultTaxCode(0).code).toBe('out-of-scope');
    const usd = defaultTaxCode(0.0825);
    expect(usd).toMatchObject({ code: 'default-8_25', name: 'Default 8.25%' });
    expect(usd.components).toMatchObject([
      { name: 'Cookbook 8.25%', percent: '8.25' },
    ]);
    // Never an example-pack code, whatever the currency: an exported
    // cookbook's 12% is one component, so the planner's is too.
    expect(defaultTaxCode(0.12).code).toBe('default-12');
    expect(defaultTaxCode(0.12).components).toHaveLength(1);
    // A line may choose the pack's code for the app's country.
    expect(examplePackCodeFor('CAD')?.code).toBe('ca-gst-pst-bc');
    expect(examplePackCodeFor('gbp')?.code).toBe('uk-vat-standard');
    expect(examplePackCodeFor('USD')).toBeUndefined();
    expect(percentText(0.0825)).toBe('8.25');
    // Ids are stable: a saved line's override keeps pointing at its code.
    expect(defaultTaxCode(0.0825).id).toBe(defaultTaxCode(0.0825).id);
  });
});

describe('settling a document', () => {
  it('prices exclusive lines: amount is the net, tax is added per component', () => {
    const settled = settleDocument(
      [
        {
          id: 'a',
          quantity: 2,
          unitPrice: 1000,
          discountType: 'percent',
          discountRate: '10',
        },
        {
          id: 'b',
          quantity: 1,
          unitPrice: 500,
          discountType: 'amount',
          discount: 100,
        },
      ],
      context(),
    );
    expect(
      settled.lines.map((l) => [l.amount, l.discount, l.taxAmount]),
    ).toEqual([
      [1800, 200, 216],
      [400, 100, 48],
    ]);
    expect(settled).toMatchObject({
      subtotal: 2200,
      discountTotal: 300,
      taxAmount: 264,
      totalAmount: 2464,
    });
    expect(settled.lines[0]).toMatchObject({
      taxCodeCode: 'ca-gst-pst-bc',
      taxCodeName: 'BC GST + PST',
      taxRate: 0.12,
    });
    expect(JSON.parse(settled.lines[0]?.taxComponentsJson ?? '[]')).toEqual([
      expect.objectContaining({ name: 'Canada GST 5%', taxMinor: 90 }),
      expect.objectContaining({ name: 'BC PST 7%', taxMinor: 126 }),
    ]);
    expect(settled.taxes.map((t) => [t.name, t.taxable, t.tax]).sort()).toEqual(
      [
        ['BC PST 7%', 2200, 154],
        ['Canada GST 5%', 2200, 110],
      ],
    );
  });

  it('prices inclusive lines: amount is the gross and tax is backed out', () => {
    const settled = settleDocument(
      [{ id: 'a', quantity: 1, unitPrice: 1120 }],
      context({ lineAmountType: 'inclusive' }),
    );
    expect(settled.lines[0]).toMatchObject({ amount: 1120, taxAmount: 120 });
    expect(settled).toMatchObject({
      subtotal: 1000,
      taxAmount: 120,
      totalAmount: 1120,
    });
    // The stored line snapshots sum to the calculator's per-component rows.
    const byComponent = (rows: { taxComponentId: string | null }[]) =>
      [...rows].sort((a, b) =>
        String(a.taxComponentId).localeCompare(String(b.taxComponentId)),
      );
    expect(byComponent(storedTaxRows(settled.lines, 'inclusive'))).toEqual(
      byComponent(settled.taxes),
    );
  });

  it('rounds per line or once per document', () => {
    const lines = ['a', 'b', 'c'].map((id) => ({
      id,
      quantity: 1,
      unitPrice: 10,
    }));
    const usd = (scope: 'line' | 'document') =>
      settleDocument(lines, {
        ...context({ roundingScope: scope }),
        currency: 'USD',
        codes: sampleTaxCodes(0.0825),
        appDefaultCodeId: defaultTaxCode(0.0825).id,
      });
    // 8.25% of 10 is 0.825 a line: 1 each per line, 2 for the whole document.
    expect(usd('line').taxAmount).toBe(3);
    expect(usd('document').taxAmount).toBe(2);
  });

  it('resolves a line override, then an exempt customer, then the app default', () => {
    const lines = [
      { id: 'a', quantity: 1, unitPrice: 1000 },
      {
        id: 'b',
        quantity: 1,
        unitPrice: 1000,
        taxMode: 'override',
        taxCodeId: code('zero-rated').id,
      },
      { id: 'c', quantity: 1, unitPrice: 1000, productId: 'p1' },
    ];
    const plain = settleDocument(lines, {
      ...context(),
      productCodeOf: (id) => (id === 'p1' ? code('ca-gst').id : null),
    });
    expect(plain.lines.map((l) => l.taxCodeCode)).toEqual([
      'ca-gst-pst-bc',
      'zero-rated',
      'ca-gst',
    ]);
    expect(plain.lines.map((l) => l.taxAmount)).toEqual([120, 0, 50]);
    const exempt = settleDocument(lines, context({ customerTaxExempt: true }));
    expect(exempt.lines.map((l) => l.taxCodeCode)).toEqual([
      'exempt',
      'zero-rated',
      'exempt',
    ]);
    expect(exempt.taxAmount).toBe(0);
  });

  it('refuses a discount above the line price', () => {
    expect(() =>
      settleDocument(
        [
          {
            id: 'a',
            quantity: 1,
            unitPrice: 100,
            discountType: 'amount',
            discount: 500,
          },
        ],
        context(),
      ),
    ).toThrow();
  });

  it('previews a line amount before its tax is known', () => {
    expect(lineAmount({ quantity: 1.5, unitPrice: 999 })).toBe(1499);
  });
});

describe('the money model in the catalog', () => {
  const C = '@happyvertical/smrt-commerce:';
  const find = (name: string) => {
    const found = getModelByQualifiedName(`${C}${name}`)?.model;
    if (!found) throw new Error(name);
    return found;
  };
  const field = (model: string, name: string) => {
    const found = find(model).fields.find((f) => f.name === name);
    if (!found) throw new Error(`${model}.${name}`);
    return found;
  };

  it('hides the money internals', () => {
    for (const [model, name] of [
      ['InvoiceLineItem', 'taxComponentsJson'],
      ['InvoiceLineItem', 'moneySnapshotId'],
      ['InvoiceLineItem', 'creditCalculationBasisJson'],
      ['Invoice', 'sellerTaxRegistrationsJson'],
      ['Invoice', 'accountingSyncStateJson'],
      ['TaxCode', 'componentsJson'],
    ] as const) {
      expect(field(model, name).system, `${model}.${name}`).toBe(true);
    }
    // What a person reads or sets stays visible.
    for (const [model, name] of [
      ['InvoiceLineItem', 'taxAmount'],
      ['InvoiceLineItem', 'discountType'],
      ['Invoice', 'lineAmountType'],
      ['Invoice', 'discountTotal'],
    ] as const) {
      expect(field(model, name).system, `${model}.${name}`).toBeUndefined();
    }
  });

  it('keeps tax codes a feature and the rest of the tax models plumbing', () => {
    expect(plumbingReason(find('TaxCode'))).toBeNull();
    expect(plumbingReason(find('TaxComponent'))).toBe('lookup');
    expect(plumbingReason(find('TaxSettings'))).toBe('settings');
    expect(plumbingReason(find('DocumentTax'))).toBe('snapshot');
    expect(plumbingReason(find('TaxSummaryReport'))).toBe('report');
  });

  it('shows the new amounts as money', () => {
    for (const [model, name] of [
      ['InvoiceLineItem', 'taxAmount'],
      ['ContractLineItem', 'taxAmount'],
      ['Invoice', 'discountTotal'],
      ['Order', 'discountTotal'],
      ['Invoice', 'creditedAmount'],
      ['DocumentTax', 'taxableMinor'],
      ['DocumentTax', 'taxMinor'],
      ['DocumentTax', 'recoverableMinor'],
      ['TaxSummaryReport', 'ledgerMovementMinor'],
    ] as const) {
      expect(isMoneyField(field(model, name)), `${model}.${name}`).toBe(true);
    }
    expect(isMoneyField(field('TaxSummaryReport', 'documentCount'))).toBe(
      false,
    );
  });
});

describe("the planner tenant's tax table", () => {
  it('keeps a deleted seeded code deleted', async () => {
    const source = createPlannerDataSource();
    const C = '@happyvertical/smrt-commerce:';
    const find = (name: string) => {
      const found = getModelByQualifiedName(`${C}${name}`)?.model;
      if (!found) throw new Error(name);
      return found;
    };
    const zero = SEEDED_TAX_CODES.find((c) => c.kind === 'zero-rated');
    if (!zero) throw new Error('zero-rated');
    const rows = await source.list(find('TaxCode'));
    expect(rows.map((r) => r.code)).toContain('zero-rated');
    const order = await source.create(find('Agreement'), { status: 'draft' });
    const line = {
      contractId: order.id,
      quantity: 1,
      unitPrice: 1000,
      taxMode: 'override',
      taxCodeId: zero.id,
    };
    expect(
      (await source.create(find('ContractLineItem'), line)).taxCodeCode,
    ).toBe('zero-rated');
    await source.delete(find('TaxCode'), zero.id);
    await expect(
      source.create(find('ContractLineItem'), line),
    ).rejects.toThrow();
  });

  it('still has the default code after the rate changes over a seeded table', async () => {
    const source = createPlannerDataSource();
    const C = '@happyvertical/smrt-commerce:';
    const find = (name: string) => {
      const found = getModelByQualifiedName(`${C}${name}`)?.model;
      if (!found) throw new Error(name);
      return found;
    };
    await source.list(find('ContractLineItem'));
    setSampleTaxRate(0.08);
    try {
      const order = await source.create(find('Agreement'), { status: 'draft' });
      const line = await source.create(find('ContractLineItem'), {
        contractId: order.id,
        quantity: 1,
        unitPrice: 1000,
      });
      expect(line).toMatchObject({ taxCodeCode: 'default-8', taxAmount: 80 });
      // A line table first built after the change generates too.
      expect(
        (await source.list(find('InvoiceLineItem'))).length,
      ).toBeGreaterThan(0);
    } finally {
      setSampleTaxRate(undefined);
    }
  });

  it('refuses to move a line out of an issued document', async () => {
    const source = createPlannerDataSource();
    const C = '@happyvertical/smrt-commerce:';
    const find = (name: string) => {
      const found = getModelByQualifiedName(`${C}${name}`)?.model;
      if (!found) throw new Error(name);
      return found;
    };
    const draft = await source.create(find('Agreement'), { status: 'draft' });
    const line = await source.create(find('ContractLineItem'), {
      contractId: draft.id,
      quantity: 1,
      unitPrice: 1000,
    });
    await source.update(find('Agreement'), draft.id, { status: 'sent' });
    const other = await source.create(find('Agreement'), { status: 'draft' });
    await expect(
      source.update(find('ContractLineItem'), line.id, {
        contractId: other.id,
      }),
    ).rejects.toThrow(/issued/);
    expect(
      (await source.get(find('ContractLineItem'), line.id))?.contractId,
    ).toBe(draft.id);
  });
});
