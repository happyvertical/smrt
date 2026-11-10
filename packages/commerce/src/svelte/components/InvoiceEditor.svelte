<script lang="ts">
import type { InvoiceEditorProps } from '../invoices/types.js';
import MoneyInvoiceEditor from './MoneyInvoiceEditor.svelte';
/**
 * Native invoice editor. The v2 money model is the only invoice model: tax comes
 * from tax codes, and the server recomputes and owns every stored amount.
 */
export interface Props extends InvoiceEditorProps {}
let props: Props = $props();
</script>
<MoneyInvoiceEditor {...props} />
