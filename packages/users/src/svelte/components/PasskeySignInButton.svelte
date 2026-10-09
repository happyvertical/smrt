<script lang="ts">import { Button } from '@happyvertical/smrt-ui/ui';
import type { UsersAuthAdapter } from '../auth.js';
import { messageFrom } from '../auth.js';
export interface Props {
  /** Authorized browser-to-server authentication callbacks. */
  adapter: UsersAuthAdapter;
  /** Visible text for the capability-gated control. */
  label?: string;
}
let { adapter, label = 'Sign in with a passkey' }: Props = $props();
let error = $state('');
let pending = $state(false);
async function signIn() {
  if (!adapter.signInWithPasskey) return;
  error = '';
  pending = true;
  try {
    await adapter.signInWithPasskey();
  } catch (cause) {
    error = messageFrom(cause, 'Passkey sign-in was not completed.');
  } finally {
    pending = false;
  }
}
</script>
{#if adapter.signInWithPasskey}<div class="passkey"><Button variant="secondary" fullWidth onclick={signIn} loading={pending}>{label}</Button>{#if error}<p role="alert">{error}</p>{/if}</div>{/if}<style>.passkey{display:grid;gap:var(--smrt-spacing-sm,.5rem)}p{margin:0;color:var(--smrt-color-error)}</style>
