<script lang="ts">
import type { ImageLike } from '@happyvertical/smrt-images/svelte';
import { ImageUploader } from '@happyvertical/smrt-images/svelte';
import { untrack } from 'svelte';
import { extractBodyImages, resolveBodyFormat } from '../../body-format';
import type {
  ContentEditorAssistantActions,
  ContentEditorAssistantContextChange,
  ContentEditorAssistantFieldUpdateAllowList,
  ContentEditorAssistantRegistration,
} from '../../content-editor-assistant';
import {
  createContentEditorAssistantContext,
  sanitizeContentEditorAssistantFieldUpdates,
} from '../../content-editor-assistant';
import type {
  FactAuditResourceClaimData,
  FactAuditStateData,
  FactEvidenceStatus,
} from '../../mock-smrt-client';
import { joinApiUrl, normalizeApiBaseUrl } from '../api';
import {
  type ContentEditorFormData,
  getContentEditorInitialFormData,
  getContentEditorSavePayload,
  getContentEditorSnapshot,
  normalizePublishDate,
} from '../content-editor-form';
import ContentAgentChat from './ContentAgentChat.svelte';
import ContentBodyEditor, {
  type ContentBodyEditorChange,
} from './ContentBodyEditor.svelte';
import ContentImageChooser from './ContentImageChooser.svelte';

export interface Props {
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
  assistantFieldAllowList?: ContentEditorAssistantFieldUpdateAllowList;
  onAssistantContextChange?: ContentEditorAssistantContextChange;
  onChange?: (data: any) => void;
  onFactAuditChange?: (state: FactAuditStateData | null) => void;
  onSave: (data: any) => void;
  onCancel: () => void;
}

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
  assistantFieldAllowList = {},
  onAssistantContextChange = undefined,
  onChange = undefined,
  onFactAuditChange = undefined,
  onSave,
  onCancel,
}: Props = $props();

let editForm = $state<HTMLFormElement | null>(null);

export function triggerSave() {
  if (saveDisabled) return;
  if (editForm?.requestSubmit) {
    editForm.requestSubmit();
    return;
  }

  onSave(getContentEditorSavePayload(formData));
}

let formData = $state<ContentEditorFormData>(
  getContentEditorInitialFormData(undefined),
);
let lastContentKey = $state<string | undefined>(undefined);
let currentEditorState = $derived(formData.body || '');
let currentReferenceIds = $derived(formData.referenceIds || []);
const editorSnapshot = $derived(getContentEditorSnapshot(formData));
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
  bodyFormat: formData.bodyFormat || '',
});
const assistantContext = $derived(
  createContentEditorAssistantContext({
    contentId: agentChatContentId,
    title: agentChatFields.title,
    editorKind: 'content',
    fields: agentChatFields,
    currentEditorState,
    referenceIds: currentReferenceIds,
  }),
);

// Undo stack for AI field edits — each entry stores the old values of changed fields
let fieldUndoStack = $state<Record<string, string>[]>([]);
let lastAppliedFields = $state<string[]>([]);
let showUndoBanner = $state(false);

const assistantActions: ContentEditorAssistantActions = {
  triggerSave,
  applyFieldUpdates,
  undoLastFieldUpdate: undoLastApply,
};
const assistantRegistration = $derived({
  context: assistantContext,
  actions: assistantActions,
});
let activeAssistantContextCallback:
  | ContentEditorAssistantContextChange
  | undefined;
let lastAssistantContextCallback:
  | ContentEditorAssistantContextChange
  | undefined;
let lastAssistantRegistration:
  | ContentEditorAssistantRegistration
  | null
  | undefined;

function publishAssistantRegistration(
  registration: ContentEditorAssistantRegistration | null,
) {
  const callback = activeAssistantContextCallback;
  if (!callback) {
    return;
  }

  if (
    callback === lastAssistantContextCallback &&
    registration === lastAssistantRegistration
  ) {
    return;
  }

  callback(registration);
  lastAssistantContextCallback = callback;
  lastAssistantRegistration = registration;
}

