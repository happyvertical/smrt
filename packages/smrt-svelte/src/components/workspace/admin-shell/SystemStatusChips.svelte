<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import type { ShellStatusChip } from './types.js';

interface Props {
  chips: ShellStatusChip[];
}

let { chips }: Props = $props();
const { t } = useI18n();
</script>

<div
  class="smrt-system-status-chips"
  aria-label={t(M['ui.system_status_chips.system_status'])}
>
  {#each chips as chip (chip.id)}
    {#if chip.href}
      <a href={chip.href} data-tone={chip.tone ?? 'neutral'}>
        <span>{chip.label}</span>
        {#if chip.value !== undefined}
          <Badge size="sm" variant={chip.tone === 'error' ? 'error' : 'default'}>
            {chip.value}
          </Badge>
        {/if}
      </a>
    {:else}
      <span class="smrt-system-status-chips__chip" data-tone={chip.tone ?? 'neutral'}>
        <span>{chip.label}</span>
        {#if chip.value !== undefined}
          <Badge size="sm" variant={chip.tone === 'error' ? 'error' : 'default'}>
            {chip.value}
          </Badge>
        {/if}
      </span>
    {/if}
  {/each}
</div>

<style>
  .smrt-system-status-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
    align-items: center;
  }

  .smrt-system-status-chips a,
  .smrt-system-status-chips__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }

  .smrt-system-status-chips [data-tone='success'] {
    color: var(--smrt-color-success);
  }

  .smrt-system-status-chips [data-tone='warning'] {
    color: var(--smrt-color-warning);
  }

  .smrt-system-status-chips [data-tone='error'] {
    color: var(--smrt-color-error);
  }
</style>
