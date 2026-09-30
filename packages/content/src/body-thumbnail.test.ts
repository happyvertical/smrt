// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  bodyHasThumbnail,
  bodyToEditorHtml,
  editorHtmlToBody,
  extractBodyImages,
  placeThumbnailInBody,
  removeThumbnailFromBody,
  renderContentBodyHtml,
  thumbnailPlacementForSize,
} from './body-format';

const WIDE = {
  src: 'https://cdn.test/wide.jpg',
  assetId: 'a-wide',
  width: 1600,
  height: 900,
};
const PORTRAIT = {
  src: 'https://cdn.test/tall.jpg',
  assetId: 'a-tall',
  width: 800,
  height: 1200,
};
const SQUARE = {
  src: 'https://cdn.test/square.jpg',
  assetId: 'a-sq',
  width: 1000,
  height: 1000,
};

function countThumbnails(html: string): number {
  return (html.match(/data-smrt-thumbnail="true"/g) || []).length;
}

describe('thumbnailPlacementForSize', () => {
  it('puts wide images in the header and portrait/square ones on the right', () => {
    expect(thumbnailPlacementForSize(1600, 900)).toBe('full');
    expect(thumbnailPlacementForSize(1300, 1000)).toBe('full');
    expect(thumbnailPlacementForSize(1290, 1000)).toBe('right');
    expect(thumbnailPlacementForSize(1000, 1000)).toBe('right');
    expect(thumbnailPlacementForSize(800, 1200)).toBe('right');
  });

  it('defaults to the header when the size is unknown', () => {
    expect(thumbnailPlacementForSize(undefined, 900)).toBe('full');
    expect(thumbnailPlacementForSize(0, 0)).toBe('full');
  });
});

describe('placeThumbnailInBody (HTML)', () => {
  const body = '<h2>Council</h2><p>First paragraph.</p><p>Second.</p>';

  it('puts a wide thumbnail first, full width', () => {
    const next = placeThumbnailInBody(body, 'html', WIDE);
    expect(next.startsWith('<img src="https://cdn.test/wide.jpg"')).toBe(true);
    expect(next).toContain('data-smrt-placement="full"');
    expect(next).toContain('data-smrt-asset-id="a-wide"');
    expect(countThumbnails(next)).toBe(1);
  });

  it('floats a portrait thumbnail right, just before the first paragraph', () => {
    const next = placeThumbnailInBody(body, 'html', PORTRAIT);
    expect(next).toMatch(
      /^<h2>Council<\/h2><img [^>]*data-smrt-placement="right"[^>]*>\n<p>First paragraph\.<\/p>/,
    );
  });

  it('treats a square thumbnail like a portrait one', () => {
    expect(placeThumbnailInBody(body, 'html', SQUARE)).toContain(
      'data-smrt-placement="right"',
    );
  });

  it('replaces the previous thumbnail block instead of adding another', () => {
    const once = placeThumbnailInBody(body, 'html', WIDE);
    const twice = placeThumbnailInBody(once, 'html', PORTRAIT);
    const thrice = placeThumbnailInBody(twice, 'html', PORTRAIT);
    expect(countThumbnails(thrice)).toBe(1);
    expect(thrice).not.toContain('wide.jpg');
    expect(thrice).toContain('tall.jpg');
    expect(thrice).toContain('<p>Second.</p>');
  });

  it('replaces a block the editor wrapped in a paragraph or figure', () => {
    const wrapped = `<p><img src="https://cdn.test/old.jpg" data-smrt-thumbnail="true"></p>${body}`;
    const figure = `<figure data-smrt-inline-image="true"><img src="https://cdn.test/old.jpg" data-smrt-thumbnail="true"></figure>${body}`;
    for (const start of [wrapped, figure]) {
      const next = placeThumbnailInBody(start, 'html', WIDE);
      expect(next).not.toContain('old.jpg');
      expect(countThumbnails(next)).toBe(1);
    }
  });

  it('leaves other images alone', () => {
    const withInline = `${body}<img src="https://cdn.test/inline.jpg" data-smrt-inline-image="true">`;
    const next = removeThumbnailFromBody(
      placeThumbnailInBody(withInline, 'html', WIDE),
      'html',
    );
    expect(next).toContain('inline.jpg');
    expect(countThumbnails(next)).toBe(0);
  });

  it('removes the block when the thumbnail is cleared', () => {
    const placed = placeThumbnailInBody(body, 'html', PORTRAIT);
    expect(bodyHasThumbnail(placed, 'html')).toBe(true);
    const removed = removeThumbnailFromBody(placed, 'html');
    expect(bodyHasThumbnail(removed, 'html')).toBe(false);
    expect(removed).toContain('<p>First paragraph.</p>');
  });

  it('writes the block into an empty body', () => {
    expect(placeThumbnailInBody('', 'html', WIDE)).toMatch(/^<img [^>]*>$/);
  });

  it('survives the editor round trip', () => {
    const placed = placeThumbnailInBody(body, 'html', PORTRAIT);
    const roundTrip = editorHtmlToBody(
      bodyToEditorHtml(placed, 'html'),
      'html',
    );
    expect(countThumbnails(roundTrip)).toBe(1);
    expect(extractBodyImages(roundTrip, 'html')[0]).toMatchObject({
      thumbnail: true,
      placement: 'right',
      assetId: 'a-tall',
    });
  });
});

