<script lang="ts">
import InvoiceEditor from '../../src/svelte/components/InvoiceEditor.svelte';
import InvoiceAllocationFields from '../../src/svelte/components/InvoiceAllocationFields.svelte';
import type { InvoiceEditorProps, InvoiceAllocationDraft } from '../../src/svelte/invoices/types.js';
import { values } from './fixture.js';
let { initial = {}, allocations = [{ key: 'one', sourceId: 'expense-a', amount: '125.00' }] }: { initial?: Partial<InvoiceEditorProps>; allocations?: InvoiceAllocationDraft[] } = $props();
</script>
<div data-theme="material" data-color-scheme="light">
  <InvoiceEditor action="/save" {values}
    customers={[{ id: 'customer-a', label: 'Example customer' }]}
    hiddenFields={[{ name: 'requestId', value: 'keep-request' }, { name: 'tenantId', value: 'keep-tenant' }]}
    {...initial}>
    {#snippet children(current)}
    <InvoiceAllocationFields currency={current.currency} {allocations} sources={[{ id: 'expense-a', label: 'Reviewed supplier expense', availableMinor: 25000 }]} />
    {/snippet}
  </InvoiceEditor>
</div>
