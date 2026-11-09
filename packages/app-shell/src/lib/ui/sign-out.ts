import { goto, invalidateAll } from '$app/navigation';

/**
 * Sign out through the runtime's same-origin `POST /sign-out` route, then
 * refresh the session-derived layout data and return home. A failed request
 * throws instead of pretending the session ended.
 */
export async function signOut(): Promise<void> {
  const response = await fetch('/sign-out', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!response.ok)
    throw new Error(`Sign-out failed with status ${response.status}`);
  await invalidateAll();
  await goto('/');
}
