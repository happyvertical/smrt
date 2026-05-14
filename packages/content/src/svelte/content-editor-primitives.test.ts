import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ContentEditorFieldChange,
  createContentEditorState,
  getContentEditorAssetImageSource,
  resolveContentEditorImageSelection,
} from './index';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('preserves non-string field values through field update undo', () => {
    const editor = createContentEditorState({
      content: {
        tags: ['council'],
        thumbnailAssetId: null,
      },
    });

    editor.applyFieldUpdates({
      tags: ['budget', 'capital-plan'],
      thumbnailAssetId: 'asset-2',
    });

    expect(editor.form.tags).toEqual(['budget', 'capital-plan']);
    expect(editor.form.thumbnailAssetId).toBe('asset-2');

    editor.undoLastFieldUpdate();

    expect(editor.form.tags).toEqual(['council']);
    expect(editor.form.thumbnailAssetId).toBeNull();
  });

  it('skips incompatible non-string field updates', () => {
    const editor = createContentEditorState({
      content: {
        tags: ['council'],
      },
    });

    editor.applyFieldUpdates({
      tags: 'budget',
    } as unknown as ContentEditorFieldChange);

    expect(editor.form.tags).toEqual(['council']);
    expect(editor.undoDepth).toBe(0);
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

  it('returns null for invalid string image selections', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      resolveContentEditorImageSelection('/api/v1', 'not a url'),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the URL extension when creating image records from strings', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'asset-1',
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    await expect(
      resolveContentEditorImageSelection(
        '/api/v1',
        'https://example.com/photos/hero.webp?width=1200',
      ),
    ).resolves.toEqual({ id: 'asset-1' });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      name: 'hero.webp',
      sourceUri: 'https://example.com/photos/hero.webp?width=1200',
      mimeType: 'image/webp',
    });
  });
});
