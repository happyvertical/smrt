// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  bodyHasImage,
  editorHtmlToBody,
  extractBodyImages,
  placeThumbnailInBody,
  renderContentBodyHtml,
  resolveBodyMainPicture,
  setBodyMainImage,
} from './body-format';

function img(assetId: string, extra = ''): string {
  return `<img src="/a/${assetId}.jpg" alt="" data-smrt-asset-id="${assetId}" data-smrt-inline-image="true"${extra}>`;
}

const BODY = `<p>One</p>${img('a-1')}<p>Two</p>${img('a-2')}<p>Three</p>`;

describe('resolveBodyMainPicture', () => {
  it('uses the first picture in the story when none is chosen', () => {
    expect(resolveBodyMainPicture(BODY, 'html')).toEqual({
      assetId: 'a-1',
      mode: 'automatic',
    });
  });

  it('keeps the current value when the story has no pictures', () => {
    expect(resolveBodyMainPicture('<p>Text</p>', 'html', 'old')).toEqual({
      assetId: 'old',
      mode: 'none',
    });
    expect(resolveBodyMainPicture('', 'html')).toEqual({
      assetId: null,
      mode: 'none',
    });
  });

  it('prefers a picture the person chose', () => {
    const body = setBodyMainImage(BODY, 'html', 'a-2');
    expect(resolveBodyMainPicture(body, 'html')).toEqual({
      assetId: 'a-2',
      mode: 'chosen',
    });
  });

  it('keeps the choice when pictures are reordered', () => {
    const chosen = setBodyMainImage(BODY, 'html', 'a-2');
    const [first, second] = chosen.match(/<img\b[^>]*>/g) ?? [];
    const reordered = chosen
      .replace(first, '__FIRST__')
      .replace(second, first)
      .replace('__FIRST__', second);
    expect(extractBodyImages(reordered, 'html')[0].assetId).toBe('a-2');
    expect(resolveBodyMainPicture(reordered, 'html').assetId).toBe('a-2');

    const moved = `<p>Zero</p>${img('a-3')}${reordered}`;
    expect(resolveBodyMainPicture(moved, 'html')).toEqual({
      assetId: 'a-2',
      mode: 'chosen',
    });
  });

  it('treats a thumbnail block as the chosen picture', () => {
    const body = placeThumbnailInBody(BODY, 'html', {
      src: '/a/a-9.jpg',
      assetId: 'a-9',
      width: 1600,
      height: 900,
    });
    expect(resolveBodyMainPicture(body, 'html')).toEqual({
      assetId: 'a-9',
      mode: 'chosen',
    });
  });

  it('ignores pictures without an asset id and Markdown bodies', () => {
    expect(
      resolveBodyMainPicture('<img src="/x.jpg" alt="">', 'html', null).mode,
    ).toBe('none');
    expect(resolveBodyMainPicture('![x](/x.jpg)', 'markdown', 'k')).toEqual({
      assetId: 'k',
      mode: 'none',
    });
  });
});

describe('setBodyMainImage', () => {
  it('marks only the chosen picture and clears earlier choices', () => {
    const first = setBodyMainImage(BODY, 'html', 'a-1');
    const second = setBodyMainImage(first, 'html', 'a-2');
    const images = extractBodyImages(second, 'html');
    expect(images.map((image) => Boolean(image.main))).toEqual([false, true]);
  });

  it('clears the choice with null', () => {
    const chosen = setBodyMainImage(BODY, 'html', 'a-2');
    const cleared = setBodyMainImage(chosen, 'html', null);
    expect(cleared).toBe(BODY);
    expect(resolveBodyMainPicture(cleared, 'html').mode).toBe('automatic');
  });

  it('leaves Markdown and unknown pictures alone', () => {
    expect(setBodyMainImage('![x](/x.jpg)', 'markdown', 'a-1')).toBe(
      '![x](/x.jpg)',
    );
    expect(setBodyMainImage(BODY, 'html', 'missing')).toBe(BODY);
  });

  it('survives the editor round trip and public rendering', () => {
    const chosen = setBodyMainImage(BODY, 'html', 'a-2');
    const roundTripped = editorHtmlToBody(chosen, 'html');
    expect(resolveBodyMainPicture(roundTripped, 'html').assetId).toBe('a-2');
    expect(renderContentBodyHtml(chosen, 'html')).toContain(
      'data-smrt-main="true"',
    );
  });
});

describe('bodyHasImage', () => {
  it('finds a story picture by asset id, not the thumbnail block', () => {
    expect(bodyHasImage(BODY, 'html', 'a-2')).toBe(true);
    expect(bodyHasImage(BODY, 'html', 'a-3')).toBe(false);
    const withBlock = placeThumbnailInBody('<p>x</p>', 'html', {
      src: '/a/a-9.jpg',
      assetId: 'a-9',
    });
    expect(bodyHasImage(withBlock, 'html', 'a-9')).toBe(false);
  });
});

describe('Markdown bodies', () => {
  const HTML = `<p>One</p>${img('a-1')}<p>Two</p>${img('a-2')}`;

  it('keep asset ids through the editor round trip', () => {
    const markdown = editorHtmlToBody(HTML, 'markdown');
    expect(markdown).toContain('"smrt-image a-1"');
    expect(
      extractBodyImages(markdown, 'markdown').map((i) => i.assetId),
    ).toEqual(['a-1', 'a-2']);
    expect(resolveBodyMainPicture(markdown, 'markdown')).toEqual({
      assetId: 'a-1',
      mode: 'automatic',
    });
    // Rendering turns the markers back into attributes, never a title.
    const html = renderContentBodyHtml(markdown, 'markdown');
    expect(html).toContain('data-smrt-asset-id="a-2"');
    expect(html).not.toContain('title=');
  });

  it('mark and clear the chosen main picture', () => {
    const markdown = editorHtmlToBody(HTML, 'markdown');
    const chosen = setBodyMainImage(markdown, 'markdown', 'a-2');
    expect(chosen).toContain('"smrt-image a-2 main"');
    expect(resolveBodyMainPicture(chosen, 'markdown')).toEqual({
      assetId: 'a-2',
      mode: 'chosen',
    });
    expect(renderContentBodyHtml(chosen, 'markdown')).toContain(
      'data-smrt-main="true"',
    );
    // The choice survives rendering back into the editor and out again.
    const editorHtml = renderContentBodyHtml(chosen, 'markdown');
    expect(
      resolveBodyMainPicture(
        editorHtmlToBody(editorHtml, 'markdown'),
        'markdown',
      ).assetId,
    ).toBe('a-2');
    expect(setBodyMainImage(chosen, 'markdown', null)).toBe(markdown);
  });

  it('keep the thumbnail block asset id', () => {
    const body = placeThumbnailInBody('Para one.\n\nPara two.', 'markdown', {
      src: '/a/a-9.jpg',
      assetId: 'a-9',
      width: 1600,
      height: 900,
    });
    expect(body).toContain('"smrt-thumbnail:full a-9"');
    expect(resolveBodyMainPicture(body, 'markdown')).toEqual({
      assetId: 'a-9',
      mode: 'chosen',
    });
  });
});
