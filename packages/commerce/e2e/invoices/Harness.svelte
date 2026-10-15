<script lang="ts">
import InvoiceEditor from '../../src/svelte/components/InvoiceEditor.svelte';
import { Form } from '@happyvertical/smrt-ui/forms';
import type { InvoiceEditorProps } from '../../src/svelte/invoices/types.js';
let { initial, colorScheme = 'light' }: { initial: InvoiceEditorProps; colorScheme?: 'light' | 'dark' } = $props();
</script>
<div data-theme="material" data-color-scheme={colorScheme}>
  <InvoiceEditor
    hiddenFields={[{ name: 'requestId', value: 'keep-request' }, { name: 'tenantId', value: 'keep-tenant' }]}
    {...initial} />
  <Form data-testid="unrelated-form" preventDefault={false} stagedReview={false}>
    <span>Unrelated native form</span>
  </Form>
</div>
