import type { ContentBodyFormat } from '../body-format';
import { resolveBodyFormat } from '../body-format';

export type ContentEditorFormData = Record<string, any> & {
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
  references: any[];
  assetIds: string[];
  assets: any[];
};

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

export function getContentEditorInitialFormData(
  content: any,
): ContentEditorFormData {
  if (content) {
    return {
      ...content,
      bodyFormat: resolveBodyFormat(content.bodyFormat, content.body),
      tags: content.tags || [],
      referenceIds: content.referenceIds || [],
      references: content.references || [],
      assetIds: content.assetIds || [],
      assets: content.assets || [],
      publish_date: formatDateTimeLocal(
        content.publish_date ?? content.publishDate,
      ),
    };
  }

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

export function getContentEditorSavePayload(data: Record<string, any>) {
  const { references: _references, assets: _assets, ...payload } = data;

  return {
    ...payload,
    publish_date: normalizePublishDate(data.publish_date),
  };
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
