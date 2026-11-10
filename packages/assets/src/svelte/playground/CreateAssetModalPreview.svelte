<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import CreateAssetModal from '../CreateAssetModal.svelte';
import { M } from '../i18n.js';

const { t } = useI18n();

interface CreatedAssetSummary {
  name: string;
  description: string;
  altText: string;
  fileName: string;
}

let isOpen = $state(false);
let statusMessage = $state<string | null>(null);
let lastCreated = $state<CreatedAssetSummary | null>(null);

function openPreview() {
  statusMessage = null;
  isOpen = true;
}

function closePreview() {
  isOpen = false;
}

function handleCreate(data: {
  file: File;
  name: string;
  description: string;
  altText: string;
}) {
  lastCreated = {
    name: data.name,
    description: data.description,
    altText: data.altText,
    fileName: data.file.name,
  };
  statusMessage = 'Captured a create request in the preview harness.';
  isOpen = false;
}
</script>

<div class="smrt-create-asset-modal-preview__root" data-smrt-component="CreateAssetModalPreview">
  <div class="smrt-create-asset-modal-preview__card" data-smrt-part="panel">
    <p class="smrt-create-asset-modal-preview__eyebrow" data-smrt-part="label">{t(M['assets.create_asset_modal_preview.modal_preview'])}</p>
    <h4>{t(M['assets.create_asset_modal_preview.title'])}</h4>
    <p>{t(M['assets.create_asset_modal_preview.description'])}</p>
    <Button variant="primary" onclick={openPreview}>{t(M['assets.create_asset_modal_preview.open_upload_modal'])}</Button>

    {#if statusMessage}
      <p class="smrt-create-asset-modal-preview__status" data-smrt-part="status">{statusMessage}</p>
    {/if}

    {#if lastCreated}
      <dl class="smrt-create-asset-modal-preview__summary" data-smrt-part="body">
        <div>
          <dt>File</dt>
          <dd>{lastCreated.fileName}</dd>
        </div>
        <div>
          <dt>Name</dt>
          <dd>{lastCreated.name || 'Untitled'}</dd>
        </div>
        <div>
          <dt>Description</dt>
          <dd>{lastCreated.description || '—'}</dd>
        </div>
        <div>
          <dt>{t(M['assets.create_asset_modal_preview.alt_text'])}</dt>
          <dd>{lastCreated.altText || '—'}</dd>
        </div>
      </dl>
    {/if}
  </div>

  <CreateAssetModal open={isOpen} onclose={closePreview} oncreate={handleCreate} />
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-create-asset-modal-preview__root {
    display: grid;
    gap: 1rem;
  }
  .smrt-create-asset-modal-preview__card {
    display: grid;
    gap: 0.75rem;
    max-width: 32rem;
    padding: 1.25rem;
  }
  .smrt-create-asset-modal-preview__card h4,
  .smrt-create-asset-modal-preview__card p,
  .smrt-create-asset-modal-preview__summary,
  .smrt-create-asset-modal-preview__summary dt,
  .smrt-create-asset-modal-preview__summary dd {
    margin: 0;
  }
  /* The open-modal button renders via <Button variant="primary"> (issue #1589).
  The primary variant owns the fill/color; this override keeps the pill shape
  and grid placement, reaching the child <button> via :global(). */
  .smrt-create-asset-modal-preview__card :global([data-smrt-component="Button"]) {
    justify-self: start;
    padding: 0.75rem 1rem;
  }
  .smrt-create-asset-modal-preview__summary {
    display: grid;
    gap: 0.5rem;
    padding-top: 0.5rem;
  }
  .smrt-create-asset-modal-preview__summary div {
    display: grid;
    gap: 0.1rem;
  }
}

@layer smrt.theme {
  .smrt-create-asset-modal-preview__card {
    border-radius: 1rem;
    background: color-mix(in srgb, var(--smrt-color-surface) 92%, transparent);
    border: var(--smrt-hairline);
    box-shadow: var(--smrt-elevation-5, 0 18px 38px color-mix(in srgb, var(--smrt-color-shadow) 8%, transparent));
  }
  .smrt-create-asset-modal-preview__eyebrow {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.12em);
    text-transform: uppercase;
    color: var(--smrt-color-primary);
  }
  /* The open-modal button renders via <Button variant="primary"> (issue #1589).
  The primary variant owns the fill/color; this override keeps the pill shape
  and grid placement, reaching the child <button> via :global(). */
  .smrt-create-asset-modal-preview__card :global([data-smrt-component="Button"]) {
    border: 0;
    border-radius: var(--smrt-radius-full);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-create-asset-modal-preview__status {
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-body-large-size, 0.95rem);
  }
  .smrt-create-asset-modal-preview__summary dt {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    text-transform: uppercase;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-create-asset-modal-preview__summary dd {
    color: var(--smrt-color-on-surface);
  }
}

</style>
