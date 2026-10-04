<script lang="ts">
import AttachmentPanel from '../../assets/src/svelte/components/AttachmentPanel.svelte';
import QuoteEditor from '../src/svelte/components/QuoteEditor.svelte';
import PurchaseOrderEditor from '../src/svelte/components/PurchaseOrderEditor.svelte';
let { kind = 'quote', readonly = false, busy = false }: { kind?: 'quote' | 'purchase'; readonly?: boolean; busy?: boolean } = $props();
const quote = { counterpartyId: 'vendor', reference: 'Q1', date: '2026-10-03', validUntil: '', currency: 'CAD', total: '12.50', tax: '0', scope: 'Scope', inclusions: '', exclusions: '', reason: '', lines: [] };
const purchase = { instrument: 'purchase-order', tax: '0', scope: 'Scope', inclusions: '', exclusions: '', reason: 'Reason', allocations: [{ id: 'row', label: 'Allocation', amount: '12.50' }] };
</script>
{#snippet attachments()}
  <AttachmentPanel attachments={[]} upload={{ action: `/${kind}-upload`, hiddenFields: [{ name: 'uploadToken', value: 'upload-only' }], submitLabel: 'Upload attachment' }} />
{/snippet}
{#if kind === 'quote'}
  <QuoteEditor kind="vendor-quotation" values={quote} counterparties={[{ id: 'vendor', label: 'Vendor' }]} action="/quote-save" hiddenFields={[{ name: 'editorToken', value: 'editor-only' }]} {attachments} {readonly} {busy} />
{:else}
  <PurchaseOrderEditor source={{ id: 'source', label: 'Source', vendor: 'Vendor' }} currency="CAD" minorUnitDigits={2} values={purchase} instruments={[{ value: 'purchase-order', label: 'Purchase order' }]} action="/purchase-save" hiddenFields={[{ name: 'editorToken', value: 'editor-only' }]} {attachments} {readonly} {busy} />
{/if}
