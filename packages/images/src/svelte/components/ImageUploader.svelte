<script lang="ts">
import { onDestroy } from 'svelte';
import type { Image } from '../../image';
import AssetsGallery from './AssetsGallery.svelte';

let {
  apiBaseUrl = '/api/v1',
  onSelect,
  onCancel = undefined,
  allowedTabs = ['gallery', 'upload', 'camera', 'external'],
}: {
  apiBaseUrl?: string;
  /** @required Callback when an image is selected */
  onSelect: (image: Image | File | string) => void;
  onCancel?: () => void;
  allowedTabs?: ('gallery' | 'upload' | 'camera' | 'external')[];
} = $props();

let activeTab = $state<string>();

// Ensure active tab defaults to the first allowed tab dynamically to fix the state-reference-locally lint
$effect(() => {
  if (!activeTab && allowedTabs.length > 0) {
    activeTab = allowedTabs[0];
  }
});

$effect(() => {
  if (!onSelect) {
    throw new Error('ImageUploader: `onSelect` prop is required.');
  }
});

// Upload state
let uploadInput: HTMLInputElement | undefined = $state();
let isDragging = $state(false);
let uploadError: string | null = $state(null);

// Camera state
let videoElement: HTMLVideoElement | undefined = $state();
let canvasElement: HTMLCanvasElement | undefined = $state();
let stream: MediaStream | null = $state(null);
let cameraError: string | null = $state(null);
let isCameraActive = $state(false);

// External state
let externalUrl = $state('');

// Tab switching cleanup
$effect(() => {
  if (activeTab !== 'camera' && stream) {
    stopCamera();
  } else if (activeTab === 'camera' && !stream) {
    startCamera();
  }
});

// --- Upload Handlers ---

function handleDragOver(e: DragEvent) {
  e.preventDefault();
  isDragging = true;
}

function handleDragLeave() {
  isDragging = false;
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  isDragging = false;
  uploadError = null;

  if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    if (!file.type.startsWith('image/')) {
      uploadError = 'Please drop an image file.';
      return;
    }
    onSelect(file);
  }
}

function handleFileSelect(e: Event) {
  uploadError = null;
  const target = e.target as HTMLInputElement;
  if (target.files && target.files.length > 0) {
    const file = target.files[0];
    if (!file.type.startsWith('image/')) {
      uploadError = 'Please select an image file.';
      return;
    }
    onSelect(file);
  }
}

// --- Camera Handlers ---

async function startCamera() {
  cameraError = null;
  isCameraActive = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    if (videoElement) {
      videoElement.srcObject = stream;
      videoElement.play();
      isCameraActive = true;
    }
  } catch (err: any) {
    cameraError = `Could not access camera: ${err.message}`;
  }
}

function stopCamera() {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    stream = null;
    isCameraActive = false;
  }
}

function takePicture() {
  if (!videoElement || !canvasElement || !isCameraActive) return;

  const context = canvasElement.getContext('2d');
  if (!context) return;

  // Set canvas dimensions to match video
  canvasElement.width = videoElement.videoWidth;
  canvasElement.height = videoElement.videoHeight;

  // Draw current frame to canvas
  context.drawImage(
    videoElement,
    0,
    0,
    canvasElement.width,
    canvasElement.height,
  );

  // Convert to blob and return
  canvasElement.toBlob(
    (blob) => {
      if (blob) {
        const file = new File([blob], `camera-${Date.now()}.jpg`, {
          type: 'image/jpeg',
        });
        onSelect(file);
        stopCamera();
      }
    },
    'image/jpeg',
    0.9,
  );
}

// --- External Handlers ---

function handleExternalSubmit() {
  if (!externalUrl) return;
  onSelect(externalUrl);
}

onDestroy(() => {
  stopCamera();
});
</script>

