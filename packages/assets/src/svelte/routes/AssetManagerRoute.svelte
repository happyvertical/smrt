<script lang="ts">
import { AssetManager } from '../index.js';
import type { PersistedAsset } from '../types.js';

let selectedAssets = $state<PersistedAsset[]>([]);
let lastActionMessage = $state<string | null>(null);

function handleSelect(assets: PersistedAsset[]) {
  selectedAssets = assets;
}

function queueReview(assets: PersistedAsset[]) {
  if (assets.length === 0) {
    lastActionMessage = 'Select one or more assets to queue them for review.';
    return;
  }

  lastActionMessage = `Queued ${assets.length} asset${
    assets.length === 1 ? '' : 's'
  } for follow-up review.`;
}

const customActions = [
  {
    label: 'Queue Review',
    action: queueReview,
  },
];
</script>

<div class="assets-route">
  <header class="assets-route__header">
    <div>
      <p class="assets-route__eyebrow">Package Route Surface</p>
      <h1>Asset Manager</h1>
      <p class="assets-route__lede">
        The reference route for browsing, selecting, and reviewing uploaded
        assets with the package-owned asset manager UI.
      </p>
    </div>
  </header>

  <div class="assets-route__body">
    <section class="assets-route__manager" aria-label="Asset manager surface">
      <AssetManager
        mode="manage"
        accept="image/*"
        onSelect={handleSelect}
        {customActions}
      />
    </section>

    <aside class="assets-route__sidebar" aria-label="Asset route state">
      <div class="assets-route__panel">
        <h2>Selection State</h2>
        {#if selectedAssets.length === 0}
          <p class="assets-route__empty">No assets selected.</p>
        {:else}
          <p>
            <strong>{selectedAssets.length}</strong> asset{selectedAssets.length ===
            1
              ? ''
              : 's'} selected.
          </p>
          <ul class="assets-route__selection-list">
            {#each selectedAssets as asset}
              <li>
                <code>{asset.id || 'new-asset'}</code>
                <span>{asset.name || 'Untitled'}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="assets-route__panel">
        <h2>Custom Action Example</h2>
        <p>
          This route keeps package-owned defaults while leaving room for app
          specific actions.
        </p>
        {#if lastActionMessage}
          <p class="assets-route__message">{lastActionMessage}</p>
        {:else}
          <p class="assets-route__empty">
            Trigger <em>Queue Review</em> from the selection action bar to see
            the package route feedback.
          </p>
        {/if}
      </div>
    </aside>
  </div>
</div>

<style>
  .assets-route {
    max-width: 1440px;
    margin: 0 auto;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .assets-route__header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: end;
  }

  .assets-route__eyebrow {
    margin: 0 0 0.5rem;
    color: var(--smrt-color-primary, #0f766e);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    text-transform: uppercase;
  }

  .assets-route__header h1 {
    margin: 0;
    font-size: clamp(2rem, 3vw, 2.75rem);
  }

  .assets-route__lede {
    max-width: 56rem;
    margin: 0.75rem 0 0;
    color: var(--smrt-color-on-surface-variant, #475569);
    line-height: 1.6;
  }

  .assets-route__body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 1.5rem;
    align-items: start;
  }

  .assets-route__manager {
    min-height: 760px;
  }

  .assets-route__sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .assets-route__panel {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #dbe3ef);
    border-radius: 1rem;
    padding: 1.25rem;
    box-shadow: var(--smrt-elevation-5, 0 10px 30px color-mix(in srgb, var(--smrt-color-shadow) 6%, transparent));
  }

  .assets-route__panel h2 {
    margin: 0 0 0.75rem;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }

  .assets-route__empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .assets-route__message {
    margin: 0.75rem 0 0;
    padding: 0.75rem 0.875rem;
    border-radius: 0.75rem;
    background: var(--smrt-color-primary-container, #ecfeff);
    color: var(--smrt-color-on-primary-container, #155e75);
  }

  .assets-route__selection-list {
    list-style: none;
    padding: 0;
    margin: 1rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .assets-route__selection-list li {
    display: grid;
    gap: 0.25rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.75rem;
    background: var(--smrt-color-surface-container, #f8fafc);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
  }

  .assets-route__selection-list code {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-primary-container, #155e75);
  }

  @media (max-width: 960px) {
    .assets-route {
      padding: 1.25rem;
    }

    .assets-route__body {
      grid-template-columns: 1fr;
    }

    .assets-route__manager {
      min-height: 640px;
    }
  }
</style>
