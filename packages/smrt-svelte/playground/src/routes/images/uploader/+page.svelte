<script lang="ts">
import { ImageUploader } from '@happyvertical/smrt-images/svelte';

let selectedResult: any = null;

function handleSelect(result: any) {
  console.log('Selected image:', result);
  if (result instanceof File) {
    const url = URL.createObjectURL(result);
    selectedResult = {
      type: 'file',
      name: result.name,
      size: result.size,
      url,
    };
  } else if (typeof result === 'string') {
    selectedResult = { type: 'url', url: result };
  } else {
    selectedResult = { type: 'asset', ...result };
  }
}
</script>

<svelte:head>
  <title>Image Uploader | SMRT Svelte Playground</title>
</svelte:head>

<div class="page-container">
  <div class="content-header">
    <h1>Image Uploader Component</h1>
    <p>Choose images via gallery, upload, camera, or external URL. Gallery selections include a confirmation step with an optional AI variation prompt.</p>
  </div>

  <div class="demo-section">
    <div class="demo-grid">
      <div class="component-preview">
        <ImageUploader 
          onSelect={handleSelect} 
          apiBaseUrl="/api/v1" 
        />
      </div>

      <div class="state-panel">
        <h3>Selection Result</h3>
        {#if selectedResult}
          <div class="success-banner">
            Image configured successfully!
          </div>
          <pre class="json-state">{JSON.stringify(selectedResult, null, 2)}</pre>
          {#if selectedResult.url}
            <div class="image-preview">
              <img src={selectedResult.url} alt="Selected preview" />
            </div>
          {/if}
        {:else}
          <div class="empty-state">
            Use the component to select or upload an image.
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .page-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .content-header h1 {
    font-size: 2rem;
    margin: 0 0 0.5rem 0;
  }

  .content-header p {
    color: var(--smrt-color-outline, #888);
    font-size: 1.1rem;
    margin: 0;
  }

  .demo-grid {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 2rem;
    align-items: start;
  }

  .component-preview {
    min-width: 0;
  }

  .state-panel {
    background: var(--smrt-color-surface-container, #1a1a1a);
    border: 1px solid var(--smrt-color-outline-variant, #333);
    border-radius: var(--smrt-radius-lg, 8px);
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .state-panel h3 {
    margin: 0;
    font-size: 1.1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #333);
    padding-bottom: 0.5rem;
  }

  .json-state {
    background: #000;
    padding: 1rem;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.85rem;
    overflow-x: auto;
    margin: 0;
    color: #a5d6ff;
  }

  .empty-state {
    color: var(--smrt-color-outline, #888);
    font-style: italic;
    text-align: center;
    padding: 2rem 0;
  }

  .success-banner {
    background: rgba(34, 197, 94, 0.1);
    color: var(--smrt-color-success, #22c55e);
    padding: 0.75rem;
    border-radius: 4px;
    font-weight: 500;
    text-align: center;
    border: 1px solid rgba(34, 197, 94, 0.2);
  }

  .image-preview {
    margin-top: 1rem;
    border-radius: 4px;
    overflow: hidden;
    border: 1px dashed var(--smrt-color-outline-variant, #444);
    background: #000;
  }

  .image-preview img {
    width: 100%;
    height: auto;
    display: block;
  }

  @media (max-width: 900px) {
    .demo-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
