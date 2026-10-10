<script lang="ts">
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { UsersAuthAdapter } from '../auth.js';
import { messageFrom } from '../auth.js';

export interface Props {
  /** Authorized browser-to-server authentication callbacks. */
  adapter: UsersAuthAdapter;
  /** Blocks controls while the host action is pending. */
  loading?: boolean;
  /** Optional password recovery destination. */
  forgotPasswordHref?: string;
}
let { adapter, loading = false, forgotPasswordHref }: Props = $props();
const { t } = useI18n();
let email = $state('');
let password = $state('');
let error = $state('');
let pending = $state(false);
async function submit() {
  error = '';
  if (!adapter.signInWithPassword) return;
  pending = true;
  try {
    await adapter.signInWithPassword({ email, password });
  } catch (cause) {
    error = messageFrom(cause, 'Unable to sign in.');
  } finally {
    pending = false;
  }
}
</script>
<Form class="auth-form" onsubmit={submit} aria-busy={loading || pending}>
  <h2>{t('users.auth.sign_in')}</h2>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <label for="sign-in-email">{t('users.auth.email_address')}</label><Input id="sign-in-email" type="email" bind:value={email} autocomplete="email" required disabled={loading || pending} />
  <label for="sign-in-password">{t('users.auth.password')}</label><Input id="sign-in-password" type="password" bind:value={password} autocomplete="current-password" required disabled={loading || pending} />
  {#if forgotPasswordHref}<Button href={forgotPasswordHref} variant="ghost">{t('users.auth.forgot_password')}</Button>{/if}
  <Button type="submit" fullWidth disabled={!adapter.signInWithPassword || loading} loading={pending}>{t('users.auth.sign_in')}</Button>
</Form>
<style>:global(.auth-form){display:grid;gap:var(--smrt-spacing-sm,.5rem);color:var(--smrt-color-on-surface)}h2{margin:0;font:var(--smrt-typography-title-large-font)}label{font:var(--smrt-typography-label-large-font)}.error{margin:0;padding:var(--smrt-spacing-sm,.5rem);border-radius:var(--smrt-radius-sm,.25rem);background:var(--smrt-color-error-container);color:var(--smrt-color-on-error-container)}</style>
