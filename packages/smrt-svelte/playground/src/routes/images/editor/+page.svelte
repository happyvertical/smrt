<script lang="ts">
import { ImageEditor } from '@happyvertical/smrt-images/svelte';

// Dummy image for playground
let testImage = {
  id: 'img_test123',
  name: 'Playground Test Image',
  url: 'https://images.unsplash.com/photo-1682687981674-0927add86f2b',
  width: 1200,
  height: 800,
  mimeType: 'image/jpeg',
} as any;

let savedImage: any = null;

function handleSave(image: any) {
  console.log('Saved derivative image:', image);
  savedImage = image;
}
</script>

<svelte:head>
  <title>Image Editor | SMRT Svelte Playground</title>
</svelte:head>

<div class="page-container">
  <div class="content-header">
    <h1>Image Editor Component</h1>
    <p>Provides Standard tools (Resize, Crop, Convert) and an AI editing mode.</p>
  </div>

  <div class="demo-section">
    <ImageEditor 
      image={testImage} 
      apiBaseUrl="/api/v1" 
      onSave={handleSave} 
    />
  </div>

  {#if savedImage}
    <div class="success-panel">
      <h3>Edit Successful!</h3>
      <p>A new derivative asset has been created.</p>
      <pre>{JSON.stringify(savedImage, null, 2)}</pre>
    </div>
  {/if}
</div>

<style>
  .page-container {
    max-width: 1000px;
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

  .success-panel {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.2);
    border-radius: var(--smrt-radius-lg, 8px);
    padding: 1.5rem;
  }

  .success-panel h3 {
    margin: 0 0 0.5rem 0;
    color: var(--smrt-color-success, #22c55e);
  }

  .success-panel p {
    margin: 0 0 1rem 0;
  }

  .success-panel pre {
    background: #000;
    padding: 1rem;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.85rem;
    overflow-x: auto;
    margin: 0;
    color: #a5d6ff;
  }
</style>
