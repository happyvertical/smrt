/**
 * Unit coverage for safeAttachmentHref (#2904 review, cycle-3 second final
 * F1 addendum) — attachment.url is transport-supplied data bound directly
 * to an <a href> in AssistantDock.svelte and the demo route; only
 * http(s) URLs may ever become a clickable link.
 */
import { describe, expect, it } from 'vitest';
import { safeAttachmentHref } from '../attachment-href.js';

describe('safeAttachmentHref', () => {
  it('returns undefined for a javascript: URL', () => {
    expect(safeAttachmentHref('javascript:alert(1)')).toBeUndefined();
  });

  it('returns undefined for a data: URL', () => {
    expect(
      safeAttachmentHref('data:text/html,<script>alert(1)</script>'),
    ).toBeUndefined();
  });

  it('resolves a relative path against the current origin as http(s)', () => {
    expect(safeAttachmentHref('/files/report.pdf')).toBe('/files/report.pdf');
  });

  it('returns undefined when url is undefined', () => {
    expect(safeAttachmentHref(undefined)).toBeUndefined();
  });

  it('returns the URL unchanged for an absolute http URL', () => {
    expect(safeAttachmentHref('http://example.com/report.pdf')).toBe(
      'http://example.com/report.pdf',
    );
  });

  it('returns the URL unchanged for an absolute https URL', () => {
    expect(safeAttachmentHref('https://example.com/report.pdf')).toBe(
      'https://example.com/report.pdf',
    );
  });

  it('returns undefined for a malformed URL', () => {
    expect(safeAttachmentHref('http://[')).toBeUndefined();
  });
});
