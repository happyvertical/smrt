import type { ImageLike } from '@happyvertical/smrt-images/svelte';
import {
  type ContentEditorAsset,
  type ContentEditorFormData,
  type ContentEditorInitialContent,
  getContentEditorInitialFormData,
  getContentEditorSavePayload,
  getContentEditorSnapshot,
} from './content-editor-form.js';

export interface CreateContentEditorStateOptions {
  content?: ContentEditorInitialContent | null;
}

export type ContentEditorFieldChange = Partial<ContentEditorFormData> &
  Record<string, unknown>;

type FieldUndoSnapshot = Record<string, unknown>;

function cloneFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value];
  }

  if (value && typeof value === 'object') {
    return { ...(value as Record<string, unknown>) };
  }

  return value;
}

function normalizeFieldUpdateValue(
  currentValue: unknown,
  newValue: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (Array.isArray(currentValue)) {
    return Array.isArray(newValue)
      ? { ok: true, value: [...newValue] }
      : { ok: false };
  }

  if (currentValue === null) {
    return newValue == null || typeof newValue === 'string'
      ? { ok: true, value: newValue ?? null }
      : { ok: false };
  }

  switch (typeof currentValue) {
    case 'string':
      return { ok: true, value: newValue == null ? '' : String(newValue) };
    case 'number': {
      const numberValue = Number(newValue);
      return Number.isFinite(numberValue)
        ? { ok: true, value: numberValue }
        : { ok: false };
    }
    case 'boolean':
      return typeof newValue === 'boolean'
        ? { ok: true, value: newValue }
        : { ok: false };
    case 'undefined':
      return { ok: true, value: cloneFieldValue(newValue) };
    default:
      return { ok: true, value: cloneFieldValue(newValue) };
  }
}

export class ContentEditorState {
  private _form = $state<ContentEditorFormData>(
    getContentEditorInitialFormData(undefined),
  );
  private _fieldUndoStack = $state<FieldUndoSnapshot[]>([]);
  private _lastAppliedFields = $state<string[]>([]);
  private _showUndoBanner = $state(false);

  constructor(options: CreateContentEditorStateOptions = {}) {
    this.reset(options.content);
  }

  get form() {
    return this._form;
  }

  get snapshot() {
    return getContentEditorSnapshot(this._form);
  }

  get savePayload() {
    return getContentEditorSavePayload(this._form);
  }

  get showUndoBanner() {
    return this._showUndoBanner;
  }

  get lastAppliedFields() {
    return this._lastAppliedFields;
  }

  get undoDepth() {
    return this._fieldUndoStack.length;
  }

  reset(content?: ContentEditorInitialContent | null) {
    this._form = getContentEditorInitialFormData(content);
    this._fieldUndoStack = [];
    this._lastAppliedFields = [];
    this._showUndoBanner = false;
  }

  update(change: ContentEditorFieldChange) {
    this._form = {
      ...this._form,
      ...change,
    };
  }

  applyFieldUpdates(fields: ContentEditorFieldChange) {
    const oldValues: FieldUndoSnapshot = {};
    const appliedFields: string[] = [];

    for (const key of Object.keys(fields)) {
      const normalized = normalizeFieldUpdateValue(
        this._form[key],
        fields[key],
      );
      if (!normalized.ok) {
        continue;
      }

      oldValues[key] = cloneFieldValue(this._form[key]);
      this._form[key] = normalized.value;
      appliedFields.push(key);
    }

    if (appliedFields.length === 0) {
      return;
    }

    this._fieldUndoStack = [...this._fieldUndoStack, oldValues];
    this._lastAppliedFields = appliedFields;
    this._showUndoBanner = true;
  }

  undoLastFieldUpdate() {
    if (this._fieldUndoStack.length === 0) {
      return;
    }

    const oldValues = this._fieldUndoStack[this._fieldUndoStack.length - 1];
    this._fieldUndoStack = this._fieldUndoStack.slice(0, -1);

    for (const [key, value] of Object.entries(oldValues)) {
      this._form[key] = value;
    }

    this._lastAppliedFields = Object.keys(oldValues);
    if (this._fieldUndoStack.length === 0) {
      this._showUndoBanner = false;
    }
  }

  setReferenceIds(referenceIds: string[]) {
    this._form.referenceIds = [...referenceIds];
  }

  addAsset(asset: ContentEditorAsset | ImageLike | Record<string, unknown>) {
    const assetId = typeof asset.id === 'string' ? asset.id : '';
    if (!assetId) {
      return;
    }

    if (!this._form.assetIds.includes(assetId)) {
      this._form.assetIds = [...this._form.assetIds, assetId];
      this._form.assets = [...this._form.assets, asset as ContentEditorAsset];
    }

    if (!this._form.thumbnailAssetId) {
      this._form.thumbnailAssetId = assetId;
    }
  }

  removeAsset(assetId: string) {
    this._form.assetIds = this._form.assetIds.filter((id) => id !== assetId);
    this._form.assets = this._form.assets.filter(
      (asset) => asset.id !== assetId,
    );

    if (this._form.thumbnailAssetId === assetId) {
      this._form.thumbnailAssetId = null;
    }
  }

  setThumbnailAsset(assetId: string | null) {
    this._form.thumbnailAssetId = assetId;
  }
}

export function createContentEditorState(
  options: CreateContentEditorStateOptions = {},
) {
  return new ContentEditorState(options);
}
