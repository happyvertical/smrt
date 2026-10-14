import type { InvoiceDraftValues } from '../../src/svelte/invoices/types.js';
import type {
  MoneyEditorProps,
  MoneyEditorTaxCode,
} from '../../src/svelte/invoices/money-editor.js';
import { calculateMoneyEditorDraft } from '../../src/svelte/invoices/money-editor.js';
export const values: InvoiceDraftValues = {
  customerId: 'customer-a', issuedOn: '2026-10-03', dueOn: '2026-11-03', currency: 'CAD', paymentTerms: 'Net 30', taxRate: '5',
  lines: [{ key: 'line-a', description: 'Consulting', sku: 'CONSULT', quantity: '1.5', unitPrice: '100.00', discountType: 'percent', discountValue: '10', taxMode: 'inherit', taxRate: '0' }],
};
export function retainedValues(data: URLSearchParams | FormData): InvoiceDraftValues {
  const field = (name: string) => String(data.get(name) ?? '');
  const row = (name: string,index: number) => String(data.getAll(name)[index] ?? '');
  return { customerId: field('customerId'), issuedOn: field('issuedOn'), dueOn: field('dueOn'), currency: field('currency'), paymentTerms: field('paymentTerms'), taxRate: field('invoiceTaxRate'), lines: data.getAll('lineKey').map((key,index) => ({ key: String(key), description: row('lineDescription',index), sku: row('lineSku',index), quantity: row('lineQuantity',index), unitPrice: row('lineUnitPrice',index), discountType: row('lineDiscountType',index), discountValue: row('lineDiscountValue',index), taxMode: row('lineTaxMode',index), taxRate: row('lineTaxRate',index) })) };
}

export const invoiceRoundingValues: InvoiceDraftValues = {
  ...values,
  lines: ['small-a', 'small-b'].map(key => ({ ...values.lines[0], key, quantity: '1', unitPrice: '0.10', discountType: 'flat', discountValue: '0' })),
};

const taxCodes: MoneyEditorTaxCode[] = [
  { id: 'gst', code: 'GST', name: 'GST', componentNames: { gst: 'GST' }, kind: 'taxable', components: [{ taxComponentId: 'gst', percent: '5', compound: false }] },
  { id: 'gst-pst', code: 'GST+PST', name: 'GST+PST', componentNames: { gst: 'GST', pst: 'PST' }, kind: 'taxable', components: [{ taxComponentId: 'gst', percent: '5', compound: false }, { taxComponentId: 'pst', percent: '7', compound: false }] },
  { id: 'none', code: 'OUT', name: 'Out of scope', kind: 'out-of-scope', components: [] },
];
type MoneyCase = 'A' | 'B' | 'C' | 'D' | 'E';
export function moneyFixture(kind: MoneyCase = 'A', roundingScope: 'line' | 'document' = 'line', frozen = false): MoneyEditorProps {
  const amountType = kind === 'B' || kind === 'D' ? 'inclusive' : kind === 'C' ? 'none' : 'exclusive';
  const lines = kind === 'E'
    ? ['a', 'b'].map((id) => ({ id, description: `Rounding ${id}`, quantity: '1', unitPrice: '0.10', discountType: 'none' as const, discountValue: '0', taxMode: 'inherit' as const, inheritedTaxCodeId: 'gst', inheritedTaxCodeSource: 'app' as const }))
    : [{ id: 'first', description: 'GST and PST service', quantity: '1', unitPrice: kind === 'B' || kind === 'D' ? '112.00' : '100.00', discountType: kind === 'A' ? 'amount' as const : 'none' as const, discountValue: kind === 'A' ? '10.00' : '0', taxMode: 'inherit' as const, inheritedTaxCodeId: kind === 'C' ? 'none' : kind === 'D' ? null : 'gst-pst', inheritedTaxCodeSource: kind === 'D' ? 'exempt-customer' as const : 'app' as const }];
  const fixture: MoneyEditorProps = {
    mode: 'v2',
    draft: { currency: 'CAD', lineAmountType: amountType, roundingScope, lines },
    taxCodes,
    customerTaxExempt: kind === 'D',
    sellerTaxRegistrations: ['GST/HST No. 123456789 RT0001'],
    partyTaxId: 'CA-Party-1',
    showNetSubtotal: true,
  };
  if (!frozen) return fixture;
  const calculation = calculateMoneyEditorDraft(fixture.draft, fixture.taxCodes);
  if (!calculation.valid) throw new Error(calculation.message);
  return {
    ...fixture,
    frozen: true,
    status: 'SENT',
    stored: {
      lineAmountType: fixture.draft.lineAmountType,
      roundingScope,
      subtotalMinor: calculation.result.subtotalMinor,
      discountTotalMinor: calculation.result.discountTotalMinor,
      taxMinor: calculation.result.taxMinor,
      totalMinor: calculation.result.totalMinor,
      taxes: calculation.result.taxes.map((tax) => {
        const code = fixture.taxCodes.find((candidate) => candidate.id === tax.taxCodeId);
        const component = code?.components.find((candidate) => candidate.taxComponentId === tax.taxComponentId);
        return { id: `${tax.taxCodeId}:${tax.taxComponentId ?? ''}`, taxComponentId: tax.taxComponentId, name: code?.componentNames?.[tax.taxComponentId ?? ''] ?? code?.name ?? 'Tax', percent: component?.percent ?? '0', taxableMinor: tax.taxableMinor, taxMinor: tax.taxMinor };
      }),
    },
  };
}

export function retainedMoney(data: URLSearchParams, kind: MoneyCase, roundingScope: 'line' | 'document'): MoneyEditorProps {
  const base = moneyFixture(kind, roundingScope);
  const row = (name: string, index: number) => String(data.getAll(name)[index] ?? '');
  return {
    ...base,
    draft: {
      ...base.draft,
      lineAmountType: (data.get('lineAmountType') as typeof base.draft.lineAmountType) || base.draft.lineAmountType,
      lines: data.getAll('lineId').map((id, index) => ({
        ...base.draft.lines[index], id: String(id), description: row('lineDescription', index), quantity: row('lineQuantity', index), unitPrice: row('lineUnitPrice', index), discountType: row('lineDiscountType', index) as 'none' | 'percent' | 'amount', discountValue: row('lineDiscountValue', index), taxMode: row('lineTaxMode', index) as 'inherit' | 'override', taxCodeId: row('lineTaxCodeId', index) || null,
      })),
    },
  };
}
