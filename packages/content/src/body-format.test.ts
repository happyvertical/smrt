// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  bodyToEditorHtml,
  editorHtmlToBody,
  extractBodyImages,
  htmlToMarkdown,
  imageAssetToHtml,
  renderMarkdownToHtml,
  resolveBodyFormat,
  sanitizeHtml,
} from './body-format';

describe('content body format utilities', () => {
  it('infers body formats for legacy bodies', () => {
    expect(resolveBodyFormat(undefined, '<p>Hello</p>')).toBe('html');
    expect(resolveBodyFormat(undefined, '# Hello')).toBe('markdown');
    expect(resolveBodyFormat(undefined, '')).toBe('html');
    expect(resolveBodyFormat('markdown', '<p>Hello</p>')).toBe('markdown');
  });

  it('sanitizes unsafe HTML while preserving content images', () => {
    const html = sanitizeHtml(
      '<p onclick="alert(1)">Hello</p><script>alert(1)</script><img src="javascript:alert(1)" onerror="x()" alt="Bad">',
    );

    expect(html).toContain('<p>Hello</p>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).toContain('src="#"');
  });

  it('sanitizes URL-bearing attributes with encoded protocols', () => {
    const html = sanitizeHtml(
      '<svg><a xlink:href="java&#x73;cript&#x3A;alert(1)">click</a></svg><form action="javascript:alert(2)"><button formaction="java&#115;cript:alert(3)">Go</button></form><video poster="javascript:alert(4)"></video><img srcset="javascript:alert(5) 1x, https://example.com/safe.jpg 2x" src="https://example.com/fallback.jpg">',
    );

    expect(html).toContain('xlink:href="#"');
    expect(html).toContain('action="#"');
    expect(html).toContain('formaction="#"');
    expect(html).toContain('poster="#"');
    expect(html).toContain('srcset="https://example.com/safe.jpg 2x"');
    expect(html).not.toMatch(/javascript/i);
  });

  it('keeps safe image layout metadata out of markdown-only output', () => {
    const html = sanitizeHtml(
      '<figure data-smrt-inline-image="true" data-smrt-placement="left" data-smrt-width="320" data-smrt-selected="true" style="width: 320px; position: absolute"><img src="https://example.com/a.jpg" alt="A"></figure>',
    );

    expect(html).toContain('data-smrt-placement="left"');
    expect(html).toContain('data-smrt-width="320"');
    expect(html).toContain('style="width: 320px"');
    expect(html).not.toContain('data-smrt-selected');
    expect(html).not.toContain('position');

    const markdown = htmlToMarkdown(html);
    expect(markdown).toBe('![A](https://example.com/a.jpg)');
  });

  it('renders markdown links and images as safe HTML', () => {
    const html = renderMarkdownToHtml(
      '# Title\n\nSee [docs](https://example.com) ![Alt](https://example.com/a.jpg)',
    );

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).toContain('<img src="https://example.com/a.jpg" alt="Alt">');
  });

  it('creates direct editor image HTML with bounded layout metadata', () => {
    const html = imageAssetToHtml({
      id: 'asset-1',
      name: 'Inline',
      sourceUri: 'https://example.com/inline.jpg',
      width: 1200,
    });

    expect(html).toContain('<img ');
    expect(html).not.toContain('<figure');
    expect(html).toContain('data-smrt-inline-image="true"');
    expect(html).toContain('data-smrt-placement="block"');
    expect(html).toContain('data-smrt-width="520"');
  });

  it('keeps standalone markdown images out of editable paragraphs', () => {
    const html = bodyToEditorHtml(
      'Intro\n\n![Inline](https://example.com/inline.jpg)\n\nMore',
      'markdown',
    );

    expect(html).toMatch(/<p>\s*Intro\s*<\/p>/);
    expect(html).toContain('<img src="https://example.com/inline.jpg"');
    expect(html).not.toContain('<p><img src="https://example.com/inline.jpg"');
    expect(html).toMatch(/<p>\s*More\s*<\/p>/);
  });

  it('converts editor HTML to markdown for markdown saves', () => {
    const markdown = editorHtmlToBody(
      '<h2>Heading</h2><p>Hello <strong>world</strong></p><figure><img src="https://example.com/a.jpg" alt="Alt"></figure>',
      'markdown',
    );

    expect(markdown).toContain('## Heading');
    expect(markdown).toContain('Hello **world**');
    expect(markdown).toContain('![Alt](https://example.com/a.jpg)');
  });

  it('extracts HTML and markdown body images', () => {
    expect(
      extractBodyImages(
        '<p>Hi</p><img src="https://example.com/a.jpg" alt="A" data-smrt-asset-id="asset-1">',
        'html',
      ),
    ).toEqual([
      {
        src: 'https://example.com/a.jpg',
        alt: 'A',
        assetId: 'asset-1',
        index: 0,
      },
    ]);

    expect(
      extractBodyImages(
        '<figure data-smrt-inline-image="true" data-smrt-placement="right" data-smrt-width="280" style="width: 280px"><img src="https://example.com/c.jpg" alt="C" data-smrt-asset-id="asset-2"></figure>',
        'html',
      ),
    ).toEqual([
      {
        src: 'https://example.com/c.jpg',
        alt: 'C',
        assetId: 'asset-2',
        placement: 'right',
        width: 280,
        index: 0,
      },
    ]);

    expect(
      extractBodyImages('![B](https://example.com/b.jpg)', 'markdown'),
    ).toEqual([
      {
        src: 'https://example.com/b.jpg',
        alt: 'B',
        index: 0,
      },
    ]);
  });

  it('loads markdown into editor HTML and exports HTML bodies to markdown', () => {
    expect(
      bodyToEditorHtml('![Alt](https://example.com/a.jpg)', 'markdown'),
    ).toContain('<img src="https://example.com/a.jpg" alt="Alt">');
    expect(htmlToMarkdown('<p>Hello</p>')).toBe('Hello');
  });
});
