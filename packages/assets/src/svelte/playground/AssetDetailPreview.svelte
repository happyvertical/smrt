<script lang="ts">
import type { AssetDetailUpdates } from '../AssetDetail.svelte';
import AssetDetail from '../AssetDetail.svelte';
import type { PersistedAsset } from '../types';

let { asset }: { asset: PersistedAsset } = $props();

let isOpen = $state(false);
let previewAsset = $state<PersistedAsset | null>(null);
let statusMessage = $state<string | null>(null);
let lastAsset: PersistedAsset | null = null;

function clonePersistedAsset(
  source: PersistedAsset,
  updates: AssetDetailUpdates = {},
): PersistedAsset {
  return Object.assign(
    Object.create(Object.getPrototypeOf(source)) as PersistedAsset,
    source,
    updates,
  );
}

$effect(() => {
  if (asset !== lastAsset) {
    lastAsset = asset;
    previewAsset = clonePersistedAsset(asset);
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

  previewAsset = clonePersistedAsset(previewAsset, updates);
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
    background: color-mix(in srgb, var(--smrt-color-surface) 92%, transparent);
    border: 1px solid var(--smrt-color-outline-variant, rgba(15, 23, 34, 0.08));
    box-shadow: var(--smrt-elevation-5, 0 18px 38px color-mix(in srgb, var(--smrt-color-shadow) 8%, transparent));
  }

  .preview-card h4,
  .preview-card p {
    margin: 0;
  }

  .eyebrow {
    font-size: 0.75rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--smrt-color-primary, #0f766e);
  }

  button {
    justify-self: start;
    border: 0;
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.75rem 1rem;
    font: inherit;
    font-weight: 600;
    background: var(--smrt-color-primary, #0f766e);
    color: var(--smrt-color-on-primary, white);
    cursor: pointer;
  }

  .status {
    color: var(--smrt-color-primary, #0f766e);
    font-size: 0.95rem;
  }
</style>
