<script lang="ts">
import { onDestroy } from 'svelte';
import type {
  ImageEditorClient,
  ImageLike,
  ImagesGalleryClient,
} from '../image-clients';
import AssetsGallery from './AssetsGallery.svelte';

let {
  apiBaseUrl = '/api/v1',
  editorClient = undefined,
  galleryClient = undefined,
  onSelect,
  onCancel = undefined,
  allowedTabs = ['gallery', 'upload', 'camera', 'external'],
  enableDragToEditor = false,
}: {
  apiBaseUrl?: string;
  editorClient?: ImageEditorClient;
  galleryClient?: ImagesGalleryClient;
  /** @required Callback when an image is selected */
  onSelect: (image: ImageLike | File | string) => void;
  onCancel?: () => void;
  allowedTabs?: ('gallery' | 'upload' | 'camera' | 'external')[];
  enableDragToEditor?: boolean;
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

// --- Gallery Confirmation + Variation ---

let selectedImage: ImageLike | null = $state(null);
let showVariation = $state(false);
let variationPrompt = $state('');
let isGenerating = $state(false);
let variationError: string | null = $state(null);

function handleGalleryPick(image: ImageLike) {
  selectedImage = image;
  showVariation = false;
  variationPrompt = '';
  variationError = null;
}

function handleConfirmOriginal() {
  if (!selectedImage) return;
  onSelect(selectedImage);
  selectedImage = null;
}

function handleBackToChooser() {
  selectedImage = null;
  showVariation = false;
  variationPrompt = '';
  variationError = null;
}

async function handleGenerateVariation() {
  if (!selectedImage || !variationPrompt.trim()) return;
  isGenerating = true;
  variationError = null;

  try {
    const data = editorClient
      ? await editorClient.edit(selectedImage.id, {
          prompt: variationPrompt,
        })
      : await (async () => {
          const res = await fetch(
            `${apiBaseUrl}/images/${selectedImage.id}/edit`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: variationPrompt }),
            },
          );

          if (!res.ok) {
            let errText = await res.text();
            if (errText.trim().startsWith('<'))
              errText = `Server returned ${res.status} ${res.statusText}`;
            throw new Error(errText);
          }

          return (await res.json()) as { image: ImageLike };
        })();
    onSelect(data.image);
    selectedImage = null;
  } catch (e: any) {
    variationError = e.message || 'Failed to generate variation';
  } finally {
    isGenerating = false;
  }
}

onDestroy(() => {
  stopCamera();
});
</script>

