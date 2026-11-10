<script lang="ts">
import type { ImageLike } from '@happyvertical/smrt-images/svelte';
import { ImageUploader } from '@happyvertical/smrt-images/svelte';
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
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
  ContentData,
  FactAuditResourceClaimData,
  FactAuditStateData,
  FactEvidenceStatus,
} from '../../mock-smrt-client';
import { joinApiUrl, normalizeApiBaseUrl } from '../api';
import {
  type ContentEditorAsset,
  type ContentEditorFormData,
  type ContentEditorInitialContent,
  type ContentEditorReference,
  type ContentEditorSavePayload,
  getContentEditorInitialFormData,
  getContentEditorSavePayload,
  getContentEditorSnapshot,
  normalizePublishDate,
} from '../content-editor-form';

type ContentEditorSnapshot = ReturnType<typeof getContentEditorSnapshot>;

import { M } from '../i18n.editor.js';
import ContentAgentChat from './ContentAgentChat.svelte';
import ContentBodyEditor, {
  type ContentBodyEditorChange,
} from './ContentBodyEditor.svelte';
import ContentImageChooser from './ContentImageChooser.svelte';
import type { ContentFieldMode } from './content-field-mode.js';

const { t } = useI18n();

export interface Props {
  /** Base URL for API requests to load and save content. */
  apiBaseUrl?: string;
  /** The content object being edited, or null for new content. */
  content?: ContentData | null;
  /** Identifier of the content, or 'new' if creating. */
  contentId?: string;
  /** Current fact audit state including claims and their support status. */
  factAudit?: FactAuditStateData | null;
  /** Disable the save button and submission. */
  saveDisabled?: boolean;
  /** Message displayed below the save button. */
  saveNotice?: string | null;
  /** Enable the AI chat sidebar and assistant features. */
  agentChatEnabled?: boolean;
  /** Message displayed to explain why AI chat is unavailable. */
  agentChatNotice?: string | null;
  /** Hide the save and cancel action buttons. */
  hideActions?: boolean;
  /** Hide the AI chat sidebar completely. */
  hideChat?: boolean;
  /**
   * Show the body editor's "Save as" HTML/Markdown picker. Off by default:
   * the storage format is a technical choice most editors should not face.
   */
  showBodyFormatPicker?: boolean;
  /** Policy object defining which fields the assistant can modify. */
  assistantFieldAllowList?: ContentEditorAssistantFieldUpdateAllowList;
  /** Fired when the assistant context changes (for session tracking). */
  onAssistantContextChange?: ContentEditorAssistantContextChange;
  /** Fired when the user edits content, with the current editor snapshot. */
  onChange?: (data: ContentEditorSnapshot) => void;
  /** Fired when the fact audit state changes or is loaded. */
  onFactAuditChange?: (state: FactAuditStateData | null) => void;
  /** Fired when the user submits the editor with the saved payload. */
  onSave: (data: ContentEditorSavePayload) => void;
  /** Fired when the user cancels editing without saving. */
  onCancel: () => void;
  /**
   * `full` (default) shows every field. `simple` is for everyday editors:
   * Type, State and References are hidden, Metadata becomes a collapsed
   * "Details" section, and optional fields say so.
   */
  mode?: ContentFieldMode;
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
  showBodyFormatPicker = false,
  assistantFieldAllowList = {},
  onAssistantContextChange = undefined,
  onChange = undefined,
  onFactAuditChange = undefined,
  onSave,
  onCancel,
  mode = 'full',
}: Props = $props();

const simpleMode = $derived(mode === 'simple');
function optionalLabel(label: string): string {
  return simpleMode
    ? t(M['content.content_fields.optional'], { label })
    : label;
}

// Unique per-instance form id so triggerSave() targets THIS editor's form even
// when multiple ContentEditor / GovernedContentEditor instances are mounted
// (a hardcoded id + getElementById would resolve to the first match in the DOM).
const formId = $props.id();

export function triggerSave() {
  if (saveDisabled) return;
  const editForm =
    typeof document !== 'undefined'
      ? (document.getElementById(formId) as HTMLFormElement | null)
      : null;
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
    // ContentData carries a nullable bodyFormat; the form initializer accepts
    // the editor's stricter ContentEditorInitialContent shape and normalizes it.
    formData = getContentEditorInitialFormData(
      content as ContentEditorInitialContent | null,
    );
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

function getReferenceLabel(reference: ContentEditorReference): string {
  return (
    reference?.title ||
    reference?.name ||
    reference?.url ||
    reference?.source ||
    reference?.id ||
    'Reference'
  );
}

function getReferenceUrl(reference: ContentEditorReference): string | null {
  return reference?.url || reference?.originalUrl || reference?.source || null;
}

function getResourceClaimsForReference(
  reference: ContentEditorReference,
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

function getAuditReferences(): ContentEditorReference[] {
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

function getReferenceExpansionKey(
  reference: ContentEditorReference,
  index: number,
): string {
  return String(
    reference?.id ||
      reference?.url ||
      reference?.originalUrl ||
      reference?.title ||
      `reference-${index}`,
  );
}

function isReferenceClaimsExpanded(
  reference: ContentEditorReference,
  index: number,
): boolean {
  return expandedReferenceClaimKeys.includes(
    getReferenceExpansionKey(reference, index),
  );
}

function toggleReferenceClaims(
  reference: ContentEditorReference,
  index: number,
) {
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
// Surfaces reference-drop / image-attach failures that were previously
// swallowed by empty catch blocks (#1387 #6), reusing the smrt-content-editor__evidence-message
// error styling for a consistent in-editor notice.
let editorError = $state<string | null>(null);
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

function getReferenceSourceSelector(reference: ContentEditorReference): {
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
  body: Record<string, unknown>,
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
  } catch (error) {
    evidenceError =
      (error instanceof Error ? error.message : '') ||
      'Failed to update evidence status.';
  } finally {
    evidenceBusy = null;
  }
}

async function updateSelectedEvidenceStatus() {
  await updateEvidenceStatus(selectedEvidenceIds, bulkEvidenceStatus);
}

async function repairReferenceEvidence(reference: ContentEditorReference) {
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
  } catch (error) {
    evidenceError =
      (error instanceof Error ? error.message : '') ||
      'Failed to repair reference evidence.';
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
  } catch (error) {
    evidenceError =
      (error instanceof Error ? error.message : '') ||
      'Failed to repair selected references.';
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
interface BodyEditorInstance {
  focusImage?: (index: number) => void;
  insertImageAsset?: (asset: ContentEditorAsset) => void;
}
let bodyEditor = $state<BodyEditorInstance | null>(null);
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

function getImageRecord(payload: unknown): ContentEditorAsset {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as { data?: ContentEditorAsset }).data;
    if (data) {
      return data;
    }
  }
  return (payload ?? {}) as ContentEditorAsset;
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
        editorError = t(M['content.content_editor.reference_drop_failed']);
      }
    } catch (err) {
      editorError = t(M['content.content_editor.reference_drop_failed']);
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
}): Promise<ContentEditorAsset | null> {
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
): Promise<ContentEditorAsset | null> {
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
      editorError = t(M['content.content_editor.image_select_failed']);
    } finally {
      showImageUploader = false;
    }
  })();
}

