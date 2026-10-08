import type {
  HelperClient,
  HelperPreferences,
  HelperSnapshot,
} from './helper-preferences.js';

function snapshot(value: unknown): HelperSnapshot {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('selection' in value) ||
    !('preferences' in value) ||
    !('permissions' in value)
  )
    throw new Error('Helper preferences response is malformed.');
  return value as HelperSnapshot;
}

/** Browser transport for the loopback-only local helper workbench. */
export function createDevHelperClient(
  request: typeof fetch = fetch,
): HelperClient {
  async function send(method: 'GET' | 'POST' | 'DELETE', body?: unknown) {
    const response = await request('/api/dev-helper', {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        value &&
        typeof value === 'object' &&
        'message' in value &&
        typeof value.message === 'string'
          ? value.message
          : 'Helper preferences could not be saved.';
      throw new Error(message);
    }
    return snapshot(value);
  }
  return {
    load: () => send('GET'),
    save: (preferences: HelperPreferences) => send('POST', preferences),
    reset: () => send('DELETE'),
  };
}
