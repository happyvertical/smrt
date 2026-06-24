<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy } from 'svelte';
import { M } from '../i18n.js';
import type {
  ImageEditorClient,
  ImageLike,
  ImagesGalleryClient,
} from '../image-clients';
import AssetsGallery from './AssetsGallery.svelte';

const { t } = useI18n();

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
// Set once the component tears down. `getUserMedia()` may still be resolving
// (permission prompt) after unmount; this lets startCamera() detect that and
// stop the just-granted tracks instead of leaking the camera (light stays on).
// Not reactive — it only gates an async cleanup decision.
let isDestroyed = false;

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
    const acquired = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });

    // The permission prompt may have resolved after the user switched tabs or
    // the component unmounted. If the camera is no longer the intended target,
    // immediately stop the just-granted tracks so the camera light turns off,
    // and don't attach the (now orphaned) stream.
    if (isDestroyed || activeTab !== 'camera') {
      for (const track of acquired.getTracks()) {
        track.stop();
      }
      return;
    }

    stream = acquired;
    if (videoElement) {
      videoElement.srcObject = stream;
      // play() can reject if autoplay is blocked; swallow it so it doesn't
      // surface as an unhandled rejection (the user can still capture frames).
      videoElement.play().catch(() => {});
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
  isDestroyed = true;
  stopCamera();
});
</script>

