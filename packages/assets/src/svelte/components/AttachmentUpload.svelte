<script lang="ts">
import {
  FilePicker,
  Form,
  FormGroup,
  Input,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { attachmentMessages as M } from '../attachments/messages.js';
import type { AttachmentUploadProps } from '../attachments/types.js';
/** Native multipart upload preserving caller request identity and failure values. */
export interface Props extends AttachmentUploadProps {}
let {
  action,
  id,
  canUpload = true,
  fileField = 'file',
  descriptionField = 'description',
  description = '',
  accept,
  help,
  fileError,
  descriptionError,
  message,
  reselectFile = false,
  pending = false,
  retryStatus = 'idle',
  hiddenFields = [],
  intentField = 'intent',
  intent = 'upload',
  submitLabel,
  children,
  onsubmit,
}: Props = $props();
const { t } = useI18n();
const instanceId = $props.id();
const formId = $derived(id ?? `attachment-upload-${instanceId}`);
const busy = $derived(
  pending || retryStatus === 'submitting' || retryStatus === 'busy',
);
const fileHelp = $derived(
  [
    help ? `${formId}-help` : '',
    fileError ? `${formId}-file-error` : '',
    reselectFile ? `${formId}-reselect` : '',
  ]
    .filter(Boolean)
    .join(' ') || undefined,
);
</script>

{#if canUpload}
  <Form id={formId} {action} method="post" enctype="multipart/form-data" preventDefault={false} {onsubmit} aria-busy={busy}>
    <div class="upload-fields">
      {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
      {#if message}<p role="alert">{message}</p>{/if}
      {#if retryStatus === 'transport-error'}<p role="status">{t(M['assets.attachments.uncertain'])}</p>{/if}
      <FilePicker id={`${formId}-file`} name={fileField} {accept} required label={t(M['assets.attachments.choose'])} description={t(M['assets.attachments.browse'])} aria-describedby={fileHelp} aria-invalid={fileError ? 'true' : undefined} />
      {#if help}<p id={`${formId}-help`}>{help}</p>{/if}
      {#if fileError}<p id={`${formId}-file-error`} role="alert">{fileError}</p>{/if}
      {#if reselectFile}<p id={`${formId}-reselect`}>{t(M['assets.attachments.reselect'])}</p>{/if}
      <FormGroup label={t(M['assets.attachments.description'])} id={`${formId}-description`} error={descriptionError}>
        <Textarea name={descriptionField} value={description} />
      </FormGroup>
      {@render children?.()}
      <div><Button type="submit" name={intentField} value={intent} disabled={busy}>{submitLabel ?? t(M['assets.attachments.upload'])}</Button></div>
    </div>
  </Form>
{:else}
  <p>{t(M['assets.attachments.readonly'])}</p>
{/if}

<style>
  .upload-fields { display: grid; gap: var(--smrt-spacing-3); min-width: 0; overflow-wrap: anywhere; }
  p { margin: 0; }
</style>
