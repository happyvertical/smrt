<script lang="ts">
import { AssetsGallery, ImageEditor, ImageUploader } from '../svelte/index.js';
</script>

<div class="testbed testbed-root">
  <h1>SMRT Images Testbed</h1>
  
  <div class="component-section">
    <h2>Image Uploader & Gallery</h2>
    <div class="component-container">
      <ImageUploader apiBaseUrl="/api/v1" onSelect={(img) => console.log('Selected image:', img)} />
    </div>
  </div>

  <div class="component-section">
    <h2>Image Editor</h2>
    <div class="component-container">
      <!-- 
        Note: The editor requires a valid image prop to edit.
        In a real app, you'd pass the output of the uploader here.
      -->
      <ImageEditor apiBaseUrl="/api/v1" />
    </div>
  </div>
</div>

<style>
  .testbed-root {
    font-family: system-ui, -apple-system, sans-serif;
    background: #000;
    color: #fff;
    margin: 0;
    padding: 2rem;
    min-height: 100vh;
  }
  .testbed {
    max-width: 1200px;
    margin: 0 auto;
  }
  .component-section {
    margin-top: 3rem;
  }
  .component-container {
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1rem;
    min-height: 400px;
    background: #121212;
  }
</style>
