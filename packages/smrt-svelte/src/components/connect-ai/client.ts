import type { ConnectAiClient, ConnectAiState } from './types.js';

/** Same-origin JSON transport for mountConnectAiRoutes. It never exposes server error text. */
export function createConnectAiClient(options: {
  endpoint: string;
  fetch?: typeof fetch;
}): ConnectAiClient {
  if (!/^\/(?!\/)[^?#]*$/.test(options.endpoint))
    throw new Error('Connect AI requires a same-origin route path.');
  const doFetch = options.fetch ?? fetch;
  const call = async <T>(
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const response = await doFetch(options.endpoint, {
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
    if (!response.ok) throw new Error('Connect AI request failed.');
    return response.json() as Promise<T>;
  };
  return {
    state: (signal) => call<ConnectAiState>(undefined, signal),
    connect: async (tool, signal) => {
      await call({ action: 'connect', tool }, signal);
    },
    choose: async (engine, signal) => {
      await call({ action: 'select', engine }, signal);
    },
    startChatGPT: (signal) => call({ action: 'chatgpt-start' }, signal),
    signOutChatGPT: async (signal) => {
      await call({ action: 'chatgpt-sign-out' }, signal);
    },
  };
}
