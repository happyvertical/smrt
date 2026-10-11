<script lang="ts">
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import AttachmentPanel from '../components/AttachmentPanel.svelte';
import { assetAttachmentMockAttachments } from '../playground.js';

let canUpload = $state(true);
let description = $state('Supporting document for review');
let message = $state('');
function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const data = new FormData(event.currentTarget, event.submitter);
  description = String(data.get('description') ?? '');
  message =
    'Simulated server rejection. Your description and request identity are retained; this preview does not upload files.';
}
</script>
<div class="preview">
  <Checkbox label="May upload attachments" bind:checked={canUpload} />
  <AttachmentPanel attachments={assetAttachmentMockAttachments}
    upload={{ action: '', canUpload, description, message, help: 'Preview accepts a local file but never sends it.', hiddenFields: [{ name: 'requestId', value: 'preview-request-retained' }], onsubmit: submit }} />
</div>
<style>.preview { display: grid; gap: var(--smrt-spacing-4); }</style>
