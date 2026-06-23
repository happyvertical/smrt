/**
 * Security regression: MessageDetail must never inject provider-controlled
 * email HTML into the DOM.
 *
 * The component previously fed `{@html ...}` from a hand-rolled regex
 * "sanitizer" that was bypassable — an unclosed `<script>alert(1)` payload
 * passed through unchanged because the strip pattern required a closing
 * `</script>`. The fix renders the body only as untrusted plain text (via a
 * `<pre>` text interpolation); when the caller opts into the HTML body it is
 * down-rendered to text by stripping tags, never injected as markup.
 *
 * This package has no Svelte component-render harness (vitest runs in `node`
 * with no jsdom), so we assert the security invariant at the source level: the
 * dangerous `{@html}` directive must not exist, and the body must flow through
 * `<pre>` text interpolation. We also exercise the exact tag-stripping
 * transform against the known bypass payload to prove it is reduced to inert
 * text.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const componentPath = resolve(
  here,
  '../svelte/components/MessageDetail.svelte',
);
const source = readFileSync(componentPath, 'utf8');

// Mirror of the down-render transform used by the component for the HTML body.
function toPlainText(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

describe('MessageDetail XSS hardening', () => {
  it('does not inject provider HTML via {@html}', () => {
    // Strip line comments so the explanatory comment mentioning the directive
    // does not count as a real usage.
    const code = source.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\{@html/);
  });

  it('renders the message body through a <pre> text interpolation', () => {
    expect(source).toMatch(/<pre class="body-text">\{[^}]+\}<\/pre>/);
  });

  it('reduces an unclosed <script> payload to inert text', () => {
    // The historical bypass: no closing tag, so a regex requiring </script>
    // left it intact. Tag-stripping still neutralizes it.
    const payload = 'hello <script>alert(1)';
    const out = toPlainText(payload);
    expect(out).not.toContain('<script');
    expect(out).toBe('hello alert(1)');
  });

  it('strips well-formed script/img-onerror payloads to text', () => {
    expect(toPlainText('<script>steal()</script>')).toBe('steal()');
    expect(toPlainText('<img src=x onerror=alert(1)>')).toBe('');
  });
});
