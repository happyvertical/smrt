import { describe, expect, it } from 'vitest';
import {
  type ContentEditorFormData,
  formatDateTimeLocal,
  getContentEditorInitialFormData,
  getContentEditorSavePayload,
  getContentEditorSnapshot,
  normalizePublishDate,
} from './content-editor-form';

describe('content editor form helpers', () => {
  it('creates normalized initial form data from content records', () => {
    const formData = getContentEditorInitialFormData({
      title: 'Council update',
      body: '# Agenda',
      bodyFormat: 'markdown',
      publishDate: '2026-04-05T10:30:00.000Z',
      tags: ['council'],
      referenceIds: ['ref-1'],
      references: [{ id: 'ref-1', title: 'Minutes' }],
      assetIds: ['asset-1'],
      assets: [{ id: 'asset-1', sourceUri: 'https://example.com/image.jpg' }],
    });

    expect(formData).toMatchObject({
      title: 'Council update',
      bodyFormat: 'markdown',
      tags: ['council'],
      referenceIds: ['ref-1'],
      assetIds: ['asset-1'],
    });
    expect(formData.publish_date).toMatch(/^2026-04-05T/);
  });

  it('uses safe empty defaults for new content', () => {
    expect(getContentEditorInitialFormData(undefined)).toMatchObject({
      title: '',
      body: '',
      bodyFormat: 'html',
      type: 'article',
      status: 'draft',
      state: 'active',
      publish_date: '',
      referenceIds: [],
      assetIds: [],
    });
  });

  it('normalizes publish dates for local datetime inputs', () => {
    const localValue = '2026-04-05T10:30';

    expect(formatDateTimeLocal(localValue)).toBe(localValue);
    expect(normalizePublishDate(localValue)).toBe(
      new Date(localValue).toISOString(),
    );
    expect(normalizePublishDate('')).toBeNull();
  });

  it('omits hydrated and legacy alias fields from save payloads', () => {
    const data = {
      ...getContentEditorInitialFormData(undefined),
      title: 'Save me',
      publish_date: '2026-04-05T10:30',
      publishDate: 'legacy',
      references: [{ id: 'ref-1' }],
      assets: [{ id: 'asset-1' }],
      referenceIds: ['ref-1'],
      assetIds: ['asset-1'],
    } satisfies ContentEditorFormData;

    const payload = getContentEditorSavePayload(data);

    expect(payload).toMatchObject({
      title: 'Save me',
      referenceIds: ['ref-1'],
      assetIds: ['asset-1'],
      publish_date: new Date('2026-04-05T10:30').toISOString(),
    });
    expect('references' in payload).toBe(false);
    expect('assets' in payload).toBe(false);
    expect('publishDate' in payload).toBe(false);
  });

  it('keeps hydrated fields in snapshots for editor consumers', () => {
    const snapshot = getContentEditorSnapshot({
      ...getContentEditorInitialFormData(undefined),
      references: [{ id: 'ref-1' }],
      assets: [{ id: 'asset-1' }],
    });

    expect(snapshot.references).toEqual([{ id: 'ref-1' }]);
    expect(snapshot.assets).toEqual([{ id: 'asset-1' }]);
  });
});