// An attached picture whose file or row is gone is left out of the media
// list (with a console warning) instead of showing a broken image.
let brokenAssetImages = $state<Record<string, true>>({});

function hideBrokenAssetImage(assetId: string) {
  if (!assetId || brokenAssetImages[assetId]) return;
  console.warn(
    '[ContentEditor] Leaving out an attached picture that could not be loaded',
    assetId,
  );
  brokenAssetImages = { ...brokenAssetImages, [assetId]: true };
}

function getAssetImageSource(asset: ContentEditorAsset): string {
  return String(asset?.sourceUri || asset?.url || asset?.src || '');
}

function handleAttachedImageDragStart(
  event: DragEvent,
  asset: ContentEditorAsset,
) {
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
    editorError = t(M['content.content_editor.image_select_failed']);
  } finally {
    showInlineImageUploader = false;
  }
}

async function resolveBodyDropImage(selected: ImageLike | File | string) {
  try {
    return await resolveSelectedImage(selected);
  } catch (err) {
    editorError = t(M['content.content_editor.image_select_failed']);
    return null;
  }
}

function addSelectedAsset(asset: ContentEditorAsset) {
  const assetId = asset.id ?? '';
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
  formData.assets = formData.assets.filter((a) => a.id !== id);
  if (formData.thumbnailAssetId === id) {
    formData.thumbnailAssetId = null;
  }
}
</script>

