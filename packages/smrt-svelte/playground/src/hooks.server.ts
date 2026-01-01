import type { Handle } from '@sveltejs/kit';

/**
 * SvelteKit server hooks
 *
 * Adds cross-origin isolation headers required for @remotion/whisper-web
 * (SharedArrayBuffer support)
 */
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Add cross-origin isolation headers for SharedArrayBuffer support
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

  return response;
};
