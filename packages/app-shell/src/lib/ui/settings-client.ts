import { deserialize } from '$app/forms';
import { invalidateAll } from '$app/navigation';

export interface SettingOutcome {
  ok: boolean;
  /** The action's success data (probe results, discovery). */
  data?: Record<string, unknown>;
  /** A message safe to show: server failures name no key or secret. */
  error?: string;
}

/**
 * Post a settings change to the current page's form action as JSON in a
 * `payload` field and report the outcome. A saved change reloads the page
 * data, so the panel shows what the server stored.
 */
export async function postSetting(
  action: string,
  payload: unknown,
  options: { reload?: boolean } = {},
): Promise<SettingOutcome> {
  const body = new FormData();
  body.set('payload', JSON.stringify(payload));
  let response: Response;
  try {
    response = await fetch(`?/${action}&target=live`, {
      method: 'POST',
      body,
      headers: { 'x-sveltekit-action': 'true' },
    });
  } catch {
    return { ok: false, error: 'The app could not be reached.' };
  }
  const result = deserialize(await response.text());
  if (result.type === 'success') {
    if (options.reload !== false) await invalidateAll();
    return { ok: true, data: result.data as Record<string, unknown> };
  }
  if (result.type === 'failure') {
    return {
      ok: false,
      error: String(
        (result.data as { error?: unknown } | undefined)?.error ??
          'The change was refused.',
      ),
    };
  }
  return { ok: false, error: 'The change failed.' };
}