// When content prop changes from outside (different item), reset formData.
$effect(() => {
  const newKey = content?.id ?? contentId;
  if (newKey !== lastContentKey) {
    lastContentKey = newKey;
    formData = getContentEditorInitialFormData(content);
    fieldUndoStack = [];
    showUndoBanner = false;
  }
});

$effect(() => {
  onChange?.(editorSnapshot);
});

$effect(() => {
  const callback = onAssistantContextChange;
  activeAssistantContextCallback = callback;
  if (!callback) {
    lastAssistantContextCallback = undefined;
    lastAssistantRegistration = undefined;
    return;
  }

  publishAssistantRegistration(untrack(() => assistantRegistration));

  return () => {
    if (activeAssistantContextCallback === callback) {
      activeAssistantContextCallback = undefined;
    }
    if (lastAssistantContextCallback === callback) {
      lastAssistantContextCallback = undefined;
      lastAssistantRegistration = undefined;
    }
    callback(null);
  };
});

$effect(() => {
  const registration = assistantRegistration;
  untrack(() => publishAssistantRegistration(registration));
});

/** Called by ContentAgentChat when AI wants to update form fields */
function applyFieldUpdates(fields: Record<string, string>) {
  const safeFields = sanitizeContentEditorAssistantFieldUpdates(
    fields,
    assistantFieldAllowList,
  );
  if (Object.keys(safeFields).length === 0) {
    return;
  }

  // Snapshot old values for undo
  const oldValues: Record<string, string> = {};
  for (const key of Object.keys(safeFields)) {
    oldValues[key] = String(formData[key] ?? '');
    formData[key] = safeFields[key];
  }
  fieldUndoStack = [...fieldUndoStack, oldValues];
  lastAppliedFields = Object.keys(safeFields);
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
  const selector = getReferenceSourceSelector(reference);
  const referenceId = String(reference?.id || '');
  const referenceUrl = getReferenceUrl(reference) || '';
  const resourceClaims: FactAuditResourceClaimData[] =
    factAudit?.resourceClaims ?? [];

  return resourceClaims.filter((claim: FactAuditResourceClaimData) => {
    if (
      selector &&
      claim.sourceKind === selector.sourceKind &&
      claim.sourceId === selector.sourceId
    ) {
      return true;
    }

    if (referenceId && claim.sourceId === referenceId) {
      return true;
    }

    return Boolean(referenceUrl && claim.sourceUrl === referenceUrl);
  });
}

