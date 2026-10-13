<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.workspace.js';
import ShellSettingsPanel from '../workspace/admin-shell/ShellSettingsPanel.svelte';

interface Props {
  /**
   * Where the Account section's sign-out link goes; shown only when given. A
   * link is a GET: never point it at the runtime's POST-only `/sign-out`; use
   * `onSignOut` for that.
   */
  signOutHref?: string;
  /** Called by the sign-out control instead of following `signOutHref`. */
  onSignOut?: () => void;
}

const { signOutHref, onSignOut }: Props = $props();
const { t } = useI18n();
</script>

<section class="smrt-shell-settings-page" data-smrt-component="ShellSettingsPage">
  <header>
    <h1>{t(M['ui.shell_settings_page.heading'])}</h1>
    <p>{t(M['ui.shell_settings_page.description'])}</p>
  </header>
  <ShellSettingsPanel appearance account {signOutHref} {onSignOut} />
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-shell-settings-page {
    display: grid;
    gap: var(--smrt-spacing-6, 1.5rem);
    max-width: 720px;
    padding: var(--smrt-spacing-8, 2rem);
  }
  header {
    display: grid;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  h1,
  p {
    margin: 0;
  }
}
</style>
