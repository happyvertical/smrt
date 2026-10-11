<script lang="ts">import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { OidcProviderButton, UsersAuthAdapter } from '../auth.js';
import '../auth.js';
export interface Props {
  /** Authorized browser-to-server authentication callbacks. */
  adapter: UsersAuthAdapter;
  /** Providers explicitly configured by the host. */
  providers: OidcProviderButton[];
}
let { adapter, providers }: Props = $props();
const { t } = useI18n();
let error = $state('');
let pending = $state<string | null>(null);
async function signIn(providerId: string) {
  if (!adapter.signInWithOidc) return;
  error = '';
  pending = providerId;
  try {
    await adapter.signInWithOidc({ providerId });
  } catch {
    error = 'users.auth.unable_to_start_sso';
  } finally {
    pending = null;
  }
}
</script>
<section aria-label={t('users.auth.single_sign_on')}><h2>{t('users.auth.or_continue_with')}</h2>{#if error}<p class="error" role="alert">{t(error)}</p>{/if}<div class="providers">{#each providers as provider (provider.id)}<Button variant="secondary" fullWidth onclick={()=>signIn(provider.id)} disabled={provider.disabled||!adapter.signInWithOidc} loading={pending===provider.id}>{provider.label}</Button>{/each}</div></section><style>section{display:grid;gap:var(--smrt-spacing-sm,.5rem)}h2{margin:0;font:var(--smrt-typography-title-small-font)}.providers{display:grid;gap:var(--smrt-spacing-sm,.5rem)}.error{margin:0;color:var(--smrt-color-error)}</style>
