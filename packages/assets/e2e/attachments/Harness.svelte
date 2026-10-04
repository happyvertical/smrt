<script lang="ts">
import AttachmentPanel from '../../src/svelte/components/AttachmentPanel.svelte';
</script>
<div data-theme="material" data-color-scheme="light">
  <AttachmentPanel attachments={[{ id: 'one', name: 'A long private supporting document name that must wrap across mobile screens.pdf', mimeType: 'application/pdf', version: 2, viewHref: '/authorized/view' }]}
    upload={{ action: '/upload', description: 'Retained description', fileField: 'receipt', hiddenFields: [{ name: 'requestId', value: 'keep-request' }, { name: 'tenantId', value: 'keep-tenant' }] }} />
</div>
