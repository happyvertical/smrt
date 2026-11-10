<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import { AssetManager } from '../index.js';
import type { PersistedAsset } from '../types.js';

const { t } = useI18n();

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

<div class="smrt-asset-manager-route__root" data-smrt-component="AssetManagerRoute">
  <header class="smrt-asset-manager-route__header" data-smrt-part="header">
    <div>
      <p class="smrt-asset-manager-route__eyebrow" data-smrt-part="label">{t(M['assets.asset_manager_route.eyebrow'])}</p>
      <h1>{t(M['assets.asset_manager_route.title'])}</h1>
      <p class="smrt-asset-manager-route__lede" data-smrt-part="summary">{t(M['assets.asset_manager_route.lede'])}</p>
    </div>
  </header>

  <div class="smrt-asset-manager-route__body" data-smrt-part="body">
    <section class="smrt-asset-manager-route__manager" data-smrt-part="content" aria-label={t(M['assets.asset_manager_route.surface_label'])}>
      <AssetManager
        mode="manage"
        accept="image/*"
        onSelect={handleSelect}
        {customActions}
      />
    </section>

    <aside class="smrt-asset-manager-route__sidebar" data-smrt-part="navigation" aria-label={t(M['assets.asset_manager_route.route_state_label'])}>
      <div class="smrt-asset-manager-route__panel" data-smrt-part="panel">
        <h2>{t(M['assets.asset_manager_route.selection_state'])}</h2>
        {#if selectedAssets.length === 0}
          <p class="smrt-asset-manager-route__empty" data-smrt-part="empty">{t(M['assets.asset_manager_route.no_assets_selected'])}</p>
        {:else}
          <p>
            <strong>{selectedAssets.length}</strong> {t(
              M['assets.asset_manager_route.assets_selected'],
              { plural: selectedAssets.length === 1 ? '' : 's' },
            )}
          </p>
          <ul class="smrt-asset-manager-route__selection-list" data-smrt-part="list">
            {#each selectedAssets as asset}
              <li>
                <code>{asset.id || 'new-asset'}</code>
                <span>{asset.name || 'Untitled'}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="smrt-asset-manager-route__panel" data-smrt-part="panel">
        <h2>{t(M['assets.asset_manager_route.custom_action_example'])}</h2>
        <p>{t(M['assets.asset_manager_route.custom_action_description'])}</p>
        {#if lastActionMessage}
          <p class="smrt-asset-manager-route__message" data-smrt-part="notice">{lastActionMessage}</p>
        {:else}
          <p class="smrt-asset-manager-route__empty" data-smrt-part="empty">
            Trigger <em>{t(M['assets.asset_manager_route.queue_review'])}</em> {t(M['assets.asset_manager_route.queue_review_hint'])}
          </p>
        {/if}
      </div>
    </aside>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-asset-manager-route__root {
    max-width: 1440px;
    margin: 0 auto;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .smrt-asset-manager-route__header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: end;
  }
  .smrt-asset-manager-route__eyebrow {
    margin: 0 0 0.5rem;
  }
  .smrt-asset-manager-route__header h1 {
    margin: 0;
  }
  .smrt-asset-manager-route__lede {
    max-width: 56rem;
    margin: 0.75rem 0 0;
  }
  .smrt-asset-manager-route__body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 1.5rem;
    align-items: start;
  }
  .smrt-asset-manager-route__manager {
    min-height: 760px;
  }
  .smrt-asset-manager-route__sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-asset-manager-route__panel {
    padding: 1.25rem;
  }
  .smrt-asset-manager-route__panel h2 {
    margin: 0 0 0.75rem;
  }
  .smrt-asset-manager-route__empty {
    margin: 0;
  }
  .smrt-asset-manager-route__message {
    margin: 0.75rem 0 0;
    padding: 0.75rem 0.875rem;
  }
  .smrt-asset-manager-route__selection-list {
    list-style: none;
    padding: 0;
    margin: 1rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-asset-manager-route__selection-list li {
    display: grid;
    gap: 0.25rem;
    padding: 0.625rem 0.75rem;
  }
  @media (max-width: 960px) {
    .smrt-asset-manager-route__root {
      padding: 1.25rem;
    }
    .smrt-asset-manager-route__body {
      grid-template-columns: 1fr;
    }
    .smrt-asset-manager-route__manager {
      min-height: 640px;
    }
  }
}

@layer smrt.theme {
  .smrt-asset-manager-route__eyebrow {
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    text-transform: uppercase;
  }
  .smrt-asset-manager-route__header h1 {
    font-size: clamp(2rem, 3vw, 2.75rem);
  }
  .smrt-asset-manager-route__lede {
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.6;
  }
  .smrt-asset-manager-route__panel {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 1rem;
    box-shadow: var(--smrt-elevation-5, 0 10px 30px color-mix(in srgb, var(--smrt-color-shadow) 6%, transparent));
  }
  .smrt-asset-manager-route__panel h2 {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .smrt-asset-manager-route__empty {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-asset-manager-route__message {
    border-radius: 0.75rem;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-asset-manager-route__selection-list li {
    border-radius: 0.75rem;
    background: var(--smrt-color-surface-container);
    border: var(--smrt-hairline);
  }
  .smrt-asset-manager-route__selection-list code {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-primary-container);
  }
}

</style>
