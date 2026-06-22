<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
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

<div class="preview-shell">
  <div class="preview-card">
    <p class="eyebrow">{t(M['assets.create_asset_modal_preview.modal_preview'])}</p>
    <h4>{t(M['assets.create_asset_modal_preview.title'])}</h4>
    <p>{t(M['assets.create_asset_modal_preview.description'])}</p>
    <button type="button" onclick={openPreview}>{t(M['assets.create_asset_modal_preview.open_upload_modal'])}</button>

    {#if statusMessage}
      <p class="status">{statusMessage}</p>
    {/if}

    {#if lastCreated}
      <dl class="summary">
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
  .preview-shell {
    display: grid;
    gap: 1rem;
  }

  .preview-card {
    display: grid;
    gap: 0.75rem;
    max-width: 32rem;
    padding: 1.25rem;
    border-radius: 1rem;
    background: color-mix(in srgb, var(--smrt-color-surface) 92%, transparent);
    border: 1px solid var(--smrt-color-outline-variant, rgba(15, 23, 34, 0.08));
    box-shadow: var(--smrt-elevation-5, 0 18px 38px color-mix(in srgb, var(--smrt-color-shadow) 8%, transparent));
  }

  .preview-card h4,
  .preview-card p,
  .summary,
  .summary dt,
  .summary dd {
    margin: 0;
  }

  .eyebrow {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.12em);
    text-transform: uppercase;
    color: var(--smrt-color-primary, #0f766e);
  }

  button {
    justify-self: start;
    border: 0;
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.75rem 1rem;
    font: inherit;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-primary, #0f766e);
    color: var(--smrt-color-on-primary, white);
    cursor: pointer;
  }

  .status {
    color: var(--smrt-color-primary, #0f766e);
    font-size: var(--smrt-typography-body-large-size, 0.95rem);
  }

  .summary {
    display: grid;
    gap: 0.5rem;
    padding-top: 0.5rem;
  }

  .summary div {
    display: grid;
    gap: 0.1rem;
  }

  .summary dt {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    text-transform: uppercase;
    color: var(--smrt-color-on-surface-variant, #5b6574);
  }

  .summary dd {
    color: var(--smrt-color-on-surface, #172033);
  }
</style>
