<script lang="ts">
import type { ImageLike } from '@happyvertical/smrt-images/svelte';
import { ImageUploader } from '@happyvertical/smrt-images/svelte';
import type {
  FactAuditResourceClaimData,
  FactAuditStateData,
} from '../../mock-smrt-client';
import { joinApiUrl, normalizeApiBaseUrl } from '../api';
import ContentAgentChat from './ContentAgentChat.svelte';

let {
  apiBaseUrl = '/api/v1',
  content = undefined,
  contentId = 'new',
  factAudit = null,
  saveDisabled = false,
  saveNotice = null,
  agentChatEnabled = true,
  agentChatNotice = null,
  hideActions = false,
  hideChat = false,
  onChange = undefined,
  onSave,
  onCancel,
} = $props<{
  apiBaseUrl?: string;
  content?: any;
  contentId?: string;
  factAudit?: FactAuditStateData | null;
  saveDisabled?: boolean;
  saveNotice?: string | null;
  agentChatEnabled?: boolean;
  agentChatNotice?: string | null;
  hideActions?: boolean;
  hideChat?: boolean;
  onChange?: (data: any) => void;
  onSave: (data: any) => void;
  onCancel: () => void;
}>();

let editForm = $state<HTMLFormElement | null>(null);

function formatDateTimeLocal(value: unknown): string {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' ? value : '';
  }

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function normalizePublishDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  return null;
}

function getSavePayload(data: any) {
  const { references: _references, ...payload } = data;

  return {
    ...payload,
    publish_date: normalizePublishDate(data.publish_date),
  };
}

export function triggerSave() {
  if (saveDisabled) return;
  if (editForm?.requestSubmit) {
    editForm.requestSubmit();
    return;
  }

  onSave(getSavePayload(formData));
}

function getInitialFormData(c: any) {
  return c
    ? {
        ...c,
        tags: c.tags || [],
        referenceIds: c.referenceIds || [],
        references: c.references || [],
        assetIds: c.assetIds || [],
        assets: c.assets || [],
        publish_date: formatDateTimeLocal(c.publish_date ?? c.publishDate),
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
        publish_date: '',
        thumbnailAssetId: null,
        tags: [],
        referenceIds: [],
        references: [],
        assetIds: [],
        assets: [],
      };
}

let formData = $state<any>(getInitialFormData(undefined));
let lastContentKey = $state<string | undefined>(undefined);
let currentEditorState = $derived(formData.body || '');
let currentReferenceIds = $derived(formData.referenceIds || []);
const editorSnapshot = $derived({
  ...getSavePayload(formData),
  referenceIds: [...(formData.referenceIds || [])],
  references: [...(formData.references || [])],
  assetIds: [...(formData.assetIds || [])],
  assets: [...(formData.assets || [])],
});
const showActions = $derived(!hideActions);
const showChatSidebar = $derived(!hideChat);
const showAgentChat = $derived(agentChatEnabled && showChatSidebar);
const agentChatContentId = $derived(content?.id ?? contentId);
const agentChatFields = $derived({
  title: formData.title,
  description: formData.description,
  type: formData.type,
  status: formData.status,
  state: formData.state,
  publish_date: normalizePublishDate(formData.publish_date) || '',
  body: formData.body,
});

// Undo stack for AI field edits — each entry stores the old values of changed fields
let fieldUndoStack = $state<Record<string, string>[]>([]);
let lastAppliedFields = $state<string[]>([]);
let showUndoBanner = $state(false);

// When content prop changes from outside (different item), reset formData.
$effect(() => {
  const newKey = content?.id ?? contentId;
  if (newKey !== lastContentKey) {
    lastContentKey = newKey;
    formData = getInitialFormData(content);
    fieldUndoStack = [];
    showUndoBanner = false;
  }
});

