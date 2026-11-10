import { randomUUID } from 'node:crypto';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../../collections/TaxSettingsCollection.js';
import { ensureTenantTaxCodes } from '../../tax/standard-codes.js';
import { aggregateTaxSummary } from '../../tax-summary.js';
import { ContractStatus, InvoiceStatus } from '../../types/index.js';

function id(value: string | null | undefined): string {
  if (!value) throw new Error('Missing fixture ID');
  return value;
}

export async function proveCompoundMoney(db: DatabaseInterface) {
  const tenantId = randomUUID();
  await ensureTenantTaxCodes(db, tenantId);
  await withTenant({ tenantId }, async () => {
    const components = await TaxComponentCollection.create({ db });
    const a = await components.create({ name: 'A', percent: '5' });
    const b = await components.create({ name: 'B compound', percent: '7' });
    const codes = await TaxCodeCollection.create({ db });
    const code = await codes.create({
      code: 'ordered',
      name: 'Ordered',
      components: [
        { taxComponentId: id(a.id), compound: false },
        { taxComponentId: id(b.id), compound: true },
      ],
    });
    const settings = await TaxSettingsCollection.create({ db });
    const policy = await settings.getOrCreateForTenant(tenantId);
    policy.defaultSalesTaxCodeId = id(code.id);
    policy.taxRoundingScope = 'document';
    await policy.save();
    const customer = await (await CustomerCollection.create({ db })).create({
      defaultTaxCodeId: id(code.id),
    });
    const invoices = await InvoiceCollection.create({ db });
    const lines = await InvoiceLineItemCollection.create({ db });
    const taxes = await DocumentTaxCollection.create({ db });
    for (const fixture of [
      {
        mode: 'exclusive',
        unit: 10000,
        total: 33705,
        net: 30000,
        basis: 31500,
        tax: 2205,
      },
      {
        mode: 'inclusive',
        unit: 11235,
        total: 33705,
        net: 30000,
        basis: 31500,
        tax: 2205,
      },
      {
        mode: 'exclusive',
        unit: 101,
        total: 340,
        net: 303,
        basis: 318,
        tax: 22,
      },
      {
        mode: 'inclusive',
        unit: 113,
        total: 339,
        net: 302,
        basis: 317,
        tax: 22,
      },
    ] as const) {
      const mode = fixture.mode;
      policy.defaultLineAmountType = mode;
      await policy.save();
      const source = await invoices.create({
        customerId: id(customer.id),
        invoiceNumber: `compound-${mode}-${fixture.unit}`,
        currency: 'CAD',
        lineAmountType: mode,
      });
      const sourceLine = await lines.create({
        invoiceId: id(source.id),
        description: 'Compound source',
        quantity: 3,
        unitPrice: fixture.unit,
        taxMode: 'override',
        taxCodeId: id(code.id),
      });
      const issued = await invoices.get(
        { id: id(source.id) },
        { cache: false },
      );
      if (!issued?.id || !sourceLine.id) throw new Error('Missing source');
      issued.status = InvoiceStatus.SENT;
      await issued.save();
      expect(issued.totalAmount).toBe(fixture.total);
      const frozen = await lines.get({ id: sourceLine.id }, { cache: false });
      expect(frozen?.taxComponents[1]).toMatchObject({
        compound: true,
        taxableMinor: fixture.basis,
        taxMinor: fixture.tax,
      });
      const original = await taxes.findByDocument(
        tenantId,
        'invoice',
        issued.id,
      );
      expect(original.find((p) => p.taxComponentId === id(b.id))).toMatchObject(
        {
          taxableMinor: fixture.basis,
          netMinor: fixture.net,
          taxMinor: fixture.tax,
        },
      );
      const changed = await components.create({ name: 'New B', percent: '70' });
      code.components = [
        { taxComponentId: id(a.id), compound: false },
        { taxComponentId: id(changed.id), compound: true },
      ];
      await code.save();
      const allCredits = [];
      for (const quantity of [1, 2]) {
        const credit = await invoices.create({
          kind: 'credit_note',
          creditedInvoiceId: issued.id,
          customerId: id(customer.id),
          invoiceNumber: `credit-${mode}-${fixture.unit}-${quantity}`,
          currency: 'CAD',
        });
        await lines.create({
          invoiceId: id(credit.id),
          creditedLineId: sourceLine.id,
          description: 'Return',
          quantity,
          unitPrice: 0,
        });
        const issuedCredit = await invoices.get(
          { id: id(credit.id) },
          { cache: false },
        );
        if (!issuedCredit) throw new Error('Missing credit');
        issuedCredit.status = InvoiceStatus.SENT;
        await issuedCredit.save();
        allCredits.push(
          ...(await taxes.findByDocument(
            tenantId,
            'credit_note',
            id(issuedCredit.id),
          )),
        );
      }
      code.components = [
        { taxComponentId: id(a.id), compound: false },
        { taxComponentId: id(b.id), compound: true },
      ];
      await code.save();
      for (const originalRow of original) {
        const matching = allCredits.filter(
          (p) => p.taxComponentId === originalRow.taxComponentId,
        );
        expect(matching.reduce((sum, p) => sum + p.taxMinor, 0)).toBe(
          originalRow.taxMinor,
        );
        expect(matching.reduce((sum, p) => sum + p.taxableMinor, 0)).toBe(
          originalRow.taxableMinor,
        );
      }
    }
    policy.defaultLineAmountType = 'exclusive';
    await policy.save();
    const contracts = await ContractCollection.create({ db });
    const contract = await contracts.create({ currency: 'CAD' });
    const contractLines = await ContractLineItemCollection.create({ db });
    const contractLine = await contractLines.create({
      contractId: id(contract.id),
      description: 'Compound contract',
      quantity: 1,
      unitPrice: 10000,
      taxMode: 'override',
      taxCodeId: id(code.id),
    });
    expect(contractLine.taxComponents[1]).toMatchObject({
      compound: true,
      taxableMinor: 10500,
      taxMinor: 735,
    });
    const frozenContract = await contracts.get(
      { id: id(contract.id) },
      { cache: false },
    );
    if (!frozenContract) throw new Error('Missing contract');
    frozenContract.status = ContractStatus.SENT;
    await frozenContract.save();
    expect(
      (await taxes.findByDocument(tenantId, 'contract', id(contract.id))).find(
        (p) => p.taxComponentId === id(b.id),
      ),
    ).toMatchObject({ taxableMinor: 10500, netMinor: 10000 });
    const facts = await taxes.listReportFacts({
      tenantId,
      from: new Date('2000-01-01'),
      to: new Date('2100-01-01'),
    });
    expect(
      facts.some((p) => p.netMinor === 30000 && p.taxableMinor === 31500),
    ).toBe(true);
    const report = aggregateTaxSummary({
      tenantId,
      from: '2000-01-01',
      to: '2100-01-01',
      facts,
      expenses: [],
      expenseComponentMappings: [],
      ledgerMovements: [],
    });
    const invoicesOnly = aggregateTaxSummary({
      tenantId,
      from: '2000-01-01',
      to: '2100-01-01',
      facts: facts.filter((p) => p.documentType === 'invoice'),
      expenses: [],
      expenseComponentMappings: [],
      ledgerMovements: [],
    });
    expect(invoicesOnly.kindRows[0].taxableMinor).toBe(60605);
    expect(
      invoicesOnly.componentRows.find((p) => p.taxComponentId === id(b.id))
        ?.taxableMinor,
    ).toBe(63635);
    expect(report.kindRows.every((row) => row.taxableMinor === 0)).toBe(true);
    expect(report.componentRows.every((row) => row.taxableMinor === 0)).toBe(
      true,
    );
  });
}
