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

  it('makes the first story picture the main picture unless one is chosen', () => {
    const img = (id: string, extra = '') =>
      `<img src="/a/${id}.jpg" alt="" data-smrt-asset-id="${id}"${extra}>`;
    const editor = createContentEditorState({
      content: {
        body: '<p>Text</p>',
        bodyFormat: 'html',
        thumbnailAssetId: 'legacy',
      },
    });

    // Editing text keeps a thumbnail that was set some other way.
    editor.update({ body: '<p>Text, edited</p>' });
    expect(editor.syncMainPictureFromBody()).toBe(false);
    expect(editor.form.thumbnailAssetId).toBe('legacy');

    // The first picture in the story becomes the main picture.
    editor.update({ body: `<p>Text</p>${img('a-1')}${img('a-2')}` });
    expect(editor.syncMainPictureFromBody()).toBe(true);
    expect(editor.form.thumbnailAssetId).toBe('a-1');
    expect(editor.mainPicture.mode).toBe('automatic');

    // Reordering follows the first picture…
    editor.update({ body: `<p>Text</p>${img('a-2')}${img('a-1')}` });
    editor.syncMainPictureFromBody();
    expect(editor.form.thumbnailAssetId).toBe('a-2');

    // …until one is chosen; the choice sticks through a reorder.
    editor.update({
      body: `<p>Text</p>${img('a-2')}${img('a-1', ' data-smrt-main="true"')}`,
    });
    editor.syncMainPictureFromBody();
    expect(editor.form.thumbnailAssetId).toBe('a-1');
    editor.update({
      body: `<p>Text</p>${img('a-1', ' data-smrt-main="true"')}<p>x</p>${img('a-2')}`,
    });
    editor.syncMainPictureFromBody();
    editor.update({
      body: `${img('a-2')}<p>Text</p>${img('a-1', ' data-smrt-main="true"')}`,
    });
    editor.syncMainPictureFromBody();
    expect(editor.form.thumbnailAssetId).toBe('a-1');
    expect(editor.mainPicture.mode).toBe('chosen');
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