function getAuditReferences(): any[] {
  const references = [...(formData.references ?? [])];
  const seen = new Set<string>();

  for (const reference of references) {
    const selector = getReferenceSourceSelector(reference);
    const key = selector
      ? `${selector.sourceKind}:${selector.sourceId}`
      : `url:${getReferenceUrl(reference) || getReferenceLabel(reference)}`;
    seen.add(key);
  }

  for (const claim of factAudit?.resourceClaims ?? []) {
    const sourceKind = String(claim.sourceKind || '').trim();
    const sourceId = String(claim.sourceId || '').trim();
    if (!sourceKind || !sourceId) {
      continue;
    }

    const key = `${sourceKind}:${sourceId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    references.push({
      id: sourceId,
      title: claim.sourceTitle || claim.sourceUrl || sourceId,
      url: claim.sourceUrl || '',
      source: claim.sourceUrl || '',
      _auditOnly: true,
      _auditSourceKind: sourceKind,
      _auditSourceId: sourceId,
    });
  }

  return references;
}

function getReferenceExpansionKey(reference: any, index: number): string {
  return String(
    reference?.id ||
      reference?.url ||
      reference?.originalUrl ||
      reference?.title ||
      `reference-${index}`,
  );
}

function isReferenceClaimsExpanded(reference: any, index: number): boolean {
  return expandedReferenceClaimKeys.includes(
    getReferenceExpansionKey(reference, index),
  );
}

function toggleReferenceClaims(reference: any, index: number) {
  const key = getReferenceExpansionKey(reference, index);
  expandedReferenceClaimKeys = expandedReferenceClaimKeys.includes(key)
    ? expandedReferenceClaimKeys.filter((expandedKey) => expandedKey !== key)
    : [...expandedReferenceClaimKeys, key];
}

// We need a simple way to enter reference IDs or mock selecting them
let newReferenceId = $state('');
let selectedEvidenceIds = $state<string[]>([]);
let evidenceBusy = $state<string | null>(null);
let evidenceError = $state<string | null>(null);
let evidenceNotice = $state<string | null>(null);
let bulkEvidenceStatus = $state<FactEvidenceStatus>('supports');
const evidenceStatuses: FactEvidenceStatus[] = [
  'supports',
  'contradicts',
  'unclear',
  'irrelevant',
  'invalid',
];
const selectedEvidenceCount = $derived(selectedEvidenceIds.length);
const auditReferences = $derived(getAuditReferences());

function addReference() {
  if (newReferenceId && !formData.referenceIds.includes(newReferenceId)) {
    formData.referenceIds = [...formData.referenceIds, newReferenceId];
    newReferenceId = '';
  }
}

function getResourceClaimEvidenceIds(
  claim: FactAuditResourceClaimData,
): string[] {
  return (claim.evidence ?? [])
    .map((evidence) => evidence.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function getResourceClaimKey(
  claim: FactAuditResourceClaimData,
  index: number,
): string {
  const firstEvidence = claim.evidence?.[0];
  return (
    firstEvidence?.id ||
    firstEvidence?.evidenceKey ||
    [
      claim.id,
      claim.sourceKind,
      claim.sourceId,
      claim.quote,
      claim.fact?.textRefined,
    ]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      )
      .join(':') ||
    `resource-claim-${index}`
  );
}

function isResourceClaimSelected(claim: FactAuditResourceClaimData): boolean {
  const evidenceIds = getResourceClaimEvidenceIds(claim);
  return (
    evidenceIds.length > 0 &&
    evidenceIds.every((id) => selectedEvidenceIds.includes(id))
  );
}

function toggleResourceClaimSelection(claim: FactAuditResourceClaimData) {
  const evidenceIds = getResourceClaimEvidenceIds(claim);
  if (evidenceIds.length === 0) {
    return;
  }

  const selected = isResourceClaimSelected(claim);
  selectedEvidenceIds = selected
    ? selectedEvidenceIds.filter((id) => !evidenceIds.includes(id))
    : [...new Set([...selectedEvidenceIds, ...evidenceIds])];
}

function getReferenceSourceSelector(reference: any): {
  sourceKind: string;
  sourceId: string;
} | null {
  const sourceId = String(
    reference?._auditSourceId || reference?.id || '',
  ).trim();
  const sourceKind = String(
    reference?._auditSourceKind || 'content-reference',
  ).trim();
  return sourceId
    ? {
        sourceKind,
        sourceId,
      }
    : null;
}

function getSelectedReferenceSourceSelectors(): Array<{
  sourceKind: string;
  sourceId: string;
}> {
  const selected = new Set(selectedEvidenceIds);
  const selectors: Array<{ sourceKind: string; sourceId: string }> = [];
  const seen = new Set<string>();

  for (const reference of getAuditReferences()) {
    const selector = getReferenceSourceSelector(reference);
    if (!selector) {
      continue;
    }

    const hasSelectedEvidence = getResourceClaimsForReference(reference).some(
      (claim) =>
        getResourceClaimEvidenceIds(claim).some((id) => selected.has(id)),
    );
    const selectorKey = `${selector.sourceKind}:${selector.sourceId}`;
    if (hasSelectedEvidence && !seen.has(selectorKey)) {
      seen.add(selectorKey);
      selectors.push(selector);
    }
  }

  return selectors;
}

function getEvidenceStatusIcon(status: FactEvidenceStatus | null | undefined) {
  switch (status) {
    case 'supports':
      return '✓';
    case 'contradicts':
      return '×';
    case 'irrelevant':
      return '⊘';
    case 'invalid':
      return '!';
    default:
      return '?';
  }
}

async function runFactAuditAction(
  path: string,
  method: 'POST' | 'PUT',
  body: Record<string, any>,
): Promise<FactAuditStateData> {
  if (!contentId || contentId === 'new') {
    throw new Error('Save this content before updating evidence.');
  }

  const response = await fetch(
    joinApiUrl(apiBaseUrl, `/contents/${contentId}/fact-audit/${path}`),
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || response.statusText);
  }

  return (payload.data ?? payload.result ?? payload) as FactAuditStateData;
}

async function updateEvidenceStatus(
  evidenceIds: string[],
  status: FactEvidenceStatus,
) {
  if (evidenceIds.length === 0 || evidenceBusy) {
    return;
  }

  evidenceBusy = 'status';
  evidenceError = null;
  evidenceNotice = null;

  try {
    const nextAudit = await runFactAuditAction('evidence/status', 'PUT', {
      evidenceIds,
      status,
    });
    selectedEvidenceIds = selectedEvidenceIds.filter(
      (id) => !evidenceIds.includes(id),
    );
    evidenceNotice = `Updated ${evidenceIds.length} evidence item${evidenceIds.length === 1 ? '' : 's'}.`;
    onFactAuditChange?.(nextAudit);
  } catch (error: any) {
    evidenceError = error.message || 'Failed to update evidence status.';
  } finally {
    evidenceBusy = null;
  }
}

async function updateSelectedEvidenceStatus() {
  await updateEvidenceStatus(selectedEvidenceIds, bulkEvidenceStatus);
}

async function repairReferenceEvidence(reference: any) {
  const selector = getReferenceSourceSelector(reference);
  if (!selector || evidenceBusy) {
    return;
  }

  evidenceBusy = `repair:${selector.sourceId}`;
  evidenceError = null;
  evidenceNotice = null;

  try {
    const nextAudit = await runFactAuditAction('evidence/repair', 'POST', {
      sources: [selector],
    });
    selectedEvidenceIds = [];
    evidenceNotice = 'Reference evidence repaired.';
    onFactAuditChange?.(nextAudit);
  } catch (error: any) {
    evidenceError = error.message || 'Failed to repair reference evidence.';
  } finally {
    evidenceBusy = null;
  }
}

async function repairSelectedReferenceEvidence() {
  const sources = getSelectedReferenceSourceSelectors();
  if (sources.length === 0 || evidenceBusy) {
    return;
  }

  evidenceBusy = 'repair-selected';
  evidenceError = null;
  evidenceNotice = null;

  try {
    const nextAudit = await runFactAuditAction('evidence/repair', 'POST', {
      sources,
    });
    selectedEvidenceIds = [];
    evidenceNotice = `Repaired ${sources.length} reference${sources.length === 1 ? '' : 's'}.`;
    onFactAuditChange?.(nextAudit);
  } catch (error: any) {
    evidenceError = error.message || 'Failed to repair selected references.';
  } finally {
    evidenceBusy = null;
  }
}

function removeReference(id: string) {
  formData.referenceIds = formData.referenceIds.filter(
    (refId: string) => refId !== id,
  );
}

// AI Authoring State (Migrated to ContentAgentChat Sidebar)

let showImageUploader = $state(false);
let showInlineImageUploader = $state(false);
let expandedReferenceClaimKeys = $state<string[]>([]);
let bodyEditor = $state<any>(null);
let selectedBodyImageIndex = $state(-1);
const bodyImages = $derived(
  extractBodyImages(
    formData.body || '',
    resolveBodyFormat(formData.bodyFormat, formData.body),
  ),
);

// Drag-and-drop state
let imageDragOver = $state(false);
let refDragOver = $state(false);

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
      }
    } catch (err) {}
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
  onSave(getContentEditorSavePayload(formData));
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

function handleBodyChange(change: ContentBodyEditorChange) {
  formData.body = change.body;
  formData.bodyFormat = change.bodyFormat;
  if (change.images.length === 0) {
    selectedBodyImageIndex = -1;
  } else if (selectedBodyImageIndex >= change.images.length) {
    selectedBodyImageIndex = change.images.length - 1;
  }
}

function focusBodyImage(index: number) {
  selectedBodyImageIndex = index;
  bodyEditor?.focusImage?.(index);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target?.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function createImageRecord(input: {
  name: string;
  sourceUri: string;
  mimeType: string;
}): Promise<any | null> {
  const resp = await fetch(joinApiUrl(apiBaseUrl, '/images'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!resp.ok) {
    throw new Error(await resp.text());
  }

  return getImageRecord(await resp.json());
}

async function resolveSelectedImage(
  selected: ImageLike | File | string,
): Promise<any | null> {
  if (selected && typeof selected === 'object' && 'id' in selected) {
    addSelectedAsset(selected);
    return selected;
  }

  if (selected instanceof File) {
    const asset = await createImageRecord({
      name: selected.name || 'Uploaded Image',
      sourceUri: await readFileAsDataUrl(selected),
      mimeType: selected.type || 'image/png',
    });
    if (asset) {
      addSelectedAsset(asset);
    }
    return asset;
  }

  if (typeof selected === 'string') {
    const parsedUrl = new URL(selected);
    const asset = await createImageRecord({
      name: parsedUrl.pathname.split('/').pop() || 'External Image',
      sourceUri: selected,
      mimeType: 'image/jpeg',
    });
    if (asset) {
      addSelectedAsset(asset);
    }
    return asset;
  }

  return null;
}

function handleImageSelect(selected: ImageLike | File | string) {
  void (async () => {
    try {
      await resolveSelectedImage(selected);
    } catch (err) {
    } finally {
      showImageUploader = false;
    }
  })();
}

function getAssetImageSource(asset: any): string {
  return String(asset?.sourceUri || asset?.url || asset?.src || '');
}

function handleAttachedImageDragStart(event: DragEvent, asset: any) {
  if (!event.dataTransfer) {
    return;
  }

  const source = getAssetImageSource(asset);
  const payload = {
    ...asset,
    sourceUri: asset?.sourceUri || source,
  };

  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    'application/x-smrt-image',
    JSON.stringify(payload),
  );
  if (source) {
    event.dataTransfer.setData('text/uri-list', source);
    event.dataTransfer.setData('text/plain', source);
  }
}

async function handleInlineImageSelect(selected: ImageLike | File | string) {
  try {
    const asset = await resolveSelectedImage(selected);
    if (asset) {
      bodyEditor?.insertImageAsset?.(asset);
      selectedBodyImageIndex = Math.max(bodyImages.length, 0);
    }
  } catch (err) {
  } finally {
    showInlineImageUploader = false;
  }
}

async function resolveBodyDropImage(selected: ImageLike | File | string) {
  try {
    return await resolveSelectedImage(selected);
  } catch (err) {
    return null;
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

      <div class="document-body-section">
        <ContentBodyEditor
          bind:this={bodyEditor}
          value={formData.body || ''}
          format={formData.bodyFormat}
          selectedImageIndex={selectedBodyImageIndex}
          onChange={handleBodyChange}
          onOpenImageChooser={() => showInlineImageUploader = !showInlineImageUploader}
          onSelectImage={(index) => selectedBodyImageIndex = index}
          onUseImageAsThumbnail={setThumbnail}
          onResolveImage={resolveBodyDropImage}
        />

        <div class="document-body-media-row">
          <ContentImageChooser
            body={formData.body || ''}
            format={formData.bodyFormat}
            selectedIndex={selectedBodyImageIndex}
            onSelect={focusBodyImage}
          />
        </div>

        {#if showInlineImageUploader}
          <div class="inline-uploader-container body-inline-uploader">
            <ImageUploader
              apiBaseUrl={normalizeApiBaseUrl(apiBaseUrl)}
              allowedTabs={['gallery', 'upload', 'external']}
              enableDragToEditor={true}
              onSelect={(selected) => void handleInlineImageSelect(selected)}
              onCancel={() => showInlineImageUploader = false}
            />
          </div>
        {/if}
      </div>

      <!-- Images & Media -->
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
                    {#each formData.assets as asset, index (asset.id || `asset-${index}`)}
                      {@const assetId = typeof asset.id === 'string' ? asset.id : ''}
                      <div
                        class="media-item"
                        class:is-thumbnail={assetId === formData.thumbnailAssetId}
                        draggable="true"
                        title="Drag into the body"
                        ondragstart={(event) => handleAttachedImageDragStart(event, asset)}
                      >
                        <img class="media-item-image" src={getAssetImageSource(asset)} alt={asset.name || 'Asset image'} />
                        <div class="media-item-overlay">
                           {#if assetId && assetId !== formData.thumbnailAssetId}
                             <button type="button" class="btn-make-thumbnail" title="Make Thumbnail" onclick={() => setThumbnail(assetId)}>
                               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                             </button>
                           {/if}
                           {#if assetId}
                             <button type="button" class="btn-remove-asset" title="Remove" onclick={() => removeAsset(assetId)}>
                               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                             </button>
                           {/if}
                        </div>
                        {#if assetId === formData.thumbnailAssetId}
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
                  {#if formData.referenceIds.length === 0 && auditReferences.length === 0}
                    <span class="no-refs">No references.</span>
                  {/if}
               </div>
               {#if auditReferences.length > 0}
                 <div class="reference-detail-list">
                   {#if evidenceError}
                     <p class="evidence-message evidence-message--error">{evidenceError}</p>
                   {/if}
                   {#if evidenceNotice}
                     <p class="evidence-message evidence-message--notice">{evidenceNotice}</p>
                   {/if}
                   <div class="evidence-bulk-toolbar">
                     <span>{selectedEvidenceCount} evidence item{selectedEvidenceCount === 1 ? '' : 's'} selected</span>
                     <select bind:value={bulkEvidenceStatus} disabled={selectedEvidenceCount === 0 || Boolean(evidenceBusy)}>
                       {#each evidenceStatuses as status}
                         <option value={status}>{status}</option>
                       {/each}
                     </select>
                     <button
                       type="button"
                       disabled={selectedEvidenceCount === 0 || Boolean(evidenceBusy)}
                       onclick={() => void updateSelectedEvidenceStatus()}
                     >
                       Mark
                     </button>
                     <button
                       type="button"
                       disabled={selectedEvidenceCount === 0 || Boolean(evidenceBusy)}
                       onclick={() => void repairSelectedReferenceEvidence()}
                     >
                       Repair resources
                     </button>
                   </div>
                   {#each auditReferences as reference, referenceIndex (reference._auditSourceId ?? reference.id ?? reference.url ?? reference.title)}
                     {@const resourceClaims = getResourceClaimsForReference(reference)}
                     {@const resourceClaimsExpanded = isReferenceClaimsExpanded(reference, referenceIndex)}
                     {@const visibleResourceClaims = resourceClaimsExpanded ? resourceClaims : resourceClaims.slice(0, 6)}
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
                         <div class="reference-detail-actions">
                           <span>{resourceClaims.length} evidence claim{resourceClaims.length === 1 ? '' : 's'}</span>
                           <button
                             type="button"
                             disabled={Boolean(evidenceBusy)}
                             onclick={() => void repairReferenceEvidence(reference)}
                           >
                             {evidenceBusy === `repair:${reference.id}` ? 'Repairing...' : 'Repair'}
                           </button>
                         </div>
                       </div>
                       {#if resourceClaims.length > 0}
                         <div class="resource-claim-list">
                           {#each visibleResourceClaims as claim, claimIndex (getResourceClaimKey(claim, claimIndex))}
                             {@const evidenceIds = getResourceClaimEvidenceIds(claim)}
                             <details class="resource-claim">
                               <summary>
                                 <label class="evidence-select">
                                   <input
                                     type="checkbox"
                                     checked={isResourceClaimSelected(claim)}
                                     disabled={evidenceIds.length === 0}
                                     onchange={() => toggleResourceClaimSelection(claim)}
                                   />
                                   <span class={`evidence-status evidence-status--${claim.status || 'supports'}`}>
                                     {getEvidenceStatusIcon(claim.status)}
                                   </span>
                                 </label>
                                 <strong>{claim.fact?.textRefined || claim.fact?.textRaw || claim.quote}</strong>
                               </summary>
                               <div class="resource-claim-body">
                                 {#if claim.quote}
                                   <p>{claim.quote}</p>
                                 {/if}
                                 <dl>
                                   <div>
                                     <dt>Status</dt>
                                     <dd>{claim.status || 'supports'}</dd>
                                   </div>
                                   {#if claim.locator}
                                     <div>
                                       <dt>Locator</dt>
                                       <dd>{claim.locator}</dd>
                                     </div>
                                   {/if}
                                   {#if claim.sourceTitle}
                                     <div>
                                       <dt>Source</dt>
                                       <dd>{claim.sourceTitle}</dd>
                                     </div>
                                   {/if}
                                   {#if claim.confidence !== null && claim.confidence !== undefined}
                                     <div>
                                       <dt>Confidence</dt>
                                       <dd>{Math.round(claim.confidence * 100)}%</dd>
                                     </div>
                                   {/if}
                                 </dl>
                                 {#each claim.evidence ?? [] as evidence (evidence.id ?? evidence.evidenceKey)}
                                   <div class="evidence-detail">
                                     <span>{evidence.extractionMethod || 'extracted evidence'}</span>
                                     {#if evidence.quote}
                                       <p>{evidence.quote}</p>
                                     {/if}
                                   </div>
                                 {/each}
                                 <div class="resource-claim-actions">
                                   {#each evidenceStatuses as status}
                                     <button
                                       type="button"
                                       disabled={evidenceIds.length === 0 || Boolean(evidenceBusy)}
                                       onclick={() => void updateEvidenceStatus(evidenceIds, status)}
                                     >
                                       {status}
                                     </button>
                                   {/each}
                                 </div>
                               </div>
                             </details>
                           {/each}
                           {#if resourceClaims.length > 6}
                             <button
                               type="button"
                               class="resource-claim-more"
                               onclick={() => toggleReferenceClaims(reference, referenceIndex)}
                             >
                               {resourceClaimsExpanded ? 'Show fewer' : `+ ${resourceClaims.length - 6} more`}
                             </button>
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
              assistantContext={assistantContext}
              contentId={agentChatContentId}
              {currentEditorState}
              {currentReferenceIds}
              formFields={agentChatFields}
              {assistantFieldAllowList}
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
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    line-height: var(--smrt-typography-display-medium-line-height, 1.2);
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

  .document-body-section {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    margin-bottom: 2rem;
  }

  .document-body-media-row {
    display: flex;
    justify-content: flex-end;
    min-height: 2.75rem;
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
    font-size: var(--smrt-typography-label-small-size, 0.65rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-outline);
    pointer-events: none;
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
    z-index: 1;
  }

  .mui-input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid var(--smrt-color-outline-variant);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
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
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
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
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
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
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .form-container input,
  .form-container select,
  .form-container textarea {
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.5rem;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
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
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
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
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    color: var(--smrt-color-on-surface);
  }

  .remove-ref-btn {
    background: none;
    border: none;
    color: var(--smrt-color-outline);
    cursor: pointer;
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    line-height: 1;
    padding: 0 0.25rem;
    margin-left: 0.25rem;
  }

  .remove-ref-btn:hover {
    color: var(--smrt-color-error);
  }

  .no-refs {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
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
  .resource-claim summary {
    display: flex;
    gap: 0.25rem;
  }

  .reference-detail-header div {
    flex-direction: column;
  }

  .reference-detail-actions {
    align-items: flex-end;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    white-space: nowrap;
  }

  .reference-detail-actions button,
  .resource-claim-actions button,
  .evidence-bulk-toolbar button {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.375rem;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    padding: 0.25rem 0.5rem;
  }

  .reference-detail-actions button:disabled,
  .resource-claim-actions button:disabled,
  .evidence-bulk-toolbar button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .evidence-bulk-toolbar {
    align-items: center;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem;
  }

  .evidence-bulk-toolbar span,
  .evidence-message {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }

  .evidence-bulk-toolbar select {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.375rem;
    padding: 0.25rem 0.5rem;
  }

  .evidence-message {
    margin: 0;
  }

  .evidence-message--error {
    color: var(--smrt-color-error);
  }

  .evidence-message--notice {
    color: var(--smrt-color-primary);
  }

  .reference-detail-header a,
  .reference-detail-header span,
  .resource-claim-body,
  .resource-claim-more {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }

  .resource-claim-more {
    align-self: flex-start;
    border: 0;
    background: transparent;
    padding: 0;
    cursor: pointer;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .resource-claim-list {
    margin-top: 0.75rem;
  }

  .resource-claim {
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 0.65rem;
  }

  .resource-claim summary {
    align-items: flex-start;
    cursor: pointer;
    list-style: none;
  }

  .resource-claim summary::-webkit-details-marker {
    display: none;
  }

  .evidence-select {
    align-items: center;
    display: flex;
    gap: 0.35rem;
    margin-top: 0.1rem;
  }

  .evidence-status {
    align-items: center;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full, 9999px);
    display: inline-flex;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    height: 1.35rem;
    justify-content: center;
    line-height: 1;
    width: 1.35rem;
  }

  .evidence-status--supports {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .evidence-status--contradicts,
  .evidence-status--invalid {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .evidence-status--unclear {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }

  .evidence-status--irrelevant {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
  }

  .resource-claim-body {
    padding: 0.5rem 0 0 2.6rem;
  }

  .resource-claim-body p {
    margin: 0.25rem 0 0;
  }

  .resource-claim-body dl {
    display: grid;
    gap: 0.25rem;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    margin: 0.5rem 0;
  }

  .resource-claim-body dl div {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .resource-claim-body dt {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: uppercase;
  }

  .resource-claim-body dd {
    margin: 0;
  }

  .evidence-detail {
    border-left: 2px solid var(--smrt-color-outline-variant);
    margin-top: 0.5rem;
    padding-left: 0.65rem;
  }

  .evidence-detail span {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .resource-claim-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.65rem;
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
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .add-reference-row button:hover {
    background: var(--smrt-color-surface-container-low, #f1f5f9);
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
    font-weight: var(--smrt-typography-weight-medium, 500);
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .add-image-btn:hover {
    border-color: var(--smrt-color-primary, #94a3b8);
    color: var(--smrt-color-on-surface, #1e293b);
    background: var(--smrt-color-surface-container-low, #f1f5f9);
  }

  .save-button {
    background: linear-gradient(
      135deg,
      var(--smrt-color-primary) 0%,
      color-mix(in srgb, var(--smrt-color-primary) 80%, black) 100%
    );
    color: var(--smrt-color-on-primary);
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .save-button:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 6px -1px color-mix(in srgb, var(--smrt-color-primary) 40%, transparent);
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
    font-weight: var(--smrt-typography-weight-semibold, 600);
    cursor: pointer;
  }

  .save-notice {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-primary, #3b82f6);
  }

  .inline-uploader-container {
    width: 100%;
    min-height: 400px; /* Reduced for inline view */
    max-height: 60vh;
    overflow-y: auto;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    margin-top: 1rem;
    border-radius: 0.75rem;
    box-shadow: var(--smrt-elevation-2, 0 4px 6px -1px color-mix(in srgb, var(--smrt-color-shadow) 5%, transparent), 0 2px 4px -1px color-mix(in srgb, var(--smrt-color-shadow) 3%, transparent));
    /* Svelte built-in slide animations will be handled if implemented */
  }

  .body-inline-uploader {
    background: var(--smrt-color-surface-container);
  }

  .undo-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    background: linear-gradient(
      135deg,
      var(--smrt-color-primary-container) 0%,
      color-mix(in srgb, var(--smrt-color-primary-container) 80%, var(--smrt-color-surface)) 100%
    );
    border: 1px solid color-mix(in srgb, var(--smrt-color-primary) 50%, transparent);
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
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
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
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
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

  .media-item[draggable='true'] {
    cursor: grab;
  }

  .media-item[draggable='true']:active {
    cursor: grabbing;
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
    background: color-mix(in srgb, var(--smrt-color-scrim) 50%, transparent);
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
    background: color-mix(in srgb, var(--smrt-color-surface) 90%, transparent);
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .media-item-overlay button:hover {
    transform: scale(1.1);
    background: var(--smrt-color-surface);
  }

  .btn-remove-asset:hover {
    background: var(--smrt-color-error-container) !important;
    color: var(--smrt-color-error) !important;
    border-color: var(--smrt-color-error) !important;
  }

  .thumbnail-badge {
    position: absolute;
    top: 0.25rem;
    left: 0.25rem;
    background: var(--smrt-color-primary, #3b82f6);
    color: white;
    font-size: var(--smrt-typography-label-small-size, 0.65rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.03em);
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
