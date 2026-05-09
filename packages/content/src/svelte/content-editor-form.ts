import type { ContentBodyFormat } from '../body-format';
import { resolveBodyFormat } from '../body-format';

export interface ContentEditorAsset {
  id?: string | null;
  name?: string | null;
  title?: string | null;
  filename?: string | null;
  sourceUri?: string | null;
  thumbnailUri?: string | null;
  thumbnailUrl?: string | null;
  deliveryUrl?: string | null;
  url?: string | null;
  src?: string | null;
}

export interface ContentEditorReference {
  id?: string | null;
  title?: string | null;
  name?: string | null;
  url?: string | null;
  originalUrl?: string | null;
  source?: string | null;
  _auditOnly?: boolean;
  _auditSourceKind?: string;
  _auditSourceId?: string;
}

export type ContentEditorInitialContent = Partial<ContentEditorFormData> & {
  publishDate?: unknown;
};

export type ContentEditorSavePayload = Omit<
  ContentEditorFormData,
  'references' | 'assets' | 'publishDate'
> & {
  publish_date: string | null;
};

export type ContentEditorFormData = {
  title: string;
  description: string;
  body: string;
  bodyFormat: ContentBodyFormat;
  author: string;
  type: string;
  status: string;
  state: string;
  source: string;
  url: string;
  fileKey: string;
  publish_date: string;
  thumbnailAssetId: string | null;
  tags: string[];
  referenceIds: string[];
  references: ContentEditorReference[];
  assetIds: string[];
  assets: ContentEditorAsset[];
  [key: string]: unknown;
};

function getEmptyContentEditorFormData(): ContentEditorFormData {
  return {
    title: '',
    description: '',
    body: '',
    bodyFormat: 'html' as ContentBodyFormat,
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

export function formatDateTimeLocal(value: unknown): string {
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

export function normalizePublishDate(value: unknown): string | null {
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

export function getContentEditorInitialFormData(
  content: ContentEditorInitialContent | null | undefined,
): ContentEditorFormData {
  if (content) {
    const defaults = getEmptyContentEditorFormData();

    return {
      ...defaults,
      ...content,
      title: content.title ?? defaults.title,
      description: content.description ?? defaults.description,
      body: content.body ?? defaults.body,
      bodyFormat: resolveBodyFormat(content.bodyFormat, content.body),
      author: content.author ?? defaults.author,
      type: content.type ?? defaults.type,
      status: content.status ?? defaults.status,
      state: content.state ?? defaults.state,
      source: content.source ?? defaults.source,
      url: content.url ?? defaults.url,
      fileKey: content.fileKey ?? defaults.fileKey,
      thumbnailAssetId: content.thumbnailAssetId ?? defaults.thumbnailAssetId,
      tags: Array.isArray(content.tags) ? content.tags : [],
      referenceIds: Array.isArray(content.referenceIds)
        ? content.referenceIds
        : [],
      references: Array.isArray(content.references) ? content.references : [],
      assetIds: Array.isArray(content.assetIds) ? content.assetIds : [],
      assets: Array.isArray(content.assets) ? content.assets : [],
      publish_date: formatDateTimeLocal(
        content.publish_date ?? content.publishDate,
      ),
    };
  }

  return getEmptyContentEditorFormData();
}

export function getContentEditorSavePayload(
  data: ContentEditorFormData,
): ContentEditorSavePayload {
  const {
    references: _references,
    assets: _assets,
    publishDate: _publishDate,
    ...payload
  } = data;

  return {
    ...payload,
    publish_date: normalizePublishDate(data.publish_date),
  } as ContentEditorSavePayload;
}

export function getContentEditorSnapshot(data: ContentEditorFormData) {
  return {
    ...getContentEditorSavePayload(data),
    referenceIds: [...(data.referenceIds || [])],
    references: [...(data.references || [])],
    assetIds: [...(data.assetIds || [])],
    assets: [...(data.assets || [])],
  };
}
