<script lang="ts">
import ImageUploader from '../../../images/src/svelte/components/ImageUploader.svelte';
import { AssetManager } from '../svelte';

// For testing in the local dev server, we'll provide some basic mock functionality
// or a way to select a tenant if the local DB has data.

let selectedAssets = $state<any[]>([]);

function handleSelect(assets: any[]) {
  selectedAssets = assets;
  console.log('Selected:', assets);
}

function handleConfirm(assets: any[]) {
  alert(
    `Confirmed selection of ${assets.length} assets. Check console for details.`,
  );
  console.log('Confirmed:', assets);
}
</script>

<div class="playground">
  <header class="header">
    <h1>Asset Manager Playground</h1>
    <p>Testing environment for the <code>@happyvertical/smrt-assets/svelte</code> components.</p>
  </header>

  <main class="main">
    <div class="manager-container">
      <AssetManager
        mode="manage"
        accept="image/*"
        onselect={handleSelect}
        onconfirm={handleConfirm}
        customActions={[
          { label: 'Say Hello', action: (assets) => alert(`Hello to ${assets.length} assets!`) }
        ]}
      >
        {#snippet uploader({ open, initialFile, onclose, oncreate })}
          {#if open}
            <div class="uploader-overlay">
              <div class="uploader-modal">
                <ImageUploader 
                  onSelect={(file) => { oncreate(file); onclose(); }}
                  onCancel={onclose}
                />
              </div>
            </div>
          {/if}
        {/snippet}
      </AssetManager>
    </div>

    <aside class="sidebar">
      <h2>Selection State</h2>
      {#if selectedAssets.length === 0}
        <p class="empty-state">No assets selected.</p>
      {:else}
        <p><strong>{selectedAssets.length}</strong> asset(s) selected.</p>
        <ul class="selection-list">
          {#each selectedAssets as asset}
            <li>
              <code>{asset.id || 'new-asset'}</code> - {asset.name || 'Untitled'}
            </li>
          {/each}
        </ul>
      {/if}
    </aside>
  </main>
</div>

<style>
  .playground {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem;
  }

  .header {
    margin-bottom: 2rem;
  }

  .header h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
  }

  .header p {
    margin: 0;
    color: #4b5563;
  }

  .main {
    display: grid;
    grid-template-columns: 1fr 300px;
    gap: 2rem;
    align-items: start;
  }

  .manager-container {
    height: 800px;
    /* AssetManager is designed to fill its container */
  }

  .sidebar {
    background: white;
    padding: 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid #e5e7eb;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .sidebar h2 {
    margin: 0 0 1rem 0;
    font-size: 1.25rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #e5e7eb;
  }

  .empty-state {
    color: #6b7280;
    font-style: italic;
  }

  .selection-list {
    list-style: none;
    padding: 0;
    margin: 1rem 0 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .selection-list li {
    font-size: 0.875rem;
    padding: 0.5rem;
    background: #f9fafb;
    border-radius: 0.25rem;
    border: 1px solid #e5e7eb;
    word-break: break-all;
  }

  /* Custom Uploader Snippet Styles */
  .uploader-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .uploader-modal {
    width: 90vw;
    max-width: 1000px;
    height: 80vh;
    animation: slideIn 0.2s ease-out;
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
