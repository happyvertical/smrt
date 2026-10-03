import { render } from 'svelte/server';
import InvoiceEditor from '../../src/svelte/components/InvoiceEditor.svelte';
import type { InvoiceEditorProps } from '../../src/svelte/invoices/types.js';

export function page(props: Partial<InvoiceEditorProps> = {}): string {
  const { body } = render(InvoiceEditor, { props: {
    action: '/save', currency: 'CAD',
    allocations: [{ key: 'one', sourceId: 'expense-a', amount: '125.00' }],
    sources: [{ id: 'expense-a', label: 'Reviewed supplier expense', availableMinor: 25000 }],
    hiddenFields: [{ name: 'requestId', value: 'keep-request' }, { name: 'tenantId', value: 'keep-tenant' }],
    ...props,
  } });
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native invoice proof</title></head><body>${body}</body></html>`;
}
