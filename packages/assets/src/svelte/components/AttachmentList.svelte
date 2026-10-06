<script lang="ts">
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { attachmentLink } from '../attachments/link.js';
import { attachmentMessages as M } from '../attachments/messages.js';
import type {
  AssetAttachment,
  AssetAttachmentVersion,
  AttachmentListProps,
} from '../attachments/types.js';
/** Authorized attachment metadata, navigation and caller-ordered history. */
export interface Props extends AttachmentListProps {}
let {
  attachments,
  title,
  showHistory = true,
  message,
  loading = false,
  onremove,
  removeAction,
  removeIdField = 'attachmentId',
  removeIntentField = 'intent',
  removeIntent = 'remove',
  removeHiddenFields = [],
  removePending = false,
  density,
}: Props = $props();
const { t } = useI18n();
const instanceId = $props.id();
const removable = $derived(Boolean(onremove || removeAction));
let target = $state<AssetAttachment | undefined>();
let running = $state(false);
let failed = $state<string | undefined>();
const formId = $derived(`${instanceId}-remove`);
const busy = $derived(running || removePending);
function askRemove(item: AssetAttachment) {
  failed = undefined;
  target = item;
}
async function confirmRemove() {
  const item = target;
  if (!item || busy) return;
  if (onremove) {
    running = true;
    try {
      await onremove(item);
    } catch {
      failed = item.name;
    } finally {
      running = false;
      target = undefined;
    }
  } else if (removeAction) {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    // Native POST: stay pending until navigation; a restored (bfcache)
    // page or a submission cancelled by an enhancing listener releases the controls again.
    running = true;
    let submitted: Event | undefined;
    window.addEventListener(
      'submit',
      (event) => {
        submitted = event;
      },
      { capture: true, once: true },
    );
    form.requestSubmit();
    // Dispatch is synchronous: a listener that cancelled it (even with
    // stopPropagation; the capture listener sees it first) leaves no navigation coming, so release the controls.
    if (submitted?.defaultPrevented) {
      running = false;
      target = undefined;
    }
  }
}
</script>

<svelte:window onpageshow={(event) => { if (event.persisted) { running = false; target = undefined; } }} />

{#snippet entry(item: AssetAttachmentVersion)}
  <strong>{item.name}</strong>
  <div class="metadata">
    <span>{item.mimeType}</span>
    {#if item.version !== undefined}<span>{t(M['assets.attachments.version'], { version: item.version })}</span>{/if}
    {#if item.recordedAtLabel}<span>{item.recordedAtLabel}</span>{/if}
  </div>
  {#if item.note}<p>{item.note}</p>{/if}
  <div class="links">
    {#if attachmentLink(item.viewHref)}<Button href={attachmentLink(item.viewHref)} target="_blank" rel="noopener noreferrer" variant="ghost">{t(M['assets.attachments.view'], { name: item.name })}</Button>{/if}
    {#if attachmentLink(item.downloadHref)}<Button href={attachmentLink(item.downloadHref)} variant="ghost">{t(M['assets.attachments.download'], { name: item.name })}</Button>{/if}
  </div>
{/snippet}

<section class="attachment-list" aria-label={title ?? t(M['assets.attachments.title'])} aria-busy={loading}>
  <h3>{title ?? t(M['assets.attachments.title'])}</h3>
  {#if message}<p role="alert">{message}</p>{/if}
  {#if loading}<p role="status">{t(M['assets.attachments.loading'])}</p>{/if}
  {#if attachments.length === 0 && !loading}<p>{t(M['assets.attachments.empty'])}</p>{/if}
  <ul>
    {#each attachments as attachment (attachment.id)}
      <li>
        {@render entry(attachment)}
        {#if removable && attachment.canRemove !== false}
          <div class="links"><Button type="button" variant="ghost" {density} disabled={busy} onclick={() => askRemove(attachment)}>{t(M['assets.attachments.remove'], { name: attachment.name })}</Button></div>
        {/if}
        {#if attachment.statusLabel}<p>{attachment.statusLabel}</p>{/if}
        {#if showHistory && attachment.versions?.length}
          <h4>{t(M['assets.attachments.history'])}</h4>
          <ol>{#each attachment.versions as version (version.id)}<li>{@render entry(version)}</li>{/each}</ol>
        {/if}
      </li>
    {/each}
  </ul>
  {#if failed}<p role="alert">{t(M['assets.attachments.remove_failed'], { name: failed })}</p>{/if}
  {#if removable}
    {#if removeAction && !onremove}
      <Form id={formId} method="post" action={removeAction} preventDefault={false}>
        <Input type="hidden" name={removeIdField} value={target?.id ?? ''} interaction={false} />
        {#each removeHiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
        <Input type="hidden" name={removeIntentField} value={removeIntent} interaction={false} />
      </Form>
    {/if}
    <ConfirmDialog
      open={target !== undefined}
      title={t(M['assets.attachments.remove_title'])}
      message={t(M['assets.attachments.remove_message'], { name: target?.name ?? '' })}
      confirmLabel={t(M['assets.attachments.remove_confirm'])}
      cancelLabel={t(M['assets.attachments.remove_cancel'])}
      destructive
      loading={busy}
      onconfirm={confirmRemove}
      oncancel={() => { if (!busy) target = undefined; }}
    />
  {/if}
</section>

<style>
  .attachment-list { min-width: 0; overflow-wrap: anywhere; }
  ul { list-style: none; padding: 0; }
  ul, ol { display: grid; gap: var(--smrt-spacing-4); }
  ol { padding-inline-start: var(--smrt-spacing-5); }
  li { min-width: 0; display: grid; gap: var(--smrt-spacing-2); }
  .links, .metadata { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); min-width: 0; }
  .metadata { color: var(--smrt-color-on-surface-variant); }
  h3, h4, p { margin: 0; }
  .links :global(a) { max-width: 100%; white-space: normal; overflow-wrap: anywhere; min-width: 0; }
</style>
