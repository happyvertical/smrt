import type { OnboardingClient, OnboardingState } from './types.js';

/** Authenticated same-origin transport; server errors never become product copy. */
export function createOnboardingClient(options: {
  endpoint: string;
  fetch?: typeof fetch;
}): OnboardingClient {
  if (!/^\/(?!\/)[^?#]*$/.test(options.endpoint))
    throw new Error('Onboarding requires a same-origin path');
  const send = async (
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<OnboardingState> => {
    const response = await (options.fetch ?? fetch)(options.endpoint, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(body
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (!response.ok) throw new Error('Onboarding request failed');
    return response.json();
  };
  return {
    state: (signal) => send(undefined, signal),
    change: (change, revision, signal) => send({ ...change, revision }, signal),
  };
}