<div class="smrt-image-uploader">
  <div class="header">
    <h3>Choose Image</h3>
    {#if onCancel}
      <button class="close-btn" onclick={onCancel}>×</button>
    {/if}
  </div>
  
  <div class="tabs">
    {#if allowedTabs.includes('gallery')}
      <button class:active={activeTab === 'gallery'} onclick={() => activeTab = 'gallery'}>Gallery</button>
    {/if}
    {#if allowedTabs.includes('upload')}
      <button class:active={activeTab === 'upload'} onclick={() => activeTab = 'upload'}>Upload</button>
    {/if}
    {#if allowedTabs.includes('camera')}
      <button class:active={activeTab === 'camera'} onclick={() => activeTab = 'camera'}>Camera</button>
    {/if}
    {#if allowedTabs.includes('external')}
      <button class:active={activeTab === 'external'} onclick={() => activeTab = 'external'}>External URL</button>
    {/if}
  </div>
  
  <div class="tab-content">
    
    {#if activeTab === 'gallery'}
      <div class="gallery-wrapper">
        <AssetsGallery {apiBaseUrl} {onSelect} />
      </div>
      
    {:else if activeTab === 'upload'}
      <div 
        class="upload-area" 
        class:dragging={isDragging}
        ondragover={handleDragOver}
        ondragleave={handleDragLeave}
        ondrop={handleDrop}
        onclick={() => uploadInput?.click()}
        onkeydown={(e) => e.key === 'Enter' && uploadInput?.click()}
        tabindex="0"
        role="button"
      >
        <div class="upload-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
        </div>
        <p>Drag and drop an image here</p>
        <span class="divider">or</span>
        <button class="browse-btn">Browse Files</button>
        <input 
          type="file" 
          accept="image/*" 
          bind:this={uploadInput} 
          onchange={handleFileSelect} 
          style="display: none;" 
        />
        {#if uploadError}
          <p class="error">{uploadError}</p>
        {/if}
      </div>
      
    {:else if activeTab === 'camera'}
      <div class="camera-area">
        {#if cameraError}
          <div class="error-panel">
            <p>{cameraError}</p>
            <button onclick={startCamera}>Try Again</button>
          </div>
        {:else}
          <div class="video-container">
            <!-- svelte-ignore a11y_media_has_caption -->
            <video bind:this={videoElement} autoplay playsinline></video>
            {#if !isCameraActive}
              <div class="loading-overlay">Starting camera...</div>
            {/if}
          </div>
          <button class="capture-btn" disabled={!isCameraActive} onclick={takePicture}>
            Take Picture
          </button>
          <canvas bind:this={canvasElement} style="display: none;"></canvas>
        {/if}
      </div>
      
    {:else if activeTab === 'external'}
      <div class="external-area">
        <p class="hint">Enter a direct URL to an image or a supported provider link.</p>
        <div class="input-group">
          <input 
            type="url" 
            bind:value={externalUrl} 
            placeholder="https://example.com/image.jpg"
            onkeydown={(e) => e.key === 'Enter' && handleExternalSubmit()}
          />
          <button 
            class="submit-btn" 
            disabled={!externalUrl.trim()} 
            onclick={handleExternalSubmit}
          >
            Add
          </button>
        </div>
      </div>
    {/if}
    
  </div>
</div>

<style>
  .smrt-image-uploader {
    display: flex;
    flex-direction: column;
    background: var(--smrt-color-surface-container, #1a1a1a);
    color: var(--smrt-color-on-surface, #fff);
    border-radius: var(--smrt-radius-lg, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #333);
    overflow: hidden;
    height: 100%;
    min-height: 500px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #333);
  }
  
  .header h3 {
    margin: 0;
    font-size: 1.15rem;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--smrt-color-outline, #888);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
  }
  
  .close-btn:hover {
    color: var(--smrt-color-on-surface, #fff);
  }

  .tabs {
    display: flex;
    background: var(--smrt-color-surface-container-high, #242424);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #333);
  }

  .tabs button {
    flex: 1;
    background: transparent;
    border: none;
    border-bottom: 2px solid var(--smrt-color-outline-variant, #333);
    padding: 1rem;
    color: var(--smrt-color-outline, #888);
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    text-transform: uppercase;
    font-size: 0.85rem;
    letter-spacing: 0.5px;
  }

  .tabs button:hover {
    color: var(--smrt-color-on-surface-variant, #ccc);
    background: rgba(255,255,255,0.02);
  }

  .tabs button.active {
    color: var(--smrt-color-primary, #3b82f6);
    border-bottom: 2px solid var(--smrt-color-primary, #3b82f6);
    background: transparent;
  }

  .tab-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  }

  /* Gallery Tab */
  .gallery-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Gallery internal scroll handles the rest */
  }

  /* Upload Tab */
  .upload-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem;
    margin: 1.5rem;
    border: 2px dashed var(--smrt-color-outline-variant, #444);
    border-radius: var(--smrt-radius-lg, 8px);
    background: var(--smrt-color-surface-container-high, #242424);
    cursor: pointer;
    transition: all 0.2s;
  }

  .upload-area:hover, .upload-area:focus {
    border-color: var(--smrt-color-outline, #666);
    background: var(--smrt-color-surface-container-highest, #2a2a2a);
    outline: none;
  }

  .upload-area.dragging {
    border-color: var(--smrt-color-primary, #3b82f6);
    background: rgba(59, 130, 246, 0.05);
    transform: scale(1.02);
  }

  .upload-icon {
    color: var(--smrt-color-primary, #3b82f6);
    margin-bottom: 1rem;
  }

  .upload-area p {
    font-size: 1.1rem;
    margin: 0 0 0.5rem 0;
  }

  .divider {
    font-size: 0.85rem;
    color: var(--smrt-color-outline, #666);
    margin-bottom: 1rem;
  }

  .browse-btn {
    background: var(--smrt-color-primary, #3b82f6);
    color: white;
    border: none;
    padding: 0.5rem 1.5rem;
    border-radius: 999px;
    font-weight: 500;
    pointer-events: none; /* Let parent handle clicks */
  }

  .error {
    margin-top: 1rem;
    color: var(--smrt-color-error, #ef4444);
    font-size: 0.9rem;
  }

  /* Camera Tab */
  .camera-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 1.5rem;
    gap: 1.5rem;
    align-items: center;
    justify-content: center;
    background: #000;
  }

  .video-container {
    position: relative;
    width: 100%;
    max-width: 600px;
    aspect-ratio: 4/3;
    background: #111;
    border-radius: var(--smrt-radius-md, 6px);
    overflow: hidden;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .loading-overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.7);
    color: white;
  }

  .capture-btn {
    background: var(--smrt-color-primary, #3b82f6);
    color: white;
    border: none;
    padding: 1rem 3rem;
    border-radius: 999px;
    font-size: 1.1rem;
    font-weight: 600;
    cursor: pointer;
  }

  .capture-btn:disabled {
    background: var(--smrt-color-outline-variant, #444);
    color: var(--smrt-color-outline, #888);
    cursor: not-allowed;
  }

  .error-panel {
    text-align: center;
    padding: 2rem;
    background: var(--smrt-color-surface-container, #1a1a1a);
    border-radius: var(--smrt-radius-md, 6px);
  }

  .error-panel p {
    color: var(--smrt-color-error, #ef4444);
    margin-bottom: 1rem;
  }

  .error-panel button {
    background: var(--smrt-color-surface-container-high, #242424);
    color: white;
    border: 1px solid var(--smrt-color-outline-variant, #444);
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
  }

  /* External Tab */
  .external-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 3rem 2rem;
    align-items: center;
  }

  .hint {
    color: var(--smrt-color-outline, #888);
    margin-bottom: 2rem;
    text-align: center;
  }

  .input-group {
    display: flex;
    width: 100%;
    max-width: 500px;
    gap: 0.5rem;
  }

  .input-group input {
    flex: 1;
    padding: 1rem 1.25rem;
    background: var(--smrt-color-surface-container-high, #242424);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    border-radius: var(--smrt-radius-sm, 4px);
    color: var(--smrt-color-on-surface, #fff);
    font-size: 1rem;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .input-group input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #3b82f6);
    box-shadow: inset 0 0 0 1px var(--smrt-color-primary, #3b82f6);
  }

  .submit-btn {
    background: var(--smrt-color-primary, #3b82f6);
    color: white;
    border: none;
    padding: 0 1.5rem;
    border-radius: var(--smrt-radius-md, 6px);
    font-weight: 500;
    cursor: pointer;
  }

  .submit-btn:disabled {
    background: var(--smrt-color-surface-container-highest, #333);
    color: var(--smrt-color-outline, #666);
    cursor: not-allowed;
  }
</style>
