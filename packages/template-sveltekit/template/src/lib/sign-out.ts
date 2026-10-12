import { goto, invalidateAll } from '$app/navigation';

/**
 * Sign out through the runtime's same-origin `POST /sign-out` route, then
 * refresh the session-derived layout data and return home.
 */
export async function signOut(): Promise<void> {
  await fetch('/sign-out', { method: 'POST', credentials: 'same-origin' });
  await invalidateAll();
  await goto('/');
}
