<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import type { ShellStatusChip } from './types.js';

interface Props {
  /** Array of status chips with label, value, tone, and optional link. */
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

  /* Every tone is a lamp beside on-surface text; none of them paints the
     letterforms. Status hues are chosen to be recognisable at a glance, which
     puts them in luminance bands that are not text-safe on light surfaces —
     measured worst-case as TEXT across all five presets: warning falls to
     1.41:1 (material and studio light), error to 2.65:1 (glass light), success
     to 1.66:1 (glass light). A lamp carries the same meaning with no contrast
     obligation, and keeps the component correct under any palette rather than
     depending on each preset tuning three hues for text (#2323). */
  .smrt-system-status-chips [data-tone='success']::before,
  .smrt-system-status-chips [data-tone='warning']::before,
  .smrt-system-status-chips [data-tone='error']::before {
    content: '';
    flex: none;
    inline-size: 0.5rem;
    block-size: 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .smrt-system-status-chips [data-tone='success']::before {
    background: var(--smrt-color-success);
  }

  .smrt-system-status-chips [data-tone='warning']::before {
    background: var(--smrt-color-warning);
  }

  .smrt-system-status-chips [data-tone='error']::before {
    background: var(--smrt-color-error);
  }
</style>
