<script lang="ts">
import InvoiceEditor from '../../src/svelte/components/InvoiceEditor.svelte';
import type { InvoiceEditorProps } from '../../src/svelte/invoices/types.js';
let { initial = {} }: { initial?: Partial<InvoiceEditorProps> } = $props();
</script>
<div data-theme="material" data-color-scheme="light">
  <InvoiceEditor action="/save" currency="CAD"
    allocations={[{ key: 'one', sourceId: 'expense-a', amount: '125.00' }]}
    sources={[{ id: 'expense-a', label: 'Reviewed supplier expense', availableMinor: 25000 }]}
    hiddenFields={[{ name: 'requestId', value: 'keep-request' }, { name: 'tenantId', value: 'keep-tenant' }]}
    {...initial} />
</div>
