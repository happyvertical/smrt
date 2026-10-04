import type { InvoiceDraftValues } from '../../src/svelte/invoices/types.js';
export const values: InvoiceDraftValues = {
  customerId: 'customer-a', issuedOn: '2026-10-03', dueOn: '2026-11-03', currency: 'CAD', paymentTerms: 'Net 30', taxRate: '5',
  lines: [{ key: 'line-a', description: 'Consulting', sku: 'CONSULT', quantity: '1.5', unitPrice: '100.00', discountType: 'percent', discountValue: '10', taxMode: 'inherit', taxRate: '0' }],
};
export function retainedValues(data: URLSearchParams | FormData): InvoiceDraftValues {
  const field = (name: string) => String(data.get(name) ?? '');
  const row = (name: string,index: number) => String(data.getAll(name)[index] ?? '');
  return { customerId: field('customerId'), issuedOn: field('issuedOn'), dueOn: field('dueOn'), currency: field('currency'), paymentTerms: field('paymentTerms'), taxRate: field('invoiceTaxRate'), lines: data.getAll('lineKey').map((key,index) => ({ key: String(key), description: row('lineDescription',index), sku: row('lineSku',index), quantity: row('lineQuantity',index), unitPrice: row('lineUnitPrice',index), discountType: row('lineDiscountType',index), discountValue: row('lineDiscountValue',index), taxMode: row('lineTaxMode',index), taxRate: row('lineTaxRate',index) })) };
}
