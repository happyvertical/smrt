/**
 * Safe attachment `href` resolution (#2904 review, cycle-3 second final F1
 * addendum).
 *
 * `AssistantAttachmentRef.url` is transport-supplied data, not something
 * this package controls or validates upstream — `AssistantDock.svelte` and
 * the demo route both bound it directly to an `<a href>`, so a transport
 * that echoes back (or a message history that contains) a `javascript:` or
 * other non-http(s) URL would render a clickable attachment link capable of
 * executing script in the viewer's context. Only `http:`/`https:` URLs are
 * ever rendered as a link; anything else renders the attachment name as
 * plain text instead.
 */

/**
 * Returns `url` unchanged when it resolves to an `http:`/`https:` URL
 * (absolute or relative — a relative path resolves against the current
 * origin, or `http://localhost` outside a browser, e.g. under SSR/test).
 * Returns `undefined` for anything else (`javascript:`, `data:`, a
 * malformed string, or no `url` at all), so callers can render plain text
 * instead of an anchor.
 */
export function safeAttachmentHref(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url, globalThis.location?.origin ?? 'http://localhost');
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  return url;
}
