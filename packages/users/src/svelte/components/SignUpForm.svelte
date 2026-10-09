<script lang="ts">
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { UsersAuthAdapter } from '../auth.js';
import { messageFrom } from '../auth.js';
export interface Props {
  /** Authorized browser-to-server authentication callbacks. */
  adapter: UsersAuthAdapter;
  /** Blocks controls while the host action is pending. */
  loading?: boolean;
}
let { adapter, loading = false }: Props = $props();
let email = $state('');
let password = $state('');
let confirm = $state('');
let error = $state('');
let pending = $state(false);
async function submit() {
  error = '';
  if (password !== confirm) {
    error = 'Passwords do not match.';
    return;
  }
  if (!adapter.signUp) return;
  pending = true;
  try {
    await adapter.signUp({ email, password });
  } catch (cause) {
    error = messageFrom(cause, 'Unable to create account.');
  } finally {
    pending = false;
  }
}
</script>
<Form class="auth-form" onsubmit={submit} aria-busy={loading||pending}><h2>Create account</h2>{#if error}<p class="error" role="alert">{error}</p>{/if}<label for="sign-up-email">Email address</label><Input id="sign-up-email" type="email" bind:value={email} autocomplete="email" required disabled={loading||pending}/><label for="sign-up-password">Password</label><Input id="sign-up-password" type="password" bind:value={password} autocomplete="new-password" required disabled={loading||pending}/><label for="sign-up-confirm">Confirm password</label><Input id="sign-up-confirm" type="password" bind:value={confirm} autocomplete="new-password" required disabled={loading||pending}/><Button type="submit" fullWidth disabled={!adapter.signUp||loading} loading={pending}>Create account</Button></Form>
<style>:global(.auth-form){display:grid;gap:var(--smrt-spacing-sm,.5rem);color:var(--smrt-color-on-surface)}h2{margin:0;font:var(--smrt-typography-title-large-font)}label{font:var(--smrt-typography-label-large-font)}.error{margin:0;padding:var(--smrt-spacing-sm,.5rem);border-radius:var(--smrt-radius-sm,.25rem);background:var(--smrt-color-error-container);color:var(--smrt-color-on-error-container)}</style>