<div class="smrt-content-editor__root" data-smrt-component="ContentEditor">
  <div class="smrt-content-editor__grid" class:smrt-content-editor__grid--with-sidebar={showChatSidebar} data-smrt-part="shell">
    <!-- LEFT COLUMN (Document Canvas) -->
    <Form
      id={formId}
      class="editor-main-col"
      onsubmit={handleSubmit}
    >
      {#if editorError}
        <div class="smrt-content-editor__message smrt-content-editor__message--error" role="alert" aria-live="assertive" data-smrt-part="message">
          <span>{editorError}</span>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="editor-message__dismiss"
            onclick={() => {
              editorError = null;
            }}
            aria-label={t(M['content.content_editor.dismiss_message'])}
          >
            ×
          </Button>
        </div>
      {/if}
      <div class="smrt-content-editor__toolbar" data-smrt-part="toolbar">
        <div class="smrt-content-editor__toolbar-left" data-smrt-part="controls">
          {#if !simpleMode}
          <div class="smrt-content-editor__field" data-smrt-part="field">
            <Select id="type-select" name="type" bind:value={formData.type} class="mui-input">
              <option value="article">Article</option>
              <option value="document">Document</option>
              <option value="mirror">Mirror</option>
            </Select>
            <label for="type-select">Type</label>
          </div>
          <div class="smrt-content-editor__field" data-smrt-part="field">
            <Select id="state-select" name="state" bind:value={formData.state} class="mui-input">
              <option value="active">Active</option>
              <option value="highlighted">Highlighted</option>
              <option value="deprecated">Deprecated</option>
            </Select>
            <label for="state-select">State</label>
          </div>
          {/if}
          <div class="smrt-content-editor__field" data-smrt-part="field">
            <Select id="status-select" name="status" aria-label={t(M['content.content_fields.status'])} bind:value={formData.status} class="mui-input">
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </Select>
            <label for="status-select">Status</label>
          </div>
          <div class="smrt-content-editor__field" data-smrt-part="field">
            <Input id="publish-date-input" name="publish_date" aria-label={simpleMode ? optionalLabel(t(M['content.content_fields.publish_date'])) : t(M['content.content_editor.publish_date'])} type="datetime-local" bind:value={formData.publish_date} class="mui-input" />
            <label for="publish-date-input">{simpleMode ? optionalLabel(t(M['content.content_fields.publish_date'])) : t(M['content.content_editor.publish_date'])}</label>
          </div>
        </div>
        {#if showActions}
          <div class="smrt-content-editor__toolbar-right" data-smrt-part="actions">
            <Button variant="primary" type="submit" class="save-button" disabled={saveDisabled}>{content ? 'Update Content' : 'Save Content'}</Button>
            <Button variant="secondary" type="button" onclick={handleCancel}>
              Cancel
            </Button>
          </div>
        {/if}
      </div>

      {#if saveNotice}
        <p class="smrt-content-editor__save-notice" data-smrt-part="notice">{saveNotice}</p>
      {/if}

      <Input
         type="text"
         name="title"
         aria-label={t(M['content.content_fields.title'])}
         class="document-title-input"
         bind:value={formData.title}
         placeholder={t(M['content.content_editor.document_title_placeholder'])}
         required
      />

      {#if showUndoBanner}
        <div class="smrt-content-editor__undo-banner" data-smrt-part="banner">
          <span class="smrt-content-editor__undo-banner-text" data-smrt-part="message">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>
            {t(M['content.content_editor.ai_updated_fields'], {
              count: lastAppliedFields.length,
              fieldLabel: t(
                lastAppliedFields.length !== 1
                  ? M['content.content_editor.field_plural']
                  : M['content.content_editor.field_singular'],
              ),
              fields: lastAppliedFields.join(', '),
            })}
          </span>
          <Button variant="ghost" size="sm" type="button" class="undo-banner__btn" onclick={undoLastApply}>
            Undo{fieldUndoStack.length > 1 ? ` (${fieldUndoStack.length})` : ''}
          </Button>
        </div>
      {/if}

      <div class="smrt-content-editor__document-body-section" data-smrt-part="body">
        <ContentBodyEditor
          bind:this={bodyEditor}
          value={formData.body || ''}
          format={formData.bodyFormat}
          showFormatPicker={showBodyFormatPicker}
          selectedImageIndex={selectedBodyImageIndex}
          onChange={handleBodyChange}
          onOpenImageChooser={() => showInlineImageUploader = !showInlineImageUploader}
          onSelectImage={(index) => selectedBodyImageIndex = index}
          onUseImageAsThumbnail={setThumbnail}
          onResolveImage={resolveBodyDropImage}
        />

        <div class="smrt-content-editor__document-body-media-row" data-smrt-part="preview">
          <ContentImageChooser
            body={formData.body || ''}
            format={formData.bodyFormat}
            selectedIndex={selectedBodyImageIndex}
            onSelect={focusBodyImage}
          />
        </div>

        {#if showInlineImageUploader}
          <div class="smrt-content-editor__inline-uploader-container smrt-content-editor__body-inline-uploader" data-smrt-part="panel">
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
      <details class="smrt-content-editor__drawer" open data-smrt-part="drawer">
          <summary class="smrt-content-editor__drawer-header" data-smrt-part="drawer-header">
            Images & Media
            <svg class="smrt-content-editor__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="smrt-content-editor__drawer-content smrt-content-editor__drop-zone"
            class:smrt-content-editor__drop-zone--active={imageDragOver}
            ondragover={handleImageDragOver}
            ondragleave={handleImageDragLeave}
            ondrop={handleImageDrop}
            data-smrt-part="drawer-body"
          >
             {#if imageDragOver}
               <div class="smrt-content-editor__drop-overlay" data-smrt-part="overlay">
                 <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
               </div>
             {/if}
             <div class="smrt-content-editor__media-gallery" data-smrt-part="list">
                {#if formData.assets && formData.assets.length > 0}
                  <div class="smrt-content-editor__media-grid" data-smrt-part="grid">
                    {#each formData.assets as asset, index (asset.id || `asset-${index}`)}
                      {@const assetId = typeof asset.id === 'string' ? asset.id : ''}
                      {#if !(assetId && brokenAssetImages[assetId])}
                      <div
                        class="smrt-content-editor__media-item"
                        class:smrt-content-editor__media-item--thumbnail={assetId === formData.thumbnailAssetId}
                        draggable="true"
                        title={t(M['content.content_editor.drag_into_body'])}
                        ondragstart={(event) => handleAttachedImageDragStart(event, asset)}
                        data-smrt-part="item"
                      >
                        <img
                          class="smrt-content-editor__media-item-image"
                          data-smrt-part="preview"
                          src={getAssetImageSource(asset)}
                          alt={asset.name || 'Asset image'}
                          onerror={() => hideBrokenAssetImage(assetId)}
                        />
                        <div class="smrt-content-editor__media-item-overlay" data-smrt-part="overlay">
                           {#if assetId && assetId !== formData.thumbnailAssetId}
                             <Button variant="ghost" size="sm" type="button" class="btn-make-thumbnail" aria-label={t(M['content.content_editor.make_thumbnail'])} title={t(M['content.content_editor.make_thumbnail'])} onclick={() => setThumbnail(assetId)}>
                               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                             </Button>
                           {/if}
                           {#if assetId}
                             <Button variant="ghost" size="sm" type="button" class="btn-remove-asset" aria-label={t(M['content.content_editor.remove'])} title={t(M['content.content_editor.remove'])} onclick={() => removeAsset(assetId)}>
                               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                             </Button>
                           {/if}
                        </div>
                        {#if assetId === formData.thumbnailAssetId}
                          <div class="smrt-content-editor__thumbnail-badge" data-smrt-part="badge">Thumbnail</div>
                        {/if}
                      </div>
                      {/if}
                    {/each}
                  </div>
                {:else}
                  <p class="smrt-content-editor__no-media-text" data-smrt-part="empty">{t(M['content.content_editor.no_images_attached'])}</p>
                {/if}
                {#if !showImageUploader}
                  <Button variant="ghost" type="button" class="add-image-btn" onclick={() => showImageUploader = true} style="margin-top: 1rem;">
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                      <circle cx="8.5" cy="8.5" r="1.5"></circle>
                      <polyline points="21 15 16 10 5 21"></polyline>
                    </svg>
                    {t(M['content.content_editor.add_image'])}
                  </Button>
                {/if}

                {#if showImageUploader}
                  <div class="smrt-content-editor__inline-uploader-container" data-smrt-part="panel">
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

      <!-- Metadata Panel ("Details", collapsed, in simple mode) -->
      <details class="smrt-content-editor__drawer" open={!simpleMode} data-smrt-part="drawer">
        <summary class="smrt-content-editor__drawer-header" data-smrt-part="drawer-header">
          {#if simpleMode}{t(M['content.content_fields.details'])}{:else}Metadata{/if}
          <svg class="smrt-content-editor__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </summary>
        <div class="smrt-content-editor__drawer-content" data-smrt-part="drawer-body">
          <label>
            {simpleMode ? optionalLabel(t(M['content.content_fields.author'])) : 'Author:'}
            <Input type="text" name="author" aria-label={optionalLabel(t(M['content.content_fields.author']))} bind:value={formData.author} placeholder={t(M['content.content_editor.author_name_placeholder'])} />
          </label>
          <label>
            {simpleMode ? optionalLabel(t(M['content.content_fields.summary'])) : 'Description:'}
            <Textarea name="description" aria-label={simpleMode ? optionalLabel(t(M['content.content_fields.summary'])) : t(M['content.content_fields.description'])} bind:value={formData.description} rows={2} placeholder={t(M['content.content_editor.brief_summary_placeholder'])}></Textarea>
          </label>
          <label>
            {simpleMode ? optionalLabel(t(M['content.content_fields.tags'])) : t(M['content.content_editor.tags_comma_separated'])}
            <Input
              type="text"
              name="tags"
              aria-label={optionalLabel(t(M['content.content_fields.tags']))}
              value={(formData.tags || []).join(', ')}
              placeholder={t(M['content.content_editor.tags_placeholder'])}
              oninput={(event) => parseTagsInput((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
      </details>

      <!-- References Panel (hidden in simple mode) -->
      {#if !simpleMode}
      <details class="smrt-content-editor__drawer" open data-smrt-part="drawer">
          <summary class="smrt-content-editor__drawer-header" data-smrt-part="drawer-header">
            References
            <svg class="smrt-content-editor__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="smrt-content-editor__drawer-content smrt-content-editor__drop-zone"
            class:smrt-content-editor__drop-zone--active={refDragOver}
            ondragover={handleRefDragOver}
            ondragleave={handleRefDragLeave}
            ondrop={handleRefDrop}
            data-smrt-part="drawer-body"
          >
            {#if refDragOver}
              <div class="smrt-content-editor__drop-overlay" data-smrt-part="overlay">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              </div>
            {/if}
            <div class="smrt-content-editor__references-section" data-smrt-part="section">
               <div class="smrt-content-editor__references-list" data-smrt-part="list">
                  {#each formData.referenceIds as refId}
                    <div class="smrt-content-editor__reference-badge" data-smrt-part="badge">
                      <span class="smrt-content-editor__ref-id" data-smrt-part="label">{refId}</span>
                      <Button variant="ghost" size="sm" type="button" class="remove-ref-btn" aria-label={t(M['content.content_editor.remove'])} title={t(M['content.content_editor.remove'])} onclick={() => removeReference(refId)}>×</Button>
                    </div>
                  {/each}
                  {#if formData.referenceIds.length === 0 && auditReferences.length === 0}
                    <span class="smrt-content-editor__no-refs" data-smrt-part="empty">{t(M['content.content_editor.no_references'])}</span>
                  {/if}
               </div>
               {#if auditReferences.length > 0}
                 <div class="smrt-content-editor__reference-detail-list" data-smrt-part="list">
                   {#if evidenceError}
                     <p class="smrt-content-editor__evidence-message smrt-content-editor__evidence-message--error" data-smrt-part="message">{evidenceError}</p>
                   {/if}
                   {#if evidenceNotice}
                     <p class="smrt-content-editor__evidence-message smrt-content-editor__evidence-message--notice" data-smrt-part="message">{evidenceNotice}</p>
                   {/if}
                   <div class="smrt-content-editor__evidence-bulk-toolbar" data-smrt-part="toolbar">
                     <span>{t(M['content.content_editor.evidence_items_selected'], {
                       count: selectedEvidenceCount,
                       itemLabel: t(
                         selectedEvidenceCount === 1
                           ? M['content.content_editor.evidence_item_singular']
                           : M['content.content_editor.evidence_item_plural'],
                       ),
                     })}</span>
                     <Select bind:value={bulkEvidenceStatus} disabled={selectedEvidenceCount === 0 || Boolean(evidenceBusy)}>
                       {#each evidenceStatuses as status}
                         <option value={status}>{status}</option>
                       {/each}
                     </Select>
                     <Button
                       variant="ghost"
                       size="sm"
                       type="button"
                       class="evidence-action-button"
                       disabled={selectedEvidenceCount === 0 || Boolean(evidenceBusy)}
                       onclick={() => void updateSelectedEvidenceStatus()}
                     >
                       Mark
                     </Button>
                     <Button
                       variant="ghost"
                       size="sm"
                       type="button"
                       class="evidence-action-button"
                       disabled={selectedEvidenceCount === 0 || Boolean(evidenceBusy)}
                       onclick={() => void repairSelectedReferenceEvidence()}
                     >
                       {t(M['content.content_editor.repair_resources'])}
                     </Button>
                   </div>
                   {#each auditReferences as reference, referenceIndex (reference._auditSourceId ?? reference.id ?? reference.url ?? reference.title)}
                     {@const resourceClaims = getResourceClaimsForReference(reference)}
                     {@const resourceClaimsExpanded = isReferenceClaimsExpanded(reference, referenceIndex)}
                     {@const visibleResourceClaims = resourceClaimsExpanded ? resourceClaims : resourceClaims.slice(0, 6)}
                     <div class="smrt-content-editor__reference-detail" data-smrt-part="item">
                       <div class="smrt-content-editor__reference-detail-header" data-smrt-part="header">
                         <div>
                           <strong>{getReferenceLabel(reference)}</strong>
                           {#if getReferenceUrl(reference)}
                             <a href={getReferenceUrl(reference) ?? undefined} target="_blank" rel="noreferrer">
                               {getReferenceUrl(reference)}
                             </a>
                           {/if}
                         </div>
                         <div class="smrt-content-editor__reference-detail-actions" data-smrt-part="actions">
                           <span>{t(M['content.content_editor.evidence_claims'], {
                             count: resourceClaims.length,
                             claimLabel: t(
                               resourceClaims.length === 1
                                 ? M['content.content_editor.evidence_claim_singular']
                                 : M['content.content_editor.evidence_claim_plural'],
                             ),
                           })}</span>
                           <Button
                             variant="ghost"
                             size="sm"
                             type="button"
                             class="evidence-action-button"
                             disabled={Boolean(evidenceBusy)}
                             onclick={() => void repairReferenceEvidence(reference)}
                           >
                             {evidenceBusy === `repair:${reference.id}` ? 'Repairing...' : 'Repair'}
                           </Button>
                         </div>
                       </div>
                       {#if resourceClaims.length > 0}
                         <div class="smrt-content-editor__resource-claim-list" data-smrt-part="list">
                           {#each visibleResourceClaims as claim, claimIndex (getResourceClaimKey(claim, claimIndex))}
                             {@const evidenceIds = getResourceClaimEvidenceIds(claim)}
                             <details class="smrt-content-editor__resource-claim" data-smrt-part="item">
                               <summary>
                                 <label class="smrt-content-editor__evidence-select" data-smrt-part="label">
                                   <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
                                   <input
                                     type="checkbox"
                                     checked={isResourceClaimSelected(claim)}
                                     disabled={evidenceIds.length === 0}
                                     onchange={() => toggleResourceClaimSelection(claim)}
                                   />
                                   <span class={`smrt-content-editor__evidence-status smrt-content-editor__evidence-status--${claim.status || 'supports'}`} data-smrt-part="status">
                                     {getEvidenceStatusIcon(claim.status)}
                                   </span>
                                 </label>
                                 <strong>{claim.fact?.textRefined || claim.fact?.textRaw || claim.quote}</strong>
                               </summary>
                               <div class="smrt-content-editor__resource-claim-body" data-smrt-part="body">
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
                                   <div class="smrt-content-editor__evidence-detail" data-smrt-part="body">
                                     <span>{evidence.extractionMethod || 'extracted evidence'}</span>
                                     {#if evidence.quote}
                                       <p>{evidence.quote}</p>
                                     {/if}
                                   </div>
                                 {/each}
                                 <div class="smrt-content-editor__resource-claim-actions" data-smrt-part="actions">
                                   {#each evidenceStatuses as status}
                                     <Button
                                       variant="ghost"
                                       size="sm"
                                       type="button"
                                       class="evidence-action-button"
                                       disabled={evidenceIds.length === 0 || Boolean(evidenceBusy)}
                                       onclick={() => void updateEvidenceStatus(evidenceIds, status)}
                                     >
                                       {status}
                                     </Button>
                                   {/each}
                                 </div>
                               </div>
                             </details>
                           {/each}
                           {#if resourceClaims.length > 6}
                             <Button
                               variant="ghost"
                               size="sm"
                               type="button"
                               class="resource-claim-more"
                               onclick={() => toggleReferenceClaims(reference, referenceIndex)}
                             >
                               {resourceClaimsExpanded ? 'Show fewer' : `+ ${resourceClaims.length - 6} more`}
                             </Button>
                           {/if}
                         </div>
                       {/if}
                     </div>
                   {/each}
                 </div>
               {/if}
               <div class="smrt-content-editor__add-reference-row" data-smrt-part="row">
                  <Input type="text" bind:value={newReferenceId} placeholder={t(M['content.content_editor.reference_id_or_url_placeholder'])} />
                  <Button variant="ghost" type="button" class="add-reference-button" onclick={addReference}>Add</Button>
               </div>
            </div>

            <label>
              URL:
              <Input type="url" name="url" aria-label={t(M['content.content_fields.url'])} bind:value={formData.url} />
            </label>
            <label>
              {t(M['content.content_editor.file_key'])}
              <Input type="text" name="fileKey" aria-label={t(M['content.content_editor.file_key'])} bind:value={formData.fileKey} />
            </label>
          </div>
      </details>
      {/if}
    </Form>

    {#if showChatSidebar}
      <aside class="smrt-content-editor__sidebar-col" data-smrt-part="sidebar">
        <div class="smrt-content-editor__chat-sidebar-section" data-smrt-part="panel">
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
              class="smrt-content-editor__chat-sidebar-empty-state"
              data-testid="content-editor-agent-chat-disabled"
              data-smrt-part="empty"
            >
              <h3>{t(M['content.content_editor.agent_chat_unavailable'])}</h3>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-editor__root {
    width: 100%;
    margin: 0 auto;
    padding: 1rem 0;
  }
  .smrt-content-editor__grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
    align-items: start;
    width: 100%;
  }
  @media (min-width: 1024px) {
    .smrt-content-editor__grid--with-sidebar {
      grid-template-columns: 1fr auto;
    }
    .smrt-content-editor__sidebar-col {
      width: 380px;
    }
  }
  .smrt-content-editor__root :global(.document-title-input) {
    width: 100%;
    padding: 0;
    margin-bottom: 2rem;
    resize: none;
  }
  .smrt-content-editor__document-body-section {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    margin-bottom: 2rem;
  }
  .smrt-content-editor__document-body-media-row {
    display: flex;
    justify-content: flex-end;
    min-height: 2.75rem;
  }
  .smrt-content-editor__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .smrt-content-editor__toolbar-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .smrt-content-editor__toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .smrt-content-editor__field {
    position: relative;
    display: inline-flex;
    margin-top: 0.5rem;
  }
  .smrt-content-editor__field label {
    position: absolute;
    top: -0.5rem;
    left: 0.5rem;
    /* Matches main surface background */
    padding: 0 0.25rem;
    z-index: 1;
    pointer-events: none;
  }
  .smrt-content-editor__field :global(.mui-input) {
    padding: 0.5rem 0.75rem;
    width: auto;
    box-sizing: border-box;
  }
  .smrt-content-editor__root :global(.editor-main-col) {
    display: flex;
    flex-direction: column;
    width: 100%;
  }
  .smrt-content-editor__sidebar-col {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    position: sticky;
    top: 2rem;
  }
  .smrt-content-editor__drawer {
    margin: 0 0 2rem 0;
    padding: 0;
  }
  .smrt-content-editor__drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0 1.25rem 0;
    cursor: pointer;
    list-style: none;
    /* Hide default triangle */
    user-select: none;
    margin: 0;
  }
  /* Hide the default details marker */
  .smrt-content-editor__drawer-header::-webkit-details-marker {
    display: none;
  }
  .smrt-content-editor__drawer-content {
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .smrt-content-editor__chat-sidebar-section {
    height: 600px;
    overflow: hidden;
  }
  .smrt-content-editor__chat-sidebar-empty-state {
    display: grid;
    gap: 0.75rem;
    align-content: start;
    padding: 1.25rem;
    height: 100%;
    box-sizing: border-box;
  }
  .smrt-content-editor__chat-sidebar-empty-state h3,
  .smrt-content-editor__chat-sidebar-empty-state p {
    margin: 0;
  }
  .smrt-content-editor__root h3 {
    margin: 0;
  }
  .smrt-content-editor__root label {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-content-editor__references-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
  }
  .smrt-content-editor__references-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .smrt-content-editor__reference-badge {
    display: flex;
    align-items: center;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
  }
  .smrt-content-editor__reference-badge :global(.remove-ref-btn) {
    cursor: pointer;
    padding: 0 0.25rem;
    margin-left: 0.25rem;
  }
  .smrt-content-editor__reference-detail-list,
  .smrt-content-editor__resource-claim-list {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .smrt-content-editor__reference-detail {
    padding: 0.75rem;
  }
  .smrt-content-editor__reference-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .smrt-content-editor__reference-detail-header div,
  .smrt-content-editor__resource-claim summary {
    display: flex;
    gap: 0.25rem;
  }
  .smrt-content-editor__reference-detail-header div {
    flex-direction: column;
  }
  .smrt-content-editor__reference-detail-actions {
    align-items: flex-end;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .smrt-content-editor__references-section :global(.evidence-action-button) {
    cursor: pointer;
    padding: 0.25rem 0.5rem;
  }
  .smrt-content-editor__references-section :global(.evidence-action-button:disabled) {
    cursor: not-allowed;
  }
  .smrt-content-editor__evidence-bulk-toolbar {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem;
  }
  .smrt-content-editor__evidence-bulk-toolbar :global([data-smrt-component="Select"]) {
    padding: 0.25rem 0.5rem;
  }
  .smrt-content-editor__evidence-message {
    margin: 0;
  }
  .smrt-content-editor__message {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0 0 var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-content-editor__message :global(.editor-message__dismiss) {
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .smrt-content-editor__references-section :global(.resource-claim-more) {
    align-self: flex-start;
    padding: 0;
    cursor: pointer;
  }
  .smrt-content-editor__resource-claim-list {
    margin-top: 0.75rem;
  }
  .smrt-content-editor__resource-claim {
    padding-top: 0.65rem;
  }
  .smrt-content-editor__resource-claim summary {
    align-items: flex-start;
    cursor: pointer;
    list-style: none;
  }
  .smrt-content-editor__resource-claim summary::-webkit-details-marker {
    display: none;
  }
  .smrt-content-editor__evidence-select {
    align-items: center;
    display: flex;
    gap: 0.35rem;
    margin-top: 0.1rem;
  }
  .smrt-content-editor__evidence-status {
    align-items: center;
    display: inline-flex;
    height: 1.35rem;
    justify-content: center;
    width: 1.35rem;
  }
  .smrt-content-editor__resource-claim-body {
    padding: 0.5rem 0 0 2.6rem;
  }
  .smrt-content-editor__resource-claim-body p {
    margin: 0.25rem 0 0;
  }
  .smrt-content-editor__resource-claim-body dl {
    display: grid;
    gap: 0.25rem;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    margin: 0.5rem 0;
  }
  .smrt-content-editor__resource-claim-body dl div {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .smrt-content-editor__resource-claim-body dd {
    margin: 0;
  }
  .smrt-content-editor__evidence-detail {
    margin-top: 0.5rem;
    padding-left: 0.65rem;
  }
  .smrt-content-editor__resource-claim-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.65rem;
  }
  .smrt-content-editor__add-reference-row {
    display: flex;
    gap: 0.5rem;
  }
  .smrt-content-editor__add-reference-row :global([data-smrt-component="Input"]) {
    flex: 1;
  }
  .smrt-content-editor__add-reference-row :global(.add-reference-button) {
    padding: 0 1rem;
    cursor: pointer;
  }
  .smrt-content-editor__media-gallery :global(.add-image-btn) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    cursor: pointer;
  }
  .smrt-content-editor__toolbar-right :global(.save-button) {
    padding: 0.75rem 1.5rem;
    cursor: pointer;
  }
  .smrt-content-editor__inline-uploader-container {
    width: 100%;
    min-height: 400px;
    /* Reduced for inline view */
    max-height: 60vh;
    overflow-y: auto;
    margin-top: 1rem;
  }
  .smrt-content-editor__undo-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
  }
  .smrt-content-editor__undo-banner-text {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-content-editor__undo-banner-text svg {
    flex-shrink: 0;
  }
  .smrt-content-editor__undo-banner :global(.undo-banner__btn) {
    padding: 0.375rem 0.875rem;
    cursor: pointer;
    white-space: nowrap;
  }
  /* Media Gallery */
  .smrt-content-editor__media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.75rem;
  }
  .smrt-content-editor__media-item {
    position: relative;
    overflow: hidden;
  }
  .smrt-content-editor__media-item[draggable='true'] {
    cursor: grab;
  }
  .smrt-content-editor__media-item[draggable='true']:active {
    cursor: grabbing;
  }
  .smrt-content-editor__media-item-image {
    width: 100%;
    height: 120px;
    object-fit: cover;
    display: block;
  }
  .smrt-content-editor__media-item-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    justify-content: center;
    opacity: 0;
  }
  .smrt-content-editor__media-item:hover .smrt-content-editor__media-item-overlay {
    opacity: 1;
  }
  .smrt-content-editor__media-item-overlay :global(.btn-make-thumbnail),
  .smrt-content-editor__media-item-overlay :global(.btn-remove-asset) {
    padding: 0.4rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-content-editor__thumbnail-badge {
    position: absolute;
    top: 0.25rem;
    left: 0.25rem;
    padding: 0.15rem 0.4rem;
  }
  /* ── Drag & Drop Zones ── */
  .smrt-content-editor__drop-zone {
    position: relative;
    padding: 1.5rem;
  }
  .smrt-content-editor__drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    pointer-events: none;
  }
}

@layer smrt.theme {
  .smrt-content-editor__root :global(.document-title-input) {
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    line-height: var(--smrt-typography-display-medium-line-height, 1.2);
    border: none;
    outline: none;
    background: transparent;
    color: var(--smrt-color-on-surface);
    font-family: inherit;
  }
  .smrt-content-editor__root :global(.document-title-input)::placeholder {
    color: var(--smrt-color-outline-variant);
  }
  .smrt-content-editor__toolbar {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-content-editor__field label {
    background: var(--smrt-color-surface);
    font-size: var(--smrt-typography-label-small-size, 0.65rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-outline);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
  }
  .smrt-content-editor__field :global(.mui-input) {
    border-radius: 0.375rem;
    border: var(--smrt-hairline);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-family: inherit;
    transition: border-color 0.2s;
  }
  .smrt-content-editor__field :global(.mui-input:focus) {
    outline: none;
    border-color: var(--smrt-color-primary);
  }
  .smrt-content-editor__root :global(.editor-main-col) {
    background: transparent;
  }
  .smrt-content-editor__drawer-header {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
    transition: color 0.2s;
  }
  .smrt-content-editor__drawer-header:hover {
    color: var(--smrt-color-primary);
  }
  .smrt-content-editor__drawer-icon {
    color: var(--smrt-color-outline);
    transition: transform 0.3s ease;
  }
  .smrt-content-editor__drawer[open] .smrt-content-editor__drawer-icon {
    transform: rotate(180deg);
  }
  .smrt-content-editor__chat-sidebar-section {
    background: var(--smrt-color-surface);
    border-radius: 1rem;
    border: var(--smrt-hairline);
  }
  .smrt-content-editor__chat-sidebar-empty-state {
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-editor__root h3 {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
  }
  .smrt-content-editor__root label {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  .smrt-content-editor__references-section {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: 0.5rem;
  }
  .smrt-content-editor__reference-badge {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-editor__reference-badge :global(.remove-ref-btn) {
    background: none;
    border: none;
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    line-height: 1;
  }
  .smrt-content-editor__reference-badge :global(.remove-ref-btn:hover) {
    color: var(--smrt-color-error);
  }
  .smrt-content-editor__no-refs {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-style: italic;
  }
  .smrt-content-editor__reference-detail {
    border: var(--smrt-hairline);
    background: var(--smrt-color-surface);
    border-radius: 0.5rem;
  }
  .smrt-content-editor__reference-detail-header {
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-editor__references-section :global(.evidence-action-button) {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.375rem;
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-editor__references-section :global(.evidence-action-button:disabled) {
    opacity: 0.55;
  }
  .smrt-content-editor__evidence-bulk-toolbar {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.5rem;
  }
  .smrt-content-editor__evidence-bulk-toolbar span,
  .smrt-content-editor__evidence-message {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  .smrt-content-editor__evidence-bulk-toolbar :global([data-smrt-component="Select"]) {
    border: var(--smrt-hairline);
    border-radius: 0.375rem;
  }
  .smrt-content-editor__evidence-message--error {
    color: var(--smrt-color-error);
  }
  .smrt-content-editor__evidence-message--notice {
    color: var(--smrt-color-primary);
  }
  .smrt-content-editor__message {
    border-radius: var(--smrt-radius-md, 0.5rem);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  .smrt-content-editor__message--error {
    color: var(--smrt-color-on-error-container);
    background: color-mix(in srgb, var(--smrt-color-error) 12%, transparent);
  }
  .smrt-content-editor__message :global(.editor-message__dismiss) {
    border: none;
    background: transparent;
    color: inherit;
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    line-height: 1;
  }
  .smrt-content-editor__reference-detail-header a,
  .smrt-content-editor__reference-detail-header span,
  .smrt-content-editor__resource-claim-body {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  .smrt-content-editor__references-section :global(.resource-claim-more) {
    border: 0;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-editor__resource-claim {
    border-top: var(--smrt-hairline);
  }
  .smrt-content-editor__evidence-status {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    line-height: 1;
  }
  .smrt-content-editor__evidence-status--supports {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-content-editor__evidence-status--contradicts,
  .smrt-content-editor__evidence-status--invalid {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-editor__evidence-status--unclear {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-content-editor__evidence-status--irrelevant {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-editor__resource-claim-body dt {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: uppercase;
  }
  .smrt-content-editor__evidence-detail {
    border-left: 2px solid var(--smrt-color-outline-variant);
  }
  .smrt-content-editor__evidence-detail span {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-content-editor__add-reference-row :global(.add-reference-button) {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline-strong);
    color: var(--smrt-color-on-surface-variant);
    border-radius: 0.5rem;
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-content-editor__add-reference-row :global(.add-reference-button:hover) {
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-content-editor__media-gallery :global(.add-image-btn) {
    background: var(--smrt-color-surface, white);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-md, 0.5rem);
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: all 0.2s;
  }
  .smrt-content-editor__media-gallery :global(.add-image-btn:hover) {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-content-editor__toolbar-right :global(.save-button) {
    background: linear-gradient(
      135deg,
      var(--smrt-color-primary) 0%,
      color-mix(in srgb, var(--smrt-color-primary) 80%, black) 100%
    );
    color: var(--smrt-color-on-primary);
    border: none;
    border-radius: 0.5rem;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .smrt-content-editor__toolbar-right :global(.save-button:hover) {
    transform: translateY(-1px);
    box-shadow: 0 4px 6px -1px color-mix(in srgb, var(--smrt-color-primary) 40%, transparent);
  }
  .smrt-content-editor__toolbar-right :global(.save-button:disabled) {
    opacity: 0.65;
    transform: none;
    box-shadow: none;
  }
  .smrt-content-editor__save-notice {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-primary);
  }
  .smrt-content-editor__inline-uploader-container {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
    box-shadow: var(--smrt-elevation-2, 0 4px 6px -1px color-mix(in srgb, var(--smrt-color-shadow) 5%, transparent), 0 2px 4px -1px color-mix(in srgb, var(--smrt-color-shadow) 3%, transparent));
    /* Svelte built-in slide animations will be handled if implemented */
  }
  .smrt-content-editor__body-inline-uploader {
    background: var(--smrt-color-surface-container);
  }
  .smrt-content-editor__undo-banner {
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
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .smrt-content-editor__undo-banner-text {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary);
  }
  .smrt-content-editor__undo-banner :global(.undo-banner__btn) {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-primary);
    border: var(--smrt-hairline-strong);
    border-radius: 0.375rem;
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    transition: all 0.15s ease;
  }
  .smrt-content-editor__undo-banner :global(.undo-banner__btn:hover) {
    background: var(--smrt-color-surface-variant);
    border-color: var(--smrt-color-primary);
  }
  .smrt-content-editor__media-item {
    border-radius: 0.5rem;
    border: 2px solid transparent;
    background: var(--smrt-color-surface-container-high);
    transition: border-color 0.2s;
  }
  .smrt-content-editor__media-item.smrt-content-editor__media-item--thumbnail {
    border-color: var(--smrt-color-primary);
  }
  .smrt-content-editor__media-item-overlay {
    background: color-mix(in srgb, var(--smrt-color-scrim) 50%, transparent);
    transition: opacity 0.2s;
  }
  .smrt-content-editor__media-item-overlay :global(.btn-make-thumbnail),
  .smrt-content-editor__media-item-overlay :global(.btn-remove-asset) {
    border: none;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--smrt-color-surface) 90%, transparent);
    color: var(--smrt-color-on-surface);
    transition: background 0.15s, transform 0.15s;
  }
  .smrt-content-editor__media-item-overlay :global(.btn-make-thumbnail:hover),
  .smrt-content-editor__media-item-overlay :global(.btn-remove-asset:hover) {
    transform: scale(1.1);
    background: var(--smrt-color-surface);
  }
  .smrt-content-editor__media-item-overlay :global(.btn-remove-asset:hover:not(:disabled):not(.disabled)) {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }
  .smrt-content-editor__thumbnail-badge {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-size: var(--smrt-typography-label-small-size, 0.65rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border-radius: 0.25rem;
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.03em);
  }
  /* ── Drag & Drop Zones ── */
  .smrt-content-editor__drop-zone {
    transition: border-color 0.2s, background 0.2s;
    border: 2px dashed var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
  }
  .smrt-content-editor__drop-zone--active {
    border-color: var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 6%, transparent);
  }
  .smrt-content-editor__drop-overlay {
    background: color-mix(in srgb, var(--smrt-color-primary) 12%, var(--smrt-color-surface, white) 88%);
    border-radius: 0.5rem;
    animation: drop-pulse 0.3s ease-out;
  }
  .smrt-content-editor__drop-overlay svg {
    color: var(--smrt-color-primary);
    opacity: 0.8;
  }
  @keyframes drop-pulse {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
}

</style>
