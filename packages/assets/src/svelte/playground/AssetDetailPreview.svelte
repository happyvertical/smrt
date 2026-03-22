<script lang="ts">
import type { AssetDetailUpdates } from '../AssetDetail.svelte';
import AssetDetail from '../AssetDetail.svelte';
import type { PersistedAsset } from '../types';

let { asset }: { asset: PersistedAsset } = $props();

let isOpen = $state(false);
let previewAsset = $state<PersistedAsset | null>(null);
let statusMessage = $state<string | null>(null);
let lastAsset: PersistedAsset | null = null;

$effect(() => {
  if (asset !== lastAsset) {
    lastAsset = asset;
    previewAsset = { ...asset };
    statusMessage = null;
    isOpen = false;
  }
});

function openPreview() {
  statusMessage = null;
  isOpen = true;
}

function closePreview() {
  isOpen = false;
}

function handleSave(_asset: PersistedAsset, updates: AssetDetailUpdates) {
  if (!previewAsset) {
    return;
  }

  previewAsset = {
    ...previewAsset,
    ...updates,
  };
  statusMessage = 'Saved changes in the preview harness.';
}

function handleDelete() {
  statusMessage = 'Delete requested from the preview harness.';
  isOpen = false;
}

function handleEdit() {
  statusMessage = 'Edit requested from the preview harness.';
}
</script>

<div class="preview-shell">
  <div class="preview-card">
    <p class="eyebrow">Modal Preview</p>
    <h4>{previewAsset?.name ?? asset.name}</h4>
    <p>
      Launch the asset detail dialog from inside the preview stage so the shared
      playground stays navigable.
    </p>
    <button type="button" onclick={openPreview}>Open Asset Detail</button>
    {#if statusMessage}
      <p class="status">{statusMessage}</p>
    {/if}
  </div>

  <AssetDetail
    asset={previewAsset ?? asset}
    open={isOpen}
    onclose={closePreview}
    onsave={handleSave}
    ondelete={handleDelete}
    onedit={handleEdit}
  />
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
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(15, 23, 34, 0.08);
    box-shadow: 0 18px 38px rgba(15, 23, 34, 0.08);
  }

  .preview-card h4,
  .preview-card p {
    margin: 0;
  }

  .eyebrow {
    font-size: 0.75rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #0f766e;
  }

  button {
    justify-self: start;
    border: 0;
    border-radius: 999px;
    padding: 0.75rem 1rem;
    font: inherit;
    font-weight: 600;
    background: #0f766e;
    color: white;
    cursor: pointer;
  }

  .status {
    color: #0f766e;
    font-size: 0.95rem;
  }
</style>
