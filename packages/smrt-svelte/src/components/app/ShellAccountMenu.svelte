<script lang="ts">
/**
 * `AppShell`'s account menu: `WorkspaceAccountMenu` plus the host's items
 * (Approvals, History, ...) and, when asked, a Theme item that switches the
 * color scheme of the `ThemeProvider` the shell mounts (no second scheme
 * store). Order: host items, Theme, then the menu's Settings and Sign out.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { getThemeContext } from '@happyvertical/smrt-ui/themes';
import type { ComponentProps } from 'svelte';
import { M } from '../../i18n/strings.workspace.js';
import type { WorkspaceAccountMenuItem } from '../workspace/admin-shell/types.js';
import WorkspaceAccountMenu from '../workspace/admin-shell/WorkspaceAccountMenu.svelte';

interface Props
  extends Omit<ComponentProps<typeof WorkspaceAccountMenu>, 'items'> {
  /** Host items shown first (see `WorkspaceAccountMenu` `items`). */
  hostItems?: WorkspaceAccountMenuItem[];
  /** Add the Theme item (needs the shell's `ThemeProvider`). */
  themeItem?: boolean;
}

let { hostItems = [], themeItem = false, ...rest }: Props = $props();

const { t } = useI18n();
// svelte-ignore state_referenced_locally -- context is read once at init
const theme = themeItem ? getThemeContext() : null;
const dark = $derived(theme?.state.isDark ?? false);
const items = $derived.by(() => {
  const out = [...hostItems];
  if (theme) {
    out.push({
      id: 'theme',
      label: t(M['ui.app_shell.theme_item'], {
        mode: t(
          M[dark ? 'ui.app_shell.theme_dark' : 'ui.app_shell.theme_light'],
        ),
      }),
      onselect: () => theme.toggleColorScheme(),
    });
  }
  return out;
});
</script>

<WorkspaceAccountMenu {...rest} {items} />
