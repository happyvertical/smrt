<script lang="ts">
/**
 * The shell's light/dark switch (`AppShell` item `item:color-scheme`): an
 * icon-only toggle button. Its name stays "Dark mode" with `aria-pressed`
 * carrying the state; the icon and tooltip show the mode a press switches
 * to (moon in light mode, sun in dark mode), as the chevron shows where the
 * sidebar will move. Needs the `ThemeProvider` that `AppShell` mounts.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { getThemeContext } from '@happyvertical/smrt-ui/themes';
import { M } from '../../i18n/strings.workspace.js';
import ShellIconButton from '../workspace/admin-shell/ShellIconButton.svelte';

const theme = getThemeContext();
const { t } = useI18n();
const dark = $derived(theme.state.isDark);
</script>

<span class="smrt-app-shell-color-scheme" data-smrt-component="ShellColorSchemeToggle">
  <ShellIconButton
    icon={dark ? 'lightMode' : 'darkMode'}
    label={t(M['ui.app_shell.color_scheme_dark'])}
    pressed={dark}
    tooltip={t(
      dark
        ? M['ui.app_shell.color_scheme_to_light']
        : M['ui.app_shell.color_scheme_to_dark'],
    )}
    onclick={() => theme.toggleColorScheme()}
  />
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-app-shell-color-scheme { display: inline-flex; align-items: center; }
}
</style>