describe('placeThumbnailInBody (Markdown)', () => {
  const body = '## Council\n\nFirst paragraph.\n\nSecond.';

  it('puts a wide thumbnail first with the header token', () => {
    const next = placeThumbnailInBody(body, 'markdown', WIDE);
    expect(next).toBe(
      `![](https://cdn.test/wide.jpg "smrt-thumbnail:full")\n\n${body}`,
    );
  });

  it('puts a portrait thumbnail before the first paragraph', () => {
    const next = placeThumbnailInBody(body, 'markdown', PORTRAIT);
    expect(next).toBe(
      '## Council\n\n![](https://cdn.test/tall.jpg "smrt-thumbnail:right")\n\nFirst paragraph.\n\nSecond.',
    );
  });

  it('replaces instead of duplicating', () => {
    const once = placeThumbnailInBody(body, 'markdown', PORTRAIT);
    const twice = placeThumbnailInBody(once, 'markdown', WIDE);
    expect(twice.match(/smrt-thumbnail:/g)).toHaveLength(1);
    expect(twice).toContain('wide.jpg');
    expect(removeThumbnailFromBody(twice, 'markdown')).toBe(body);
  });

  it('renders the token as the same marked image HTML bodies use', () => {
    const html = renderContentBodyHtml(
      placeThumbnailInBody(body, 'markdown', PORTRAIT),
      'markdown',
    );
    expect(html).toMatch(
      /<img src="https:\/\/cdn\.test\/tall\.jpg" alt="" data-smrt-thumbnail="true" data-smrt-inline-image="true" data-smrt-placement="right">/,
    );
    expect(html).not.toContain('title=');
  });

  it('keeps the token through the editor (HTML ↔ Markdown) round trip', () => {
    const placed = placeThumbnailInBody(body, 'markdown', PORTRAIT);
    const roundTrip = editorHtmlToBody(
      bodyToEditorHtml(placed, 'markdown'),
      'markdown',
    );
    expect(roundTrip).toContain('"smrt-thumbnail:right"');
    expect(bodyHasThumbnail(roundTrip, 'markdown')).toBe(true);
  });
});

describe('renderContentBodyHtml', () => {
  it('swaps the thumbnail source for the renderer origin only', () => {
    const body = placeThumbnailInBody(
      '<p>Text <img src="https://cdn.test/inline.jpg"></p>',
      'html',
      WIDE,
    );
    const html = renderContentBodyHtml(body, 'html', {
      thumbnailSrc: 'https://town.test/assets/a-wide',
    });
    expect(html).toContain('src="https://town.test/assets/a-wide"');
    expect(html).toContain('src="https://cdn.test/inline.jpg"');
  });

  it('sanitizes both formats', () => {
    expect(renderContentBodyHtml('<p onclick="x()">Hi</p>', 'html')).toBe(
      '<p>Hi</p>',
    );
    expect(
      renderContentBodyHtml('<script>x()</script>Hi', 'markdown'),
    ).not.toContain('<script');
  });
});