$effect(() => {
  onChange?.(editorSnapshot);
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

function getReferenceLabel(reference: any): string {
  return (
    reference?.title ||
    reference?.name ||
    reference?.url ||
    reference?.source ||
    reference?.id ||
    'Reference'
  );
}

function getReferenceUrl(reference: any): string | null {
  return reference?.url || reference?.originalUrl || reference?.source || null;
}

function getResourceClaimsForReference(
  reference: any,
): FactAuditResourceClaimData[] {
  const referenceId = String(reference?.id || '');
  const referenceUrl = getReferenceUrl(reference) || '';
  const resourceClaims: FactAuditResourceClaimData[] =
    factAudit?.resourceClaims ?? [];

  return resourceClaims.filter((claim: FactAuditResourceClaimData) => {
    if (referenceId && claim.sourceId === referenceId) {
      return true;
    }

    return Boolean(referenceUrl && claim.sourceUrl === referenceUrl);
  });
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

// Drag-and-drop state
let imageDragOver = $state(false);
let refDragOver = $state(false);

function autoResize(node: HTMLTextAreaElement, _content: string) {
  function resize() {
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }
  resize();
  return {
    update() {
      resize();
    },
  };
}

function getImageRecord(payload: any) {
  return payload?.data ?? payload;
}

// ---------- Image drag-and-drop ----------
function handleImageDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  imageDragOver = true;
}

function handleImageDragLeave(e: DragEvent) {
  // Only leave if we're actually leaving the drop zone
  const relatedTarget = e.relatedTarget as Node | null;
  const currentTarget = e.currentTarget as Node;
  if (relatedTarget && currentTarget.contains(relatedTarget)) return;
  imageDragOver = false;
}

function handleImageDrop(e: DragEvent) {
  e.preventDefault();
  imageDragOver = false;
  if (!e.dataTransfer) return;

  // Handle dropped files (images)
  const files = Array.from(e.dataTransfer.files).filter((f) =>
    f.type.startsWith('image/'),
  );
  for (const file of files) {
    handleImageSelect(file);
  }

  // Handle dropped URLs
  const url =
    e.dataTransfer.getData('text/uri-list') ||
    e.dataTransfer.getData('text/plain');
  if (
    !files.length &&
    url &&
    (url.startsWith('http://') || url.startsWith('https://'))
  ) {
    handleImageSelect(url);
  }
}

// ---------- Reference drag-and-drop ----------
function handleRefDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  refDragOver = true;
}

function handleRefDragLeave(e: DragEvent) {
  const relatedTarget = e.relatedTarget as Node | null;
  const currentTarget = e.currentTarget as Node;
  if (relatedTarget && currentTarget.contains(relatedTarget)) return;
  refDragOver = false;
}

async function handleRefDrop(e: DragEvent) {
  e.preventDefault();
  refDragOver = false;
  if (!e.dataTransfer) return;

  // Handle dropped files — upload them as content and link as references
  const files = Array.from(e.dataTransfer.files);
  for (const file of files) {
    try {
      const resp = await fetch(joinApiUrl(apiBaseUrl, '/contents'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          title: file.name,
          type: 'document',
          status: 'draft',
          state: 'active',
          source: 'upload',
          fileKey: file.name,
          body: `Uploaded reference placeholder for ${file.name}. Local drag-and-drop creates a reference record but does not upload the file contents.`,
          metadata: {
            upload: {
              fileName: file.name,
              mimeType: file.type || 'application/octet-stream',
              size: file.size,
            },
          },
        }),
      });
      if (resp.ok) {
        const result = await resp.json();
        const newId = result.data?.id || result.id;
        if (newId && !formData.referenceIds.includes(newId)) {
          formData.referenceIds = [...formData.referenceIds, newId];
        }
      } else {
        console.error(
          '[ContentEditor] Failed to upload reference file:',
          await resp.text(),
        );
      }
    } catch (err) {
      console.error('[ContentEditor] Error uploading reference file:', err);
    }
  }

  // Handle dropped URL or plain text (add as reference ID)
  if (files.length === 0) {
    const text =
      e.dataTransfer.getData('text/uri-list') ||
      e.dataTransfer.getData('text/plain');
    if (text) {
      const id = text.trim();
      if (id && !formData.referenceIds.includes(id)) {
        formData.referenceIds = [...formData.referenceIds, id];
      }
    }
  }
}

