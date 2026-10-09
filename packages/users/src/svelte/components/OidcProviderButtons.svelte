<script lang="ts">import { Button } from '@happyvertical/smrt-ui/ui';
import type { OidcProviderButton, UsersAuthAdapter } from '../auth.js';
import { messageFrom } from '../auth.js';
export interface Props {
  /** Authorized browser-to-server authentication callbacks. */
  adapter: UsersAuthAdapter;
  /** Providers explicitly configured by the host. */
  providers: OidcProviderButton[];
}
let { adapter, providers }: Props = $props();
let error = $state('');
let pending = $state<string | null>(null);
async function signIn(providerId: string) {
  if (!adapter.signInWithOidc) return;
  error = '';
  pending = providerId;
  try {
    await adapter.signInWithOidc({ providerId });
  } catch (cause) {
    error = messageFrom(cause, 'Unable to start single sign-on.');
  } finally {
    pending = null;
  }
}
</script>
<section aria-label="Single sign-on"><h2>Or continue with</h2>{#if error}<p class="error" role="alert">{error}</p>{/if}<div class="providers">{#each providers as provider (provider.id)}<Button variant="secondary" fullWidth onclick={()=>signIn(provider.id)} disabled={provider.disabled||!adapter.signInWithOidc} loading={pending===provider.id}>{provider.label}</Button>{/each}</div></section><style>section{display:grid;gap:var(--smrt-spacing-sm,.5rem)}h2{margin:0;font:var(--smrt-typography-title-small-font)}.providers{display:grid;gap:var(--smrt-spacing-sm,.5rem)}.error{margin:0;color:var(--smrt-color-error)}</style>