<div class="smrt-image-uploader">
  {#if selectedImage}
    <!-- Gallery Confirmation Step -->
    <div class="header">
      <Button variant="ghost" size="sm" class="back-btn--link" onclick={handleBackToChooser}>
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        Back
      </Button>
      {#if onCancel}
        <Button variant="ghost" size="sm" class="close-btn--x" onclick={onCancel}>×</Button>
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
        <Button variant="primary" class="primary-btn--pill" onclick={handleConfirmOriginal}>
          {t(M['images.image_uploader.select_image'])}
        </Button>
        <Button
          variant="ghost"
          class={showVariation
            ? 'variation-toggle--chip variation-toggle--active'
            : 'variation-toggle--chip'}
          onclick={() => (showVariation = !showVariation)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
          {t(M['images.image_uploader.create_variation'])}
        </Button>
      </div>

      {#if showVariation}
        <div class="variation-form">
          <p class="variation-hint">{t(M['images.image_uploader.variation_hint'])}</p>
          <textarea
            bind:value={variationPrompt}
            placeholder={t(M['images.image_uploader.variation_prompt_placeholder'])}
            rows="3"
            disabled={isGenerating}
          ></textarea>
          {#if variationError}
            <div class="variation-error">{variationError}</div>
          {/if}
          <Button
            variant="primary"
            class="generate-btn--pill"
            disabled={isGenerating || !variationPrompt.trim()}
            onclick={handleGenerateVariation}
          >
            {#if isGenerating}
              <span class="spinner"></span>
              {t(M['images.image_uploader.generating'])}
            {:else}
              {t(M['images.image_uploader.generate_variation'])}
            {/if}
          </Button>
        </div>
      {/if}
    </div>

  {:else}
    <!-- Normal Chooser -->
    <div class="header">
      <h3>{t(M['images.image_uploader.choose_image'])}</h3>
      {#if onCancel}
        <Button variant="ghost" size="sm" class="close-btn--x" onclick={onCancel}>×</Button>
      {/if}
    </div>
    
    <div class="tabs">
      {#if allowedTabs.includes('gallery')}
        <Button
          variant="ghost"
          class={activeTab === 'gallery' ? 'uploader-tab uploader-tab--active' : 'uploader-tab'}
          onclick={() => (activeTab = 'gallery')}
        >Gallery</Button>
      {/if}
      {#if allowedTabs.includes('upload')}
        <Button
          variant="ghost"
          class={activeTab === 'upload' ? 'uploader-tab uploader-tab--active' : 'uploader-tab'}
          onclick={() => (activeTab = 'upload')}
        >Upload</Button>
      {/if}
      {#if allowedTabs.includes('camera')}
        <Button
          variant="ghost"
          class={activeTab === 'camera' ? 'uploader-tab uploader-tab--active' : 'uploader-tab'}
          onclick={() => (activeTab = 'camera')}
        >Camera</Button>
      {/if}
      {#if allowedTabs.includes('external')}
        <Button
          variant="ghost"
          class={activeTab === 'external' ? 'uploader-tab uploader-tab--active' : 'uploader-tab'}
          onclick={() => (activeTab = 'external')}
        >{t(M['images.image_uploader.external_url'])}</Button>
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
          <p>{t(M['images.image_uploader.drag_and_drop'])}</p>
          <span class="divider">or</span>
          <Button variant="primary" class="browse-btn--decorative">{t(M['images.image_uploader.browse_files'])}</Button>
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
              <Button variant="secondary" class="try-again-btn" onclick={startCamera}>{t(M['images.image_uploader.try_again'])}</Button>
            </div>
          {:else}
            <div class="video-container">
              <!-- svelte-ignore a11y_media_has_caption -->
              <video bind:this={videoElement} autoplay playsinline></video>
              {#if !isCameraActive}
                <div class="loading-overlay">{t(M['images.image_uploader.starting_camera'])}</div>
              {/if}
            </div>
            <Button variant="primary" class="capture-btn--pill" disabled={!isCameraActive} onclick={takePicture}>
              {t(M['images.image_uploader.take_picture'])}
            </Button>
            <canvas bind:this={canvasElement} style="display: none;"></canvas>
          {/if}
        </div>
        
      {:else if activeTab === 'external'}
        <div class="external-area">
          <p class="hint">{t(M['images.image_uploader.external_hint'])}</p>
          <div class="input-group">
            <input 
              type="url" 
              bind:value={externalUrl}
              placeholder={t(M['images.image_uploader.external_url_placeholder'])}
              onkeydown={(e) => e.key === 'Enter' && handleExternalSubmit()}
            />
            <Button
              variant="primary"
              class="submit-btn--inline"
              disabled={!externalUrl.trim()}
              onclick={handleExternalSubmit}
            >
              Add
            </Button>
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
    font-size: var(--smrt-typography-title-medium-size, 1.15rem);
  }

  /* Migrated close Button keeps its muted ghost look; only the × glyph sizing
     is custom. :global() pierces into the Button child's rendered <button>
     (see #1589 scoping rule). */
  .header :global(.close-btn--x) {
    color: var(--smrt-color-outline, #888);
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    line-height: 1;
  }

  .header :global(.close-btn--x:hover) {
    color: var(--smrt-color-on-surface, #fff);
  }

  .tabs {
    display: flex;
    background: var(--smrt-color-surface-container-high, #242424);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #333);
  }

  /* The tab strip is migrated to ghost Buttons; the active state is the bottom
     underline rather than a filled variant. :global() pierces into each
     Button's rendered <button> (see #1589 scoping rule). */
  .tabs :global(.uploader-tab) {
    flex: 1;
    border: none;
    border-bottom: 2px solid var(--smrt-color-outline-variant, #333);
    padding: 1rem;
    color: var(--smrt-color-outline, #888);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: 0;
    transition: all 0.2s;
    text-transform: uppercase;
    font-size: var(--smrt-typography-label-large-size, 0.85rem);
    letter-spacing: var(--smrt-typography-label-large-tracking, 0.5px);
  }

  .tabs :global(.uploader-tab:hover) {
    color: var(--smrt-color-on-surface-variant, #ccc);
    background: color-mix(in srgb, var(--smrt-color-on-surface, #fff) 2%, transparent);
  }

  .tabs :global(.uploader-tab--active) {
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
    font-size: var(--smrt-typography-body-large-size, 1.1rem);
    margin: 0 0 0.5rem 0;
  }

  .divider {
    font-size: var(--smrt-typography-label-large-size, 0.85rem);
    color: var(--smrt-color-outline, #666);
    margin-bottom: 1rem;
  }

  /* Decorative label inside the click-catching upload area; the parent handles
     clicks, so this migrated Button stays inert. :global() pierces into the
     Button child's rendered <button> (see #1589 scoping rule). */
  .upload-area :global(.browse-btn--decorative) {
    padding: 0.5rem 1.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: var(--smrt-typography-weight-medium, 500);
    pointer-events: none; /* Let parent handle clicks */
  }

  .error {
    margin-top: 1rem;
    color: var(--smrt-color-error, #ef4444);
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
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

  /* Large primary capture action; keeps its oversized pill sizing over the
     primary variant. :global() pierces into the Button child (see #1589). */
  .camera-area :global(.capture-btn--pill) {
    padding: 1rem 3rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-size: var(--smrt-typography-body-large-size, 1.1rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .camera-area :global(.capture-btn--pill:disabled) {
    background: var(--smrt-color-outline-variant, #444);
    color: var(--smrt-color-outline, #888);
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

  /* Migrated "try again" Button keeps its surface-tinted look over the
     secondary variant. :global() pierces into the Button child (see #1589). */
  .error-panel :global(.try-again-btn) {
    background: var(--smrt-color-surface-container-high, #242424);
    color: white;
    border: 1px solid var(--smrt-color-outline-variant, #444);
    padding: 0.5rem 1rem;
    border-radius: var(--smrt-radius-sm, 4px);
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
    font-size: var(--smrt-typography-body-large-size, 1rem);
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .input-group input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #3b82f6);
    box-shadow: inset 0 0 0 1px var(--smrt-color-primary, #3b82f6);
  }

  /* Migrated Add Button sits in the URL input group; keeps square-ish radius
     and zero vertical padding. :global() pierces into the Button child
     (see #1589 scoping rule). */
  .input-group :global(.submit-btn--inline) {
    padding: 0 1.5rem;
    border-radius: var(--smrt-radius-md, 6px);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .input-group :global(.submit-btn--inline:disabled) {
    background: var(--smrt-color-surface-container-highest, #333);
    color: var(--smrt-color-outline, #666);
  }

  /* --- Back Button --- */
  /* Migrated ghost Button keeps the icon+label inline layout and tinted hover.
     :global() pierces into the Button child (see #1589 scoping rule). */
  .header :global(.back-btn--link) {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--smrt-color-primary, #3b82f6);
    font-weight: var(--smrt-typography-weight-medium, 500);
    padding: 0.25rem 0.5rem;
    border-radius: var(--smrt-radius-sm, 4px);
    transition: background 0.15s;
  }

  .header :global(.back-btn--link:hover) {
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
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-title-medium-size, 1.05rem);
  }

  .confirm-meta {
    font-size: var(--smrt-typography-label-large-size, 0.85rem);
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

  /* Migrated confirm-action Buttons keep their pill / chip looks. :global()
     pierces into each Button's rendered <button> (see #1589 scoping rule). */
  .confirm-actions :global(.primary-btn--pill) {
    padding: 0.65rem 1.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: filter 0.15s;
  }

  .confirm-actions :global(.primary-btn--pill:hover) {
    filter: brightness(1.1);
  }

  .confirm-actions :global(.variation-toggle--chip) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--smrt-color-surface-container-highest, #333);
    color: var(--smrt-color-on-surface-variant, #ccc);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    padding: 0.65rem 1.25rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: all 0.2s;
  }

  .confirm-actions :global(.variation-toggle--chip:hover) {
    background: var(--smrt-color-surface-container-high, #3f3f3f);
  }

  .confirm-actions :global(.variation-toggle--active) {
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
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
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
    font-size: var(--smrt-typography-body-large-size, 0.95rem);
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
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }

  /* Migrated generate Button keeps its left-aligned pill look and inline
     spinner. :global() pierces into the Button child (see #1589 scoping rule). */
  .variation-form :global(.generate-btn--pill) {
    align-self: flex-start;
    padding: 0.65rem 1.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: filter 0.15s, opacity 0.15s;
  }

  .variation-form :global(.generate-btn--pill:hover:not(:disabled)) {
    filter: brightness(1.1);
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
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 0.6s linear infinite;
  }
</style>
