<script lang="ts">
import type { Image } from '@happyvertical/smrt-images';
import { ImageUploader } from '@happyvertical/smrt-images/svelte';
import { slide } from 'svelte/transition';
import ContentAgentChat from './ContentAgentChat.svelte';

let {
  content = undefined,
  contentId = 'new',
  onSave,
  onCancel,
} = $props<{
  content?: any;
  contentId?: string;
  onSave: (data: any) => void;
  onCancel: () => void;
}>();

function getInitialFormData(c: any) {
  return c
    ? {
        ...c,
        referenceIds: c.referenceIds || [],
        assetIds: c.assetIds || [],
        assets: c.assets || [],
      }
    : {
        title: '',
        description: '',
        body: '',
        author: '',
        type: 'article',
        status: 'draft',
        state: 'active',
        source: 'manual',
        url: '',
        fileKey: '',
        thumbnailAssetId: null,
        referenceIds: [],
        assetIds: [],
        assets: [],
      };
}

let formData = $state<any>(getInitialFormData(undefined));
let lastContentId = $state<string | undefined>(undefined);
let currentEditorState = $derived(formData.body || '');
let currentReferenceIds = $derived(formData.referenceIds || []);

// Undo stack for AI field edits — each entry stores the old values of changed fields
let fieldUndoStack = $state<Record<string, string>[]>([]);
let lastAppliedFields = $state<string[]>([]);
let showUndoBanner = $state(false);

// When content prop changes from outside (different item), reset formData.
$effect(() => {
  const newId = content?.id;
  if (newId !== lastContentId) {
    lastContentId = newId;
    formData = getInitialFormData(content);
    fieldUndoStack = [];
    showUndoBanner = false;
  }
});

/** Called by ContentAgentChat when AI wants to update form fields */
function applyFieldUpdates(fields: Record<string, string>) {
  // Snapshot old values for undo
  const oldValues: Record<string, string> = {};
  for (const key of Object.keys(fields)) {
    oldValues[key] = formData[key] ?? '';
    formData[key] = fields[key];
  }
  fieldUndoStack = [...fieldUndoStack, oldValues];
  lastAppliedFields = Object.keys(fields);
  showUndoBanner = true;
}

function undoLastApply() {
  if (fieldUndoStack.length === 0) return;
  const oldValues = fieldUndoStack[fieldUndoStack.length - 1];
  fieldUndoStack = fieldUndoStack.slice(0, -1);
  for (const [key, val] of Object.entries(oldValues)) {
    formData[key] = val;
  }
  lastAppliedFields = Object.keys(oldValues);
  if (fieldUndoStack.length === 0) {
    showUndoBanner = false;
  }
}

// We need a simple way to enter reference IDs or mock selecting them
let newReferenceId = $state('');

function addReference() {
  if (newReferenceId && !formData.referenceIds.includes(newReferenceId)) {
    formData.referenceIds = [...formData.referenceIds, newReferenceId];
    newReferenceId = '';
  }
}

function removeReference(id: string) {
  formData.referenceIds = formData.referenceIds.filter(
    (refId: string) => refId !== id,
  );
}

// AI Authoring State (Migrated to ContentAgentChat Sidebar)

let showImageUploader = $state(false);

function getImageRecord(payload: any) {
  return payload?.data ?? payload;
}

function handleSubmit(e: Event) {
  e.preventDefault();
  onSave(formData);
}

function handleImageSelect(selected: Image | File | string) {
  if (selected && typeof selected === 'object' && 'id' in selected) {
    // Gallery Image Object
    addSelectedAsset(selected);
    showImageUploader = false;
  } else if (selected instanceof File) {
    // 1. Raw File Upload (Camera / Upload Tab)
    // For local dev, we base64 encode the file and save the data URI directly to the DB!
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Url = e.target?.result as string;
      try {
        const resp = await fetch('/api/v1/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: selected.name || 'Uploaded Image',
            sourceUri: base64Url,
            mimeType: selected.type || 'image/png',
          }),
        });
        if (resp.ok) {
          const newImage = await resp.json();
          addSelectedAsset(getImageRecord(newImage));
        } else {
          console.error('[ContentEditor] Failed to save uploaded file record');
        }
      } catch (err) {
        console.error(
          '[ContentEditor] Error sending uploaded file to API:',
          err,
        );
      }
    };
    reader.readAsDataURL(selected);
    showImageUploader = false;
  } else if (typeof selected === 'string') {
    // 2. External URL Upload
    void (async () => {
      try {
        const parsedUrl = new URL(selected);
        const resp = await fetch('/api/v1/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: parsedUrl.pathname.split('/').pop() || 'External Image',
            sourceUri: selected,
            mimeType: 'image/jpeg',
          }),
        });

        if (!resp.ok) {
          throw new Error(await resp.text());
        }

        const newImage = await resp.json();
        addSelectedAsset(getImageRecord(newImage));
      } catch (err) {
        console.error(
          '[ContentEditor] Failed to save external URL record:',
          err,
        );
      }
    })();
    showImageUploader = false;
  }
}

