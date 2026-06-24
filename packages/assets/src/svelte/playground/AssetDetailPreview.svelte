<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { AssetDetailUpdates } from '../AssetDetail.svelte';
import AssetDetail from '../AssetDetail.svelte';
import { M } from '../i18n.js';
import type { PersistedAsset } from '../types';

const { t } = useI18n();

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
    <p class="eyebrow">{t(M['assets.asset_detail_preview.modal_preview'])}</p>
    <h4>{previewAsset?.name ?? asset.name}</h4>
    <p>{t(M['assets.asset_detail_preview.description'])}</p>
    <Button variant="primary" class="preview-open" onclick={openPreview}>{t(M['assets.asset_detail_preview.open_asset_detail'])}</Button>
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
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.12em);
    text-transform: uppercase;
    color: var(--smrt-color-primary, #0f766e);
  }

  /* The open-preview button renders via <Button variant="primary"> (issue
     #1589). The primary variant owns the fill/color; this override keeps the
     pill shape and grid placement, reaching the child <button> via :global(). */
  .preview-card :global(.preview-open) {
    justify-self: start;
    border: 0;
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.75rem 1rem;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .status {
    color: var(--smrt-color-primary, #0f766e);
    font-size: var(--smrt-typography-body-large-size, 0.95rem);
  }
</style>
