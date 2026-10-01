// @vitest-environment node

// Public town pages prerender bodies in Node, where there is no DOM: the
// sanitizer must give the same answer there as in the browser.

import { describe, expect, it } from 'vitest';
import { placeThumbnailInBody, renderContentBodyHtml } from './body-format';

describe('body sanitizer without a DOM (SSR / prerender)', () => {
  it('runs with no DOMParser or document', () => {
    expect((globalThis as Record<string, unknown>).DOMParser).toBeUndefined();
    expect((globalThis as Record<string, unknown>).document).toBeUndefined();
  });

  it('neutralizes the nested-tag bypass', () => {
    const html = renderContentBodyHtml(
      '<p>Hi</p><scr<script>ipt>alert(1)</scr<script>ipt><img src=x onerror=alert(1)>',
      'html',
    );
    expect(html).toBe('<p>Hi</p>ipt&gt;alert(1)ipt&gt;<img src="x">');
  });

  it('renders thumbnail blocks unchanged', () => {
    const body = placeThumbnailInBody('<p>First</p>', 'html', {
      src: 'https://example.com/wide.jpg',
      alt: 'Wide',
      width: 1600,
      height: 900,
    });
    expect(renderContentBodyHtml(body, 'html')).toBe(body);
  });
});
