import { describe, expect, it } from 'vitest';
import {
  createContentEditorState,
  getContentEditorAssetImageSource,
} from './index';

describe('content editor primitives', () => {
  it('creates editable form state from initial content', () => {
    const editor = createContentEditorState({
      content: {
        title: 'Council update',
        body: '<p>Draft</p>',
        bodyFormat: 'html',
        referenceIds: ['ref-1'],
        assetIds: ['asset-1'],
        assets: [{ id: 'asset-1', sourceUri: 'https://example.com/image.jpg' }],
      },
    });

    expect(editor.form.title).toBe('Council update');
    expect(editor.snapshot.referenceIds).toEqual(['ref-1']);
    expect('assets' in editor.savePayload).toBe(false);
  });

  it('tracks assistant field updates and restores them with undo', () => {
    const editor = createContentEditorState({
      content: {
        title: 'Original title',
        description: 'Original deck',
      },
    });

    editor.applyFieldUpdates({
      title: 'Updated title',
      description: 'Updated deck',
    });

    expect(editor.form.title).toBe('Updated title');
    expect(editor.lastAppliedFields).toEqual(['title', 'description']);
    expect(editor.showUndoBanner).toBe(true);

    editor.undoLastFieldUpdate();

    expect(editor.form.title).toBe('Original title');
    expect(editor.form.description).toBe('Original deck');
    expect(editor.showUndoBanner).toBe(false);
  });

  it('manages editor assets and thumbnail selection', () => {
    const editor = createContentEditorState();

    editor.addAsset({
      id: 'asset-1',
      sourceUri: 'https://example.com/image.jpg',
    });

    expect(editor.form.assetIds).toEqual(['asset-1']);
    expect(editor.form.thumbnailAssetId).toBe('asset-1');

    editor.removeAsset('asset-1');

    expect(editor.form.assetIds).toEqual([]);
    expect(editor.form.thumbnailAssetId).toBeNull();
  });

  it('resolves preview sources from common asset fields', () => {
    expect(
      getContentEditorAssetImageSource({
        thumbnailUrl: 'https://example.com/thumb.jpg',
        url: 'https://example.com/full.jpg',
      }),
    ).toBe('https://example.com/thumb.jpg');

    expect(
      getContentEditorAssetImageSource({
        src: 'https://example.com/src.jpg',
      }),
    ).toBe('https://example.com/src.jpg');
  });
});
