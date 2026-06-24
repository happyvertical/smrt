<script lang="ts">
import { Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type {
  ImageConvertRequest,
  ImageCropRequest,
  ImageEditorClient,
  ImageLike,
  ImageResizeRequest,
} from '../image-clients';

const { t } = useI18n();

let {
  image = null,
  apiBaseUrl = '/api/v1',
  client = undefined,
  onSave = undefined,
  onCancel = undefined,
}: {
  image?: ImageLike | null;
  apiBaseUrl?: string;
  client?: ImageEditorClient;
  onSave?: (image: ImageLike) => void;
  onCancel?: () => void;
} = $props();

let mode: 'standard' | 'ai' = $state('standard');

let isEditingDimensions = $state(false);
let isCropping = $state(false);

// Set default state empty and populate through effect
let width = $state(800);
let height = $state(600);
let cropX = $state(0);
let cropY = $state(0);
let cropW = $state(800);
let cropH = $state(600);
let format = $state('webp');

// Track if we've initialized dimensions for the *current* image
let lastImageId = $state<string | undefined>(undefined);

// AI Mode options
let prompt = $state('');

let isProcessing = $state(false);
let error: string | null = $state(null);
let successMessage: string | null = $state(null);

async function postEditorRequest<TPayload extends object>(
  endpoint: string,
  payload: TPayload,
) {
  const res = await fetch(`${apiBaseUrl}/images/${image?.id}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let errText = await res.text();
    if (errText.trim().startsWith('<'))
      errText = `Server returned ${res.status} ${res.statusText}`;
    throw new Error(errText);
  }

  return (await res.json()) as { image: ImageLike };
}

$effect(() => {
  // Only reset dimensions if the actual image selection changes
  if (image?.id && image.id !== lastImageId) {
    lastImageId = image.id;
    resetDimensions();
  }
});

function resetDimensions() {
  if (!image) return;
  width = image.width;
  height = image.height;
  cropW = image.width;
  cropH = image.height;
  isEditingDimensions = false;
  isCropping = false;
}

async function handleResize() {
  if (!image) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const payload: ImageResizeRequest = { width, height };
    const data = client
      ? await client.resize(image.id, payload)
      : await postEditorRequest('resize', payload);

    successMessage = 'Image resized successfully (new derivative created).';
    if (onSave) onSave(data.image);
  } catch (e: any) {
    error = e.message || 'Failed to resize image';
  } finally {
    isProcessing = false;
  }
}

async function handleCrop() {
  if (!image) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const payload: ImageCropRequest = {
      x: cropX,
      y: cropY,
      w: cropW,
      h: cropH,
    };
    const data = client
      ? await client.crop(image.id, payload)
      : await postEditorRequest('crop', payload);

    successMessage = 'Image cropped successfully (new derivative created).';
    if (onSave) onSave(data.image);
  } catch (e: any) {
    error = e.message || 'Failed to crop image';
  } finally {
    isProcessing = false;
  }
}

async function handleConvert() {
  if (!image) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const payload: ImageConvertRequest = { format };
    const data = client
      ? await client.convert(image.id, payload)
      : await postEditorRequest('convert', payload);

    successMessage = `Image converted to ${format} successfully (new derivative created).`;
    if (onSave) onSave(data.image);
  } catch (e: any) {
    error = e.message || 'Failed to convert image';
  } finally {
    isProcessing = false;
  }
}

async function handleAIEdit() {
  if (!image || !prompt) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const data = client
      ? await client.edit(image.id, { prompt })
      : await postEditorRequest('edit', { prompt });

    successMessage = 'AI edit complete (new derivative created).';
    if (onSave) onSave(data.image);
  } catch (e: any) {
    error = e.message || 'Failed to apply AI edit';
  } finally {
    isProcessing = false;
  }
}
</script>

<div class="smrt-image-editor">
  <div class="header">
    <h3>{t(M['images.image_editor.title'])}</h3>
    {#if onCancel}
      <Button variant="ghost" size="sm" class="close-btn--x" onclick={onCancel}>×</Button>
    {/if}
  </div>

  {#if !image}
    <div class="empty-state">{t(M['images.image_editor.no_image_selected'])}</div>
  {:else}
    <div class="editor-content">
      <div class="image-preview" style="background-image: url({image.url})">
        <!-- Optional: Interactive crop overlay could go here -->
      </div>
      
      <div class="editor-controls">
        <div class="mode-selector">
          <Button
            variant={mode === 'standard' ? 'primary' : 'ghost'}
            class="mode-tab"
            onclick={() => (mode = 'standard')}
          >{t(M['images.image_editor.standard_tools'])}</Button>
          <Button
            variant={mode === 'ai' ? 'primary' : 'ghost'}
            class="mode-tab"
            onclick={() => (mode = 'ai')}
          >{t(M['images.image_editor.ai_edit'])}</Button>
        </div>

        {#if error}
          <div class="error-msg">{error}</div>
        {/if}
        {#if successMessage}
          <div class="success-msg">{successMessage}</div>
        {/if}

        {#if mode === 'standard'}
          <!-- Standard Operations -->
          <div class="tool-section">
            <h4>Resize</h4>
            <div class="row">
              <label>Width <Input type="number" class="dim-input" bind:value={width} onfocus={() => isEditingDimensions = true} /></label>
              <label>Height <Input type="number" class="dim-input" bind:value={height} onfocus={() => isEditingDimensions = true} /></label>
              <Button variant="ghost" class="tonal-btn--filled" disabled={isProcessing} onclick={handleResize}>{t(M['images.image_editor.apply_resize'])}</Button>
            </div>
            {#if isEditingDimensions}
               <div class="row"><Button variant="ghost" size="sm" class="text-btn--link" onclick={resetDimensions}>{t(M['images.image_editor.reset_dimensions'])}</Button></div>
            {/if}
          </div>

          <div class="tool-section">
            <h4>Crop</h4>
            <div class="row">
              <label>X <Input type="number" class="dim-input" bind:value={cropX} onfocus={() => isCropping = true} /></label>
              <label>Y <Input type="number" class="dim-input" bind:value={cropY} onfocus={() => isCropping = true} /></label>
            </div>
            <div class="row">
              <label>W <Input type="number" class="dim-input" bind:value={cropW} onfocus={() => isCropping = true} /></label>
              <label>H <Input type="number" class="dim-input" bind:value={cropH} onfocus={() => isCropping = true} /></label>
              <Button variant="ghost" class="tonal-btn--filled" disabled={isProcessing} onclick={handleCrop}>{t(M['images.image_editor.apply_crop'])}</Button>
            </div>
            {#if isCropping}
               <div class="row"><Button variant="ghost" size="sm" class="text-btn--link" onclick={resetDimensions}>{t(M['images.image_editor.reset_dimensions'])}</Button></div>
            {/if}
          </div>

          <div class="tool-section">
            <h4>{t(M['images.image_editor.convert_format'])}</h4>
            <div class="row">
              <Select class="format-select" bind:value={format}>
                <option value="webp">WebP</option>
                <option value="jpeg">JPEG</option>
                <option value="png">PNG</option>
              </Select>
              <Button variant="ghost" class="tonal-btn--filled" disabled={isProcessing} onclick={handleConvert}>Convert</Button>
            </div>
          </div>
        {:else}
          <!-- AI Operations -->
          <div class="tool-section">
            <h4>{t(M['images.image_editor.ai_powered_edit'])}</h4>
            <p class="hint">{t(M['images.image_editor.ai_powered_edit_hint'])}</p>
            <Textarea
              class="ai-prompt"
              bind:value={prompt}
              placeholder={t(M['images.image_editor.ai_prompt_placeholder'])}
              rows={4}
            />
            <Button
              variant="primary"
              class="primary-btn--pill"
              disabled={isProcessing || !prompt.trim()}
              onclick={handleAIEdit}
            >
              {isProcessing ? 'Generating...' : 'Apply AI Edit'}
            </Button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .smrt-image-editor {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.5rem;
    background: var(--smrt-color-surface-container, #1a1a1a);
    color: var(--smrt-color-on-surface, #fff);
    border-radius: var(--smrt-radius-lg, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #333);
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #333);
    padding-bottom: 1rem;
    margin-bottom: 0.5rem;
  }
  
  .header h3 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1.15rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  /* The migrated close Button keeps ghost styling; only bump the × glyph size.
     :global() pierces into the Button child's rendered <button> (see #1589). */
  .header :global(.close-btn--x) {
    color: inherit;
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    line-height: 1;
  }

  .empty-state {
    padding: 2rem;
    text-align: center;
    color: var(--smrt-color-outline, #666);
  }

  .editor-content {
    display: flex;
    flex-wrap: wrap;
    gap: 2rem;
  }

  .image-preview {
    flex: 1;
    min-width: 300px;
    min-height: 300px;
    background-size: contain;
    background-position: center;
    background-repeat: no-repeat;
    background-color: var(--smrt-color-surface-container-high, #242424);
    border-radius: var(--smrt-radius-md, 6px);
    border: 1px dashed var(--smrt-color-outline-variant, #444);
  }

  .editor-controls {
    flex: 1;
    min-width: 300px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* Segmented button style for tabs */
  .mode-selector {
    display: flex;
    background: var(--smrt-color-surface-container-high, #242424);
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.25rem;
    gap: 0.25rem;
  }

  /* The mode toggles are migrated Buttons (variant primary = active, ghost =
     inactive). Keep the segmented-pill sizing by piercing into each Button's
     rendered <button> (see #1589 scoping rule). */
  .mode-selector :global(.mode-tab) {
    flex: 1;
    padding: 0.6rem 1rem;
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .tool-section h4 {
    margin: 0 0 1rem 0;
    font-size: var(--smrt-typography-title-medium-size, 0.95rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant, #ccc);
  }

  .row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .row label {
    display: flex;
    flex-direction: column;
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-outline, #888);
    gap: 0.25rem;
  }

  /* Layout-only overrides for the migrated form primitives. The Input / Select /
     Textarea primitives own the visual styling (background, border, focus ring);
     these :global() rules only pierce their rendered controls to constrain box
     size and spacing (see #1589 scoping rule). */
  .row label :global(.dim-input) {
    width: 90px;
  }

  /* Size the format Select to its content instead of the primitive's full-width
     default so it sits inline beside the Convert button in the flex row. */
  .row :global(.format-select) {
    width: auto;
  }

  .tool-section :global(.ai-prompt) {
    margin-bottom: 1rem;
  }

  /* Migrated Buttons keep their bespoke filled-tonal / text-link / pill looks.
     :global() pierces into each Button's rendered <button> (see #1589). */
  .tool-section :global(.tonal-btn--filled) {
    background: var(--smrt-color-surface-container-highest, #333);
    color: var(--smrt-color-primary, #3b82f6);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    padding: 0.6rem 1.2rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: background 0.2s;
    margin-top: 1.25rem;
  }

  .tool-section :global(.tonal-btn--filled:hover:not(:disabled)) {
    background: var(--smrt-color-surface-container-high, #3f3f3f);
  }

  .tool-section :global(.text-btn--link) {
    text-decoration: underline;
    padding: 0;
  }
  .tool-section :global(.text-btn--link:hover) {
    color: var(--smrt-color-on-surface, #fff);
  }

  .tool-section :global(.primary-btn--pill) {
    padding: 0.6rem 1.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .tool-section :global(.primary-btn--pill:hover:not(:disabled)) {
    filter: brightness(1.1);
  }

  .hint {
    font-size: var(--smrt-typography-body-small-size, 0.8rem);
    color: var(--smrt-color-outline, #888);
    margin: 0 0 0.5rem 0;
  }

  .error-msg {
    color: var(--smrt-color-error, #ef4444);
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    padding: 0.5rem;
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }

  .success-msg {
    color: var(--smrt-color-success, #22c55e);
    background: color-mix(in srgb, var(--smrt-color-success) 10%, transparent);
    padding: 0.5rem;
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
</style>
