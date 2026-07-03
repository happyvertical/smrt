/**
 * Shared runtime source injected into every generated API client
 * (`smrtPlugin`'s `@happyvertical/smrt-virt-client` and `smrtConsumer`'s
 * `@smrt/client` fallback).
 *
 * The generated fetchers MUST reject on `!response.ok` (#1796): before this,
 * every fetcher resolved `r.json()` regardless of HTTP status, so a 500 (or any
 * error response) resolved successfully with the error payload. Mutation
 * failures were therefore invisible to callers — an optimistic-update layer
 * (e.g. TanStack DB `onInsert`) could never observe the failure and roll back.
 *
 * `SmrtClientError` carries the HTTP `status` and the parsed error `body` (when
 * the response was JSON), so callers can branch on status and surface server
 * messages. Both helpers are emitted with a `__smrt` prefix so they cannot
 * collide with a collection key in the generated module.
 *
 * WIRE-SHAPE POLICY (#1797, ADR 0001): the server returns BARE JSON — a bare
 * array for list, a bare object for get/create/update — with snake_case field
 * names (`created_at`, `updated_at`) exactly as `SmrtObject.toJSON()` emits
 * them. These helpers pass that JSON through unchanged; they do NOT wrap it in
 * an envelope or camelCase the keys. The generated `.d.ts` declarations
 * (vite-plugin + prebuild) are written to match this shape. This same
 * snake_case wire feeds the mobile DTO codegen; do not change the wire here.
 */
export const CLIENT_FETCH_RUNTIME = `class SmrtClientError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SmrtClientError';
    this.status = status;
    this.body = body;
  }
}

async function __smrtParseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

// Rejects on !response.ok with a typed SmrtClientError; otherwise resolves the
// parsed JSON body exactly as the server sent it (bare array/object, snake_case
// fields).
async function __smrtFetchJson(url, init) {
  const response = await fetch(url, init);
  const body = await __smrtParseBody(response);
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && body.error ? ': ' + body.error : '';
    throw new SmrtClientError(
      'Request failed with status ' + response.status + detail,
      response.status,
      body,
    );
  }
  return body;
}

// DELETE variant: rejects on !response.ok (so a failed delete is observable),
// otherwise resolves true.
async function __smrtFetchOk(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await __smrtParseBody(response);
    const detail =
      body && typeof body === 'object' && body.error ? ': ' + body.error : '';
    throw new SmrtClientError(
      'Request failed with status ' + response.status + detail,
      response.status,
      body,
    );
  }
  return true;
}`;
