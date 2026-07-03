<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import { useAdminShell } from './context.js';
import HotkeyInput from './HotkeyInput.svelte';
import { resolveHotkey } from './settings.js';
import type { PanelEdge, ShellHotkeyBinding } from './types.js';

const { t } = useI18n();
const shell = useAdminShell();
const edges: PanelEdge[] = ['top', 'left', 'bottom', 'right'];
const hotkeysEnabled = $derived(shell.settings.hotkeysEnabled !== false);

function bindingFor(edge: PanelEdge): ShellHotkeyBinding | null {
  return resolveHotkey(edge, shell.config.panels[edge], shell.settings);
}

function conflictFor(edge: PanelEdge): string | null {
  const binding = bindingFor(edge);
  if (!binding) return null;
  const conflict = edges.find(
    (candidate) =>
      candidate !== edge &&
      bindingFor(candidate)?.code === binding.code &&
      bindingFor(candidate)?.altKey === binding.altKey &&
      bindingFor(candidate)?.ctrlKey === binding.ctrlKey &&
      bindingFor(candidate)?.metaKey === binding.metaKey &&
      bindingFor(candidate)?.shiftKey === binding.shiftKey,
  );
  return conflict ? shell.config.panels[conflict].label : null;
}
</script>

<section
  class="smrt-shell-settings-panel"
  aria-label={t(M['ui.shell_settings_panel.shell_settings'])}
>
  <header>
    <div>
      <h2>{t(M['ui.shell_settings_panel.shell_settings'])}</h2>
      <p>{t(M['ui.shell_settings_panel.description'])}</p>
    </div>
    <Button
      variant={hotkeysEnabled ? 'secondary' : 'primary'}
      size="sm"
      onclick={() => shell.setHotkeysEnabled(!hotkeysEnabled)}
    >
      {hotkeysEnabled
        ? t(M['ui.shell_settings_panel.disable_hotkeys'])
        : t(M['ui.shell_settings_panel.enable_hotkeys'])}
    </Button>
  </header>

  <div class="smrt-shell-settings-panel__grid">
    {#each edges as edge}
      {@const panel = shell.config.panels[edge]}
      {#if shell.panels[edge] !== 'hidden'}
        <div class="smrt-shell-settings-panel__row">
          <div>
            <strong>{panel.label}</strong>
            <span>{shell.panels[edge]}</span>
          </div>
          <div class="smrt-shell-settings-panel__actions">
            <Button
              variant="ghost"
              size="sm"
              onclick={() =>
                shell.setPanel(
                  edge,
                  shell.panels[edge] === 'expanded'
                    ? 'collapsed'
                    : 'expanded',
                )}
            >
              {shell.panels[edge] === 'expanded'
                ? t(M['ui.shell_settings_panel.collapse'])
                : t(M['ui.shell_settings_panel.expand'])}
            </Button>
            <HotkeyInput
              value={bindingFor(edge)}
              disabled={!hotkeysEnabled}
              conflictsWith={conflictFor(edge)}
              oncapture={(binding) =>
                shell.setHotkey(edge, binding?.code ?? null)}
            />
          </div>
        </div>
      {/if}
    {/each}
  </div>
</section>

<style>
  .smrt-shell-settings-panel {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .smrt-shell-settings-panel header,
  .smrt-shell-settings-panel__row,
  .smrt-shell-settings-panel__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3);
  }

  .smrt-shell-settings-panel header,
  .smrt-shell-settings-panel__row {
    justify-content: space-between;
  }

  .smrt-shell-settings-panel h2,
  .smrt-shell-settings-panel p {
    margin: 0;
  }

  .smrt-shell-settings-panel p,
  .smrt-shell-settings-panel span {
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-shell-settings-panel__grid {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .smrt-shell-settings-panel__row {
    padding-block: var(--smrt-spacing-3);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-shell-settings-panel__row > div:first-child {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  @media (max-width: 42rem) {
    .smrt-shell-settings-panel header,
    .smrt-shell-settings-panel__row,
    .smrt-shell-settings-panel__actions {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
