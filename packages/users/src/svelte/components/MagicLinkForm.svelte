<script lang="ts">
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { UsersAuthAdapter } from '../auth.js';
import { messageFrom } from '../auth.js';
export interface Props {
  /** Authorized browser-to-server authentication callbacks. */
  adapter: UsersAuthAdapter;
  /** Opaque link token to confirm; omit it to request a link. */
  token?: string;
  /** Blocks controls while the host action is pending. */
  loading?: boolean;
}
let { adapter, token = '', loading = false }: Props = $props();
let email = $state('');
let error = $state('');
let notice = $state('');
let pending = $state(false);
async function submit() {
  error = '';
  notice = '';
  pending = true;
  try {
    if (token) {
      if (!adapter.confirmMagicLink) return;
      await adapter.confirmMagicLink({ token });
      notice = 'Your sign-in link was confirmed.';
    } else {
      if (!adapter.requestMagicLink) return;
      await adapter.requestMagicLink({ email });
      notice = 'Check your email for a sign-in link.';
    }
  } catch (cause) {
    error = messageFrom(cause, 'Unable to continue with the sign-in link.');
  } finally {
    pending = false;
  }
}
</script>
<Form class="auth-form" onsubmit={submit} aria-busy={loading||pending}><h2>{token ? 'Confirm sign-in link' : 'Email me a sign-in link'}</h2>{#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p class="notice" role="status">{notice}</p>{/if}{#if !token}<label for="magic-link-email">Email address</label><Input id="magic-link-email" type="email" bind:value={email} autocomplete="email" required disabled={loading||pending}/>{/if}<Button type="submit" fullWidth disabled={loading || (token ? !adapter.confirmMagicLink : !adapter.requestMagicLink)} loading={pending}>{token ? 'Confirm sign in' : 'Send sign-in link'}</Button></Form>
<style>:global(.auth-form){display:grid;gap:var(--smrt-spacing-sm,.5rem);color:var(--smrt-color-on-surface)}h2{margin:0;font:var(--smrt-typography-title-large-font)}label{font:var(--smrt-typography-label-large-font)}.error,.notice{margin:0;padding:var(--smrt-spacing-sm,.5rem);border-radius:var(--smrt-radius-sm,.25rem)}.error{background:var(--smrt-color-error-container);color:var(--smrt-color-on-error-container)}.notice{background:var(--smrt-color-primary-container);color:var(--smrt-color-on-primary-container)}</style>
