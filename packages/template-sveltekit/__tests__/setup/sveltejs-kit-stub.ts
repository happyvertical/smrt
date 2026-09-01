/**
 * Minimal `@sveltejs/kit` runtime stub for tests.
 *
 * `@sveltejs/kit` is a dependency of scaffolded consumer projects, not of
 * this template package. Template route modules (`+page.server.ts`) import
 * runtime helpers from it, so `vitest.config.ts` aliases the module here.
 * Only the helpers the template actually uses are stubbed; add more if the
 * template grows.
 */

/**
 * Behavioral stand-in for SvelteKit's `fail()`: brands the payload so tests
 * can distinguish action failures from success results, mirroring the shape
 * (`status` + `data`) of the real `ActionFailure`.
 */
export function fail(status: number, data?: Record<string, unknown>) {
  return { status, data, __isActionFailure: true };
}

/** Behavioral stand-in for SvelteKit's JSON response helper. */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