<div class="smrt-image-uploader">
  {#if selectedImage}
    <!-- Gallery Confirmation Step -->
    <div class="header">
      <button type="button" class="back-btn" onclick={handleBackToChooser}>
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        Back
      </button>
      {#if onCancel}
        <button type="button" class="close-btn" onclick={onCancel}>×</button>
      {/if}
    </div>

    <div class="confirm-panel">
      <div class="confirm-preview-wrapper">
        <img class="confirm-preview-img" src={selectedImage.sourceUri || selectedImage.url} alt={selectedImage.name} />
      </div>
      
      <div class="confirm-info">
        <span class="confirm-name">{selectedImage.name}</span>
        <span class="confirm-meta">{selectedImage.width}×{selectedImage.height} · {selectedImage.mimeType}</span>
      </div>

      <div class="confirm-actions">
        <button type="button" class="primary-btn" onclick={handleConfirmOriginal}>
          Select Image
        </button>
        <button 
          type="button"
          class="variation-toggle" 
          class:active={showVariation}
          onclick={() => showVariation = !showVariation}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
          Create Variation
        </button>
      </div>

      {#if showVariation}
        <div class="variation-form">
          <p class="variation-hint">Describe how this image should be changed. A new derivative will be created from the original.</p>
          <textarea 
            bind:value={variationPrompt} 
            placeholder="e.g. Change the sky to show heavy rain and overcast clouds..."
            rows="3"
            disabled={isGenerating}
          ></textarea>
          {#if variationError}
            <div class="variation-error">{variationError}</div>
          {/if}
          <button 
            type="button"
            class="generate-btn"
            disabled={isGenerating || !variationPrompt.trim()} 
            onclick={handleGenerateVariation}
          >
            {#if isGenerating}
              <span class="spinner"></span>
              Generating…
            {:else}
              Generate Variation
            {/if}
          </button>
        </div>
      {/if}
    </div>

  {:else}
    <!-- Normal Chooser -->
    <div class="header">
      <h3>Choose Image</h3>
      {#if onCancel}
        <button type="button" class="close-btn" onclick={onCancel}>×</button>
      {/if}
    </div>
    
    <div class="tabs">
      {#if allowedTabs.includes('gallery')}
        <button type="button" class:active={activeTab === 'gallery'} onclick={() => activeTab = 'gallery'}>Gallery</button>
      {/if}
      {#if allowedTabs.includes('upload')}
        <button type="button" class:active={activeTab === 'upload'} onclick={() => activeTab = 'upload'}>Upload</button>
      {/if}
      {#if allowedTabs.includes('camera')}
        <button type="button" class:active={activeTab === 'camera'} onclick={() => activeTab = 'camera'}>Camera</button>
      {/if}
      {#if allowedTabs.includes('external')}
        <button type="button" class:active={activeTab === 'external'} onclick={() => activeTab = 'external'}>External URL</button>
      {/if}
    </div>
    
    <div class="tab-content">
      
      {#if activeTab === 'gallery'}
        <div class="gallery-wrapper">
          <AssetsGallery
            {apiBaseUrl}
            client={galleryClient}
            {enableDragToEditor}
            onSelect={handleGalleryPick}
          />
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
          <button type="button" class="browse-btn">Browse Files</button>
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
              <button type="button" onclick={startCamera}>Try Again</button>
            </div>
          {:else}
            <div class="video-container">
              <!-- svelte-ignore a11y_media_has_caption -->
              <video bind:this={videoElement} autoplay playsinline></video>
              {#if !isCameraActive}
                <div class="loading-overlay">Starting camera...</div>
              {/if}
            </div>
            <button type="button" class="capture-btn" disabled={!isCameraActive} onclick={takePicture}>
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
              type="button"
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
  {/if}
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
    background: color-mix(in srgb, var(--smrt-color-on-surface, #fff) 2%, transparent);
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
    background: color-mix(in srgb, var(--smrt-color-primary) 5%, transparent);
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
    background: var(--smrt-color-surface-dim, #000);
  }

  .video-container {
    position: relative;
    width: 100%;
    max-width: 600px;
    aspect-ratio: 4/3;
    background: var(--smrt-color-surface-container-lowest, #111);
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
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.7));
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

  /* --- Back Button --- */
  .back-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: transparent;
    border: none;
    color: var(--smrt-color-primary, #3b82f6);
    font-weight: 500;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: var(--smrt-radius-sm, 4px);
    transition: background 0.15s;
  }

  .back-btn:hover {
    background: color-mix(in srgb, var(--smrt-color-primary) 8%, transparent);
  }

  .confirm-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden; /* Prevent body scroll, let preview wrapper handle it */
  }

  .confirm-preview-wrapper {
    flex: 1;
    min-height: 0;
    padding: 1.5rem 1.5rem 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .confirm-preview-img {
    width: 100%;
    height: 100%;
    min-height: 200px;
    max-width: 100%;
    max-height: 400px;
    object-fit: contain;
    border-radius: var(--smrt-radius-md, 6px);
    border: 1px solid var(--smrt-color-outline-variant, #333);
    background-color: var(--smrt-color-surface-container-high, #242424);
  }

  .confirm-info {
    padding: 1rem 1.5rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .confirm-name {
    font-weight: 500;
    font-size: 1.05rem;
  }

  .confirm-meta {
    font-size: 0.85rem;
    color: var(--smrt-color-outline, #888);
  }

  .confirm-actions {
    padding: 1rem 1.5rem 1.5rem;
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    border-top: 1px solid var(--smrt-color-outline-variant, #333);
    margin-top: 0.5rem;
  }

  .primary-btn {
    background: var(--smrt-color-primary, #3b82f6);
    color: white;
    border: none;
    padding: 0.65rem 1.5rem;
    border-radius: 999px;
    font-weight: 500;
    cursor: pointer;
    transition: filter 0.15s;
  }

  .primary-btn:hover {
    filter: brightness(1.1);
  }

  .variation-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--smrt-color-surface-container-highest, #333);
    color: var(--smrt-color-on-surface-variant, #ccc);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    padding: 0.65rem 1.25rem;
    border-radius: 999px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .variation-toggle:hover {
    background: var(--smrt-color-surface-container-high, #3f3f3f);
  }

  .variation-toggle.active {
    color: var(--smrt-color-primary, #3b82f6);
    border-color: var(--smrt-color-primary, #3b82f6);
    background: color-mix(in srgb, var(--smrt-color-primary) 8%, transparent);
  }

  /* --- Variation Form --- */
  .variation-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.25rem;
    margin: 0 1.5rem 1.5rem;
    background: var(--smrt-color-surface-container-high, #242424);
    border-radius: var(--smrt-radius-md, 6px);
    border: 1px solid var(--smrt-color-outline-variant, #333);
  }

  .variation-hint {
    font-size: 0.85rem;
    color: var(--smrt-color-outline, #888);
    margin: 0;
  }

  .variation-form textarea {
    width: 100%;
    padding: 0.75rem;
    background: var(--smrt-color-surface-container, #1a1a1a);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    border-radius: var(--smrt-radius-sm, 4px);
    color: inherit;
    font-family: inherit;
    font-size: 0.95rem;
    resize: vertical;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .variation-form textarea:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #3b82f6);
    box-shadow: inset 0 0 0 1px var(--smrt-color-primary, #3b82f6);
  }

  .variation-form textarea:disabled {
    opacity: 0.6;
  }

  .variation-error {
    color: var(--smrt-color-error, #ef4444);
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    padding: 0.5rem 0.75rem;
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.85rem;
  }

  .generate-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    align-self: flex-start;
    background: var(--smrt-color-primary, #3b82f6);
    color: white;
    border: none;
    padding: 0.65rem 1.5rem;
    border-radius: 999px;
    font-weight: 500;
    cursor: pointer;
    transition: filter 0.15s, opacity 0.15s;
  }

  .generate-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .generate-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, var(--smrt-color-on-primary) 30%, transparent);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
</style>
