<script lang="ts">import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { UsersAuthAdapter } from '../auth.js';
import '../auth.js';
export interface Props {
  /** Authorized browser-to-server authentication callbacks. */
  adapter: UsersAuthAdapter;
  /** Visible text for the capability-gated control. */
  label?: string;
}
let { adapter, label }: Props = $props();
const { t } = useI18n();
let error = $state('');
let pending = $state(false);
async function signIn() {
  if (!adapter.signInWithPasskey) return;
  error = '';
  pending = true;
  try {
    await adapter.signInWithPasskey();
  } catch {
    error = 'users.auth.passkey_not_completed';
  } finally {
    pending = false;
  }
}
</script>
{#if adapter.signInWithPasskey}<div class="passkey"><Button variant="secondary" fullWidth onclick={signIn} loading={pending}>{label ?? t('users.auth.passkey_sign_in')}</Button>{#if error}<p role="alert">{t(error)}</p>{/if}</div>{/if}<style>.passkey{display:grid;gap:var(--smrt-spacing-sm,.5rem)}p{margin:0;color:var(--smrt-color-error)}</style>