function addSelectedAsset(asset: any) {
  const assetId = asset.id;
  if (!formData.assetIds.includes(assetId)) {
    formData.assetIds = [...formData.assetIds, assetId];
    formData.assets = [...formData.assets, asset];
  }
  if (!formData.thumbnailAssetId) {
    formData.thumbnailAssetId = assetId;
  }
}

function setThumbnail(id: string) {
  formData.thumbnailAssetId = id;
}

function removeAsset(id: string) {
  formData.assetIds = formData.assetIds.filter((aId: string) => aId !== id);
  formData.assets = formData.assets.filter((a: any) => a.id !== id);
  if (formData.thumbnailAssetId === id) {
    formData.thumbnailAssetId = null;
  }
}
</script>

<div class="form-container">
  <div class="header-row">
    <h3>{content ? 'Edit Content' : 'Add New Content'}</h3>
    
  </div>
  
  <div class="editor-grid">
    <!-- LEFT COLUMN -->
    <div class="editor-main-col">
      
      <details class="editor-drawer" open>
          <summary class="editor-drawer-header">
            Main Content
            <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
        <div class="editor-drawer-content">
          <form onsubmit={handleSubmit} id="content-edit-form">
            <label class="form-row-block">
              Title:
              <input type="text" bind:value={formData.title} required />
            </label>

            {#if showUndoBanner}
              <div class="undo-banner">
                <span class="undo-banner__text">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>
                  AI updated {lastAppliedFields.length} field{lastAppliedFields.length !== 1 ? 's' : ''}: {lastAppliedFields.join(', ')}
                </span>
                <button type="button" class="undo-banner__btn" onclick={undoLastApply}>
                  Undo{fieldUndoStack.length > 1 ? ` (${fieldUndoStack.length})` : ''}
                </button>
              </div>
            {/if}

            <label class="form-row-block">
              Body:
              <textarea id="content-body-input" bind:value={formData.body} rows="15"></textarea>
            </label>
            
            <div class="form-actions" style="margin-top: 1.5rem; justify-content: flex-start;">
              <button type="submit" class="save-button">{content ? 'Update Content' : 'Add Content'}</button>
              <button type="button" onclick={onCancel} class="cancel-button">Cancel</button>
            </div>
          </form>
        </div>
      </details>

      <details class="editor-drawer" open>
          <summary class="editor-drawer-header">
            Images & Media
            <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <div class="editor-drawer-content">
             <div class="media-gallery">
                {#if formData.assets && formData.assets.length > 0}
                  <div class="media-grid">
                    {#each formData.assets as asset (asset.id)}
                      <div class="media-item" class:is-thumbnail={asset.id === formData.thumbnailAssetId}>
                        <img class="media-item-image" src={asset.sourceUri || asset.url} alt={asset.name || 'Asset image'} />
                        <div class="media-item-overlay">
                           {#if asset.id !== formData.thumbnailAssetId}
                             <button type="button" class="btn-make-thumbnail" title="Make Thumbnail" onclick={() => setThumbnail(asset.id)}>
                               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                             </button>
                           {/if}
                           <button type="button" class="btn-remove-asset" title="Remove" onclick={() => removeAsset(asset.id)}>
                             <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                           </button>
                        </div>
                        {#if asset.id === formData.thumbnailAssetId}
                          <div class="thumbnail-badge">Thumbnail</div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {:else}
                  <p class="no-media-text">No images attached to this article.</p>
                {/if}
                {#if !showImageUploader}
                  <button type="button" class="add-image-btn" onclick={() => showImageUploader = true} style="margin-top: 1rem;">
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                      <circle cx="8.5" cy="8.5" r="1.5"></circle>
                      <polyline points="21 15 16 10 5 21"></polyline>
                    </svg>
                    Add Image
                  </button>
                {/if}

                {#if showImageUploader}
                  <div class="inline-uploader-container" transition:slide>
                    <ImageUploader 
                      allowedTabs={['gallery', 'upload', 'external']} 
                      onSelect={handleImageSelect} 
                      onCancel={() => showImageUploader = false} 
                    />
                  </div>
                {/if}
             </div>
          </div>
        </details>

        <details class="editor-drawer">
          <summary class="editor-drawer-header">
            References
            <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <div class="editor-drawer-content">
            <div class="references-section">
               <p class="section-label">References (Source Material)</p>
               <div class="references-list">
                  {#each formData.referenceIds as refId}
                    <div class="reference-badge">
                      <span class="ref-id">{refId}</span>
                      <button type="button" class="remove-ref-btn" onclick={() => removeReference(refId)}>×</button>
                    </div>
                  {/each}
                  {#if formData.referenceIds.length === 0}
                    <span class="no-refs">No references added.</span>
                  {/if}
               </div>
               <div class="add-reference-row">
                  <input type="text" bind:value={newReferenceId} placeholder="Enter existing Content ID or URL" />
                  <button type="button" onclick={addReference}>Add Reference</button>
               </div>
            </div>

            <div class="form-row">
              <label>
                URL:
                <input type="url" bind:value={formData.url} />
              </label>
              <label>
                File Key:
                <input type="text" bind:value={formData.fileKey} />
              </label>
            </div>
          </div>
        </details>

        <details class="editor-drawer" open>
          <summary class="editor-drawer-header">
            Metadata
            <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <div class="editor-drawer-content">
            <div class="form-row">
              <label>
                Type:
                <select bind:value={formData.type}>
                  <option value="article">Article</option>
                  <option value="document">Document</option>
                  <option value="mirror">Mirror</option>
                </select>
              </label>
              <label>
                Status:
                <select bind:value={formData.status}>
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <label>
                State:
                <select bind:value={formData.state}>
                  <option value="active">Active</option>
                  <option value="highlighted">Highlighted</option>
                  <option value="deprecated">Deprecated</option>
                </select>
              </label>
              <label>
                Author:
                <input type="text" bind:value={formData.author} />
              </label>
            </div>

            <label class="form-row-block">
              Description:
              <input type="text" bind:value={formData.description} />
            </label>

            <label class="form-row-block">
              Tags (Comma separated):
              <input type="text" placeholder="e.g. news, tech, updates" />
            </label>
        </div>
      </details>

    </div>

    <!-- RIGHT COLUMN -->
    <div class="editor-sidebar-col">

        <div class="chat-sidebar-section">
          <ContentAgentChat 
            {contentId}
            {currentEditorState}
            {currentReferenceIds}
            formFields={{ title: formData.title, description: formData.description, type: formData.type, status: formData.status, state: formData.state, body: formData.body }}
            onapplyfields={applyFieldUpdates}
            onclose={() => { /* optional close handler */ }}
          />
        </div>
      </div>
    </div>
</div>

<style>
  .form-container {
    background: var(--smrt-color-surface);
    border-radius: 1rem;
    padding: 2rem;
    width: 100%;
    margin: 0 auto;
    box-shadow: var(--smrt-elevation-2, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
  }

  .editor-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
    align-items: start;
    width: 100%;
  }

  @media (min-width: 1024px) {
    .editor-grid {
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    }
  }

  .editor-main-col {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .editor-sidebar-col {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    position: sticky;
    top: 2rem;
  }

  .editor-drawer {
    margin: 0 0 2rem 0;
    padding: 0;
  }

  .editor-drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0 1.25rem 0;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    list-style: none; /* Hide default triangle */
    user-select: none;
    transition: color 0.2s;
    margin: 0;
  }
  
  /* Hide the default details marker */
  .editor-drawer-header::-webkit-details-marker {
    display: none;
  }

  .editor-drawer-header:hover {
    color: var(--smrt-color-primary);
  }

  .drawer-icon {
    color: var(--smrt-color-outline);
    transition: transform 0.3s ease;
  }

  .editor-drawer[open] .drawer-icon {
    transform: rotate(180deg);
  }

  .editor-drawer-content {
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .chat-sidebar-section {
    height: 600px;
    background: var(--smrt-color-surface);
    border-radius: 1rem;
    border: 1px solid var(--smrt-color-outline-variant);
    overflow: hidden;
  }

  .form-container h3 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 1.5rem;
  }
  
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }



  .form-container form {
    display: block;
    width: 100%;
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1.25rem;
  }

  .form-container label {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--smrt-color-on-surface-variant);
    font-weight: 500;
    font-size: 0.875rem;
  }

  .form-container input,
  .form-container select,
  .form-container textarea {
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.5rem;
    font-size: 0.875rem;
    transition: border-color 0.2s, box-shadow 0.2s;
    font-family: inherit;
    box-sizing: border-box;
    width: 100%;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }

  .form-container input:focus,
  .form-container select:focus,
  .form-container textarea:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .form-container textarea {
    resize: vertical;
    min-height: 120px;
  }
  
  .references-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--smrt-color-surface-container-low);
    border: 1px solid var(--smrt-color-outline-variant);
    padding: 1rem;
    border-radius: 0.5rem;
  }

  .section-label {
    margin: 0;
    font-weight: 600;
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .references-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .reference-badge {
    display: flex;
    align-items: center;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline);
    border-radius: 999px;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface);
  }

  .remove-ref-btn {
    background: none;
    border: none;
    color: var(--smrt-color-outline);
    cursor: pointer;
    font-size: 1.125rem;
    line-height: 1;
    padding: 0 0.25rem;
    margin-left: 0.25rem;
  }

  .remove-ref-btn:hover {
    color: var(--smrt-color-error);
  }

  .no-refs {
    color: var(--smrt-color-outline);
    font-size: 0.875rem;
    font-style: italic;
  }

  .add-reference-row {
    display: flex;
    gap: 0.5rem;
  }
  
  .add-reference-row input {
    flex: 1;
  }

  .add-reference-row button {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline);
    color: var(--smrt-color-on-surface-variant);
    padding: 0 1rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-weight: 500;
  }

  .add-reference-row button:hover {
    background: #f1f5f9;
  }
  
  .add-image-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--smrt-color-surface, white);
    border: 1px solid var(--smrt-color-outline, #cbd5e1);
    padding: 0.75rem 1.25rem;
    border-radius: var(--smrt-radius-md, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #475569);
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .add-image-btn:hover {
    border-color: var(--smrt-color-primary, #94a3b8);
    color: var(--smrt-color-on-surface, #1e293b);
    background: var(--smrt-color-surface-container-low, #f1f5f9);
  }

  .form-actions {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
    padding-top: 1.5rem;
    border-top: 1px solid #e5e7eb;
  }

  .save-button {
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .save-button:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.4);
  }

  .cancel-button {
    background: white;
    color: #475569;
    border: 1px solid #cbd5e1;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .cancel-button:hover {
    background: #f8fafc;
    color: #1e293b;
    border-color: #94a3b8;
  }
  
  .inline-uploader-container {
    width: 100%;
    min-height: 400px; /* Reduced for inline view */
    max-height: 60vh;
    overflow-y: auto;
    background: white;
    border: 1px solid #e2e8f0;
    margin-top: 1rem;
    border-radius: 0.75rem;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
    /* Svelte built-in slide animations will be handled if implemented */
  }

  .undo-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    background: linear-gradient(135deg, #eff6ff 0%, #e0f2fe 100%);
    border: 1px solid #93c5fd;
    border-radius: 0.5rem;
    animation: undo-slide-in 0.3s ease-out;
  }

  @keyframes undo-slide-in {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .undo-banner__text {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--smrt-color-primary);
  }

  .undo-banner__text svg {
    flex-shrink: 0;
  }

  .undo-banner__btn {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-primary);
    border: 1px solid var(--smrt-color-outline);
    padding: 0.375rem 0.875rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
  }

  .undo-banner__btn:hover {
    background: var(--smrt-color-surface-variant);
    border-color: var(--smrt-color-primary);
  }

  /* Media Gallery */
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.75rem;
  }

  .media-item {
    position: relative;
    border-radius: 0.5rem;
    overflow: hidden;
    border: 2px solid transparent;
    background: var(--smrt-color-surface-container-high, #242424);
    transition: border-color 0.2s;
  }

  .media-item.is-thumbnail {
    border-color: var(--smrt-color-primary, #3b82f6);
  }

  .media-item-image {
    width: 100%;
    height: 120px;
    object-fit: cover;
    display: block;
  }

  .media-item-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.5);
    opacity: 0;
    transition: opacity 0.2s;
  }

  .media-item:hover .media-item-overlay {
    opacity: 1;
  }

  .media-item-overlay button {
    padding: 0.4rem;
    border: none;
    border-radius: 0.375rem;
    background: rgba(255,255,255,0.9);
    color: #1e293b;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .media-item-overlay button:hover {
    transform: scale(1.1);
    background: white;
  }

  .btn-remove-asset:hover {
    background: #fef2f2 !important;
    color: #dc2626 !important;
    border-color: #fecaca !important;
  }

  .thumbnail-badge {
    position: absolute;
    top: 0.25rem;
    left: 0.25rem;
    background: var(--smrt-color-primary, #3b82f6);
    color: white;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
</style>
