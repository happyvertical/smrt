<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import { formatHotkeyBinding } from './hotkeys.js';
import type { ShellHotkeyBinding } from './types.js';

interface Props {
  value?: ShellHotkeyBinding | null;
  disabled?: boolean;
  conflictsWith?: string | null;
  oncapture?: (binding: ShellHotkeyBinding | null) => void;
}

let {
  value = null,
  disabled = false,
  conflictsWith = null,
  oncapture,
}: Props = $props();
const { t } = useI18n();

function handleKeydown(event: KeyboardEvent): void {
  if (disabled) return;
  event.preventDefault();
  if (event.key === 'Backspace' || event.key === 'Delete') {
    oncapture?.(null);
    return;
  }
  if (!event.code) return;
  oncapture?.({
    code: event.code,
    altKey: event.altKey || undefined,
    ctrlKey: event.ctrlKey || undefined,
    metaKey: event.metaKey || undefined,
    shiftKey: event.shiftKey || undefined,
  });
}
</script>

<div class="smrt-hotkey-input">
  <Button
    variant="secondary"
    size="sm"
    {disabled}
    onkeydown={handleKeydown}
    title={t(M['ui.hotkey_input.capture_title'])}
  >
    {formatHotkeyBinding(value)}
  </Button>
  {#if conflictsWith}
    <span class="smrt-hotkey-input__conflict">
      {t(M['ui.hotkey_input.conflicts_with'])} {conflictsWith}
    </span>
  {/if}
</div>

<style>
  .smrt-hotkey-input {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-width: 0;
  }

  .smrt-hotkey-input__conflict {
    color: var(--smrt-color-error);
    font-size: var(--smrt-typography-body-small-size);
    overflow-wrap: anywhere;
  }
</style>
