/**
 * "New <noun>" on a section's page opens the entry page with its create form
 * already open. The request is remembered here, not in the URL (the address
 * bar mirrors only the shareable state), and the entry page takes it once its
 * list has loaded. It names the page it is for and expires, so a navigation
 * that never happened cannot open a form on a later visit.
 */
const TTL_MS = 5000;

let pending: { path: string; at: number } | undefined;

/** Ask the page at `path` (a pathname, any query ignored) to open New. */
export function requestCreate(path: string, now: number = Date.now()): void {
  pending = { path: pathOf(path), at: now };
}

/** True once, on the page the request named, shortly after it was made. */
export function takeCreate(path: string, now: number = Date.now()): boolean {
  const request = pending;
  pending = undefined;
  return (
    !!request && request.path === pathOf(path) && now - request.at <= TTL_MS
  );
}

function pathOf(href: string): string {
  return href.split(/[?#]/)[0] ?? href;
}
