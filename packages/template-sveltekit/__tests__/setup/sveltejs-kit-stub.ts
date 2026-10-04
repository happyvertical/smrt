/**
 * Minimal `@sveltejs/kit` runtime stub for tests.
 *
 * Template route modules (`+page.server.ts`) and the workspace
 * `@happyvertical/smrt-app-runtime/sveltekit` handlers they mount (vitest
 * inlines that linked package, so the alias reaches it too) import runtime
 * helpers from `@sveltejs/kit`; `vitest.config.ts` aliases the
 * module here. Only the helpers those modules use are stubbed.
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

/** Behavioral stand-in for SvelteKit's thrown `Redirect`. */
export class Redirect {
  constructor(
    readonly status: number,
    readonly location: string,
  ) {}
}

/**
 * Behavioral stand-in for SvelteKit's `redirect()`, used by the owner setup
 * page from `@happyvertical/smrt-app-runtime/sveltekit`: it always throws.
 */
export function redirect(status: number, location: string | URL): never {
  throw new Redirect(status, location.toString());
}
