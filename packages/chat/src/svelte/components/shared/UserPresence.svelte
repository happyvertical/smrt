<script lang="ts">
/**
 * UserPresence - Online/offline status indicator with optional label
 */

export interface Props {
  /** Current presence status */
  status: 'online' | 'away' | 'dnd' | 'offline';
  /** Whether to show a text label next to the dot */
  showLabel?: boolean;
}

const { status, showLabel = false }: Props = $props();

const labelText: Record<string, string> = {
  online: 'Online',
  away: 'Away',
  dnd: 'Do not disturb',
  offline: 'Offline',
};
</script>

<span class="smrt-user-presence__root" aria-label={labelText[status]} data-smrt-component="UserPresence">
  <span class="smrt-user-presence__dot smrt-user-presence__{status}" data-smrt-part="indicator"></span>
  {#if showLabel}
    <span class="smrt-user-presence__label" data-smrt-part="label">{labelText[status]}</span>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-user-presence__root {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.375rem);
  }
  .smrt-user-presence__dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
  }
}

@layer smrt.theme {
  .smrt-user-presence__dot {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-user-presence__dot.smrt-user-presence__online {
    background: var(--smrt-color-success);
  }
  .smrt-user-presence__dot.smrt-user-presence__away {
    background: var(--smrt-color-warning);
  }
  .smrt-user-presence__dot.smrt-user-presence__dnd {
    background: var(--smrt-color-error);
  }
  .smrt-user-presence__dot.smrt-user-presence__offline {
    background: var(--smrt-color-outline);
  }
  .smrt-user-presence__label {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
    line-height: 1;
  }
}

</style>