function handleSubmit(e: Event) {
  e.preventDefault();
  if (saveDisabled) {
    return;
  }
  onSave(getSavePayload(formData));
}

function handleCancel() {
  if (!showActions) {
    return;
  }

  onCancel();
}

function parseTagsInput(value: string) {
  formData.tags = value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function handleImageSelect(selected: ImageLike | File | string) {
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
        const resp = await fetch(joinApiUrl(apiBaseUrl, '/images'), {
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
        const resp = await fetch(joinApiUrl(apiBaseUrl, '/images'), {
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
  <div class="editor-grid" class:editor-grid--with-sidebar={showChatSidebar}>
    <!-- LEFT COLUMN (Document Canvas) -->
    <form
      bind:this={editForm}
      id="content-edit-form"
      class="editor-main-col"
      onsubmit={handleSubmit}
    >
      <div class="editor-toolbar">
        <div class="editor-toolbar-left">
          <div class="mui-field">
            <select id="type-select" bind:value={formData.type} class="mui-input">
              <option value="article">Article</option>
              <option value="document">Document</option>
              <option value="mirror">Mirror</option>
            </select>
            <label for="type-select">Type</label>
          </div>
          <div class="mui-field">
            <select id="state-select" bind:value={formData.state} class="mui-input">
              <option value="active">Active</option>
              <option value="highlighted">Highlighted</option>
              <option value="deprecated">Deprecated</option>
            </select>
            <label for="state-select">State</label>
          </div>
          <div class="mui-field">
            <select id="status-select" bind:value={formData.status} class="mui-input">
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
            <label for="status-select">Status</label>
          </div>
          <div class="mui-field">
            <input id="publish-date-input" type="datetime-local" bind:value={formData.publish_date} class="mui-input" />
            <label for="publish-date-input">Publish Date</label>
          </div>
        </div>
        {#if showActions}
          <div class="editor-toolbar-right">
            <button type="submit" class="save-button" disabled={saveDisabled}>{content ? 'Update Content' : 'Save Content'}</button>
            <button type="button" class="cancel-button" onclick={handleCancel}>
              Cancel
            </button>
          </div>
        {/if}
      </div>

      {#if saveNotice}
        <p class="save-notice">{saveNotice}</p>
      {/if}

      <input 
         type="text" 
         class="document-title-input" 
         bind:value={formData.title} 
         placeholder="Document title..."
         required 
      />

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

      <textarea 
         id="content-body-input" 
         class="document-body-input" 
         bind:value={formData.body} 
         use:autoResize={formData.body}
         placeholder="Start writing..." 
         style="overflow: hidden;"
      ></textarea>

      <!-- Metadata Panel -->
      <details class="editor-drawer" open>
        <summary class="editor-drawer-header">
          Metadata
          <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </summary>
        <div class="editor-drawer-content">
          <label>
            Author:
            <input type="text" bind:value={formData.author} placeholder="Author name" />
          </label>
          <label>
            Description:
            <textarea bind:value={formData.description} rows="2" placeholder="Brief summary..."></textarea>
          </label>
          <label>
            Tags (Comma separated):
            <input
              type="text"
              value={(formData.tags || []).join(', ')}
              placeholder="e.g. news, tech"
              oninput={(event) => parseTagsInput((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
      </details>

      <!-- Images & Media -> Metadata Drawer -->
      <details class="editor-drawer" open>
          <summary class="editor-drawer-header">
            Images & Media
            <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="editor-drawer-content drop-zone"
            class:drop-zone-active={imageDragOver}
            ondragover={handleImageDragOver}
            ondragleave={handleImageDragLeave}
            ondrop={handleImageDrop}
          >
             {#if imageDragOver}
               <div class="drop-overlay">
                 <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
               </div>
             {/if}
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
                  <p class="no-media-text">No images attached.</p>
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
                  <div class="inline-uploader-container">
                    <ImageUploader 
                      apiBaseUrl={normalizeApiBaseUrl(apiBaseUrl)}
                      allowedTabs={['gallery', 'upload', 'external']} 
                      onSelect={handleImageSelect} 
                      onCancel={() => showImageUploader = false} 
                    />
                  </div>
                {/if}
             </div>
          </div>
      </details>

      <!-- References Panel -->
      <details class="editor-drawer" open>
          <summary class="editor-drawer-header">
            References
            <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="editor-drawer-content drop-zone"
            class:drop-zone-active={refDragOver}
            ondragover={handleRefDragOver}
            ondragleave={handleRefDragLeave}
            ondrop={handleRefDrop}
          >
            {#if refDragOver}
              <div class="drop-overlay">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              </div>
            {/if}
            <div class="references-section">
               <div class="references-list">
                  {#each formData.referenceIds as refId}
                    <div class="reference-badge">
                      <span class="ref-id">{refId}</span>
                      <button type="button" class="remove-ref-btn" onclick={() => removeReference(refId)}>×</button>
                    </div>
                  {/each}
                  {#if formData.referenceIds.length === 0}
                    <span class="no-refs">No references.</span>
                  {/if}
               </div>
               {#if formData.references?.length > 0}
                 <div class="reference-detail-list">
                   {#each formData.references as reference (reference.id ?? reference.url ?? reference.title)}
                     {@const resourceClaims = getResourceClaimsForReference(reference)}
                     <div class="reference-detail">
                       <div class="reference-detail-header">
                         <div>
                           <strong>{getReferenceLabel(reference)}</strong>
                           {#if getReferenceUrl(reference)}
                             <a href={getReferenceUrl(reference) ?? undefined} target="_blank" rel="noreferrer">
                               {getReferenceUrl(reference)}
                             </a>
                           {/if}
                         </div>
                         <span>{resourceClaims.length} resource claim{resourceClaims.length === 1 ? '' : 's'}</span>
                       </div>
                       {#if resourceClaims.length > 0}
                         <div class="resource-claim-list">
                           {#each resourceClaims.slice(0, 6) as claim (claim.id ?? claim.quote ?? claim.fact?.textRefined)}
                             <div class="resource-claim">
                               <strong>{claim.fact?.textRefined || claim.fact?.textRaw || claim.quote}</strong>
                               {#if claim.quote}
                                 <span>{claim.quote}</span>
                               {/if}
                             </div>
                           {/each}
                           {#if resourceClaims.length > 6}
                             <span class="resource-claim-more">+ {resourceClaims.length - 6} more</span>
                           {/if}
                         </div>
                       {/if}
                     </div>
                   {/each}
                 </div>
               {/if}
               <div class="add-reference-row">
                  <input type="text" bind:value={newReferenceId} placeholder="Reference ID or URL" />
                  <button type="button" onclick={addReference}>Add</button>
               </div>
            </div>

            <label>
              URL:
              <input type="url" bind:value={formData.url} />
            </label>
            <label>
              File Key:
              <input type="text" bind:value={formData.fileKey} />
            </label>
          </div>
      </details>
    </form>

    {#if showChatSidebar}
      <aside class="editor-sidebar-col">
        <div class="chat-sidebar-section">
          {#if showAgentChat}
            <ContentAgentChat
              {apiBaseUrl}
              contentId={agentChatContentId}
              {currentEditorState}
              {currentReferenceIds}
              formFields={agentChatFields}
              onapplyfields={applyFieldUpdates}
              onclose={() => {}}
            />
          {:else}
            <div
              class="chat-sidebar-empty-state"
              data-testid="content-editor-agent-chat-disabled"
            >
              <h3>Agent chat unavailable</h3>
              <p>
                {agentChatNotice ||
                  'Run the content package dev server to use the agent chat sidebar for this editor.'}
              </p>
            </div>
          {/if}
        </div>
      </aside>
    {/if}
  </div>
</div>

<style>
  .form-container {
    width: 100%;
    margin: 0 auto;
    padding: 1rem 0;
  }

  .editor-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
    align-items: start;
    width: 100%;
  }

  @media (min-width: 1024px) {
    .editor-grid--with-sidebar {
      grid-template-columns: 1fr auto;
    }
    .editor-sidebar-col {
      width: 380px;
    }
  }

  .document-title-input {
    width: 100%;
    font-size: 2.5rem;
    font-weight: 800;
    line-height: 1.2;
    padding: 0;
    margin-bottom: 2rem;
    border: none;
    outline: none;
    background: transparent;
    color: var(--smrt-color-on-surface);
    resize: none;
    font-family: inherit;
  }

  .document-title-input::placeholder {
    color: var(--smrt-color-outline-variant);
  }

  .document-body-input {
    width: 100%;
    font-size: 1.125rem;
    line-height: 1.6;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--smrt-color-on-surface);
    resize: vertical;
    font-family: inherit;
    min-height: 60vh;
  }

  .document-body-input::placeholder {
    color: var(--smrt-color-outline-variant);
  }

  .editor-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 1.5rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .editor-toolbar-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .editor-toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .mui-field {
    position: relative;
    display: inline-flex;
    margin-top: 0.5rem;
  }

  .mui-field label {
    position: absolute;
    top: -0.5rem;
    left: 0.5rem;
    background: var(--smrt-color-surface); /* Matches main surface background */
    padding: 0 0.25rem;
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--smrt-color-outline);
    pointer-events: none;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    z-index: 1;
  }

  .mui-input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid var(--smrt-color-outline-variant);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font-size: 0.8125rem;
    font-weight: 500;
    width: auto;
    font-family: inherit;
    box-sizing: border-box;
    transition: border-color 0.2s;
  }

  .mui-input:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
  }

  .editor-main-col {
    display: flex;
    flex-direction: column;
    background: transparent;
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

  .chat-sidebar-empty-state {
    display: grid;
    gap: 0.75rem;
    align-content: start;
    padding: 1.25rem;
    height: 100%;
    box-sizing: border-box;
    background: var(--smrt-color-surface-container-low, #f8fafc);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .chat-sidebar-empty-state h3,
  .chat-sidebar-empty-state p {
    margin: 0;
  }

  .form-container h3 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 1.5rem;
  }

  .form-container form {
    display: block;
    width: 100%;
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

  .reference-detail-list,
  .resource-claim-list {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .reference-detail {
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    border-radius: 0.5rem;
    padding: 0.75rem;
  }

  .reference-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    color: var(--smrt-color-on-surface);
  }

  .reference-detail-header div,
  .resource-claim {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .reference-detail-header a,
  .reference-detail-header span,
  .resource-claim span,
  .resource-claim-more {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.8125rem;
  }

  .resource-claim-list {
    margin-top: 0.75rem;
  }

  .resource-claim {
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 0.65rem;
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

  .save-button:disabled {
    opacity: 0.65;
    transform: none;
    box-shadow: none;
  }

  .cancel-button {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    padding: 0.75rem 1.25rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
  }

  .save-notice {
    font-size: 0.875rem;
    color: var(--smrt-color-primary, #3b82f6);
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

  /* ── Drag & Drop Zones ── */
  .drop-zone {
    position: relative;
    transition: border-color 0.2s, background 0.2s;
    border: 2px dashed var(--smrt-color-outline-variant, #e2e8f0);
    border-radius: 0.75rem;
    padding: 1.5rem;
  }

  .drop-zone-active {
    border-color: var(--smrt-color-primary, #3b82f6);
    background: color-mix(in srgb, var(--smrt-color-primary, #3b82f6) 6%, transparent);
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: color-mix(in srgb, var(--smrt-color-primary, #3b82f6) 12%, var(--smrt-color-surface, white) 88%);
    border-radius: 0.5rem;
    pointer-events: none;
    animation: drop-pulse 0.3s ease-out;
  }

  .drop-overlay svg {
    color: var(--smrt-color-primary, #3b82f6);
    opacity: 0.8;
  }

  @keyframes drop-pulse {
    from { opacity: 0; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
  }
</style>
