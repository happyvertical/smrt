<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import { useAdminShell } from './context.js';
import { formatHotkeyBinding } from './hotkeys.js';
import { resolveHotkey } from './settings.js';
import type { PanelEdge } from './types.js';

interface Props {
  onclose?: () => void;
}

let { onclose }: Props = $props();
const { t } = useI18n();
const shell = useAdminShell();
const edges: PanelEdge[] = ['top', 'left', 'bottom', 'right'];
</script>

<section
  class="smrt-shortcuts-overlay"
  aria-label={t(M['ui.admin_shell.shell_shortcuts'])}
>
  <header>
    <h2>{t(M['ui.admin_shell.shell_shortcuts'])}</h2>
    <Button
      variant="ghost"
      size="sm"
      aria-label={t(M['ui.admin_shell.close_shortcuts'])}
      onclick={() => onclose?.()}
    >
      {t(M['ui.shortcuts_overlay.close'])}
    </Button>
  </header>
  <dl>
    {#each edges as edge}
      <div>
        <dt>{shell.config.panels[edge].label}</dt>
        <dd>
          {formatHotkeyBinding(
            resolveHotkey(edge, shell.config.panels[edge], shell.settings),
          )}
        </dd>
      </div>
    {/each}
    <div>
      <dt>{t(M['ui.shortcuts_overlay.open_shortcuts'])}</dt>
      <dd>?</dd>
    </div>
    <div>
      <dt>{t(M['ui.shortcuts_overlay.close_drawer'])}</dt>
      <dd>{t(M['ui.shortcuts_overlay.escape'])}</dd>
    </div>
  </dl>
</section>

<style>
  .smrt-shortcuts-overlay {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .smrt-shortcuts-overlay header,
  .smrt-shortcuts-overlay div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }

  .smrt-shortcuts-overlay h2,
  .smrt-shortcuts-overlay dl,
  .smrt-shortcuts-overlay dd {
    margin: 0;
  }

  .smrt-shortcuts-overlay dl {
    display: grid;
    gap: var(--smrt-spacing-3);
  }
</style>
