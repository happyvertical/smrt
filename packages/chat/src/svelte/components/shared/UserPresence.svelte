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

<span class="presence" aria-label={labelText[status]}>
  <span class="presence__dot {status}"></span>
  {#if showLabel}
    <span class="presence__label">{labelText[status]}</span>
  {/if}
</span>

<style>
  .presence {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.375rem);
  }

  .presence__dot {
    width: 8px;
    height: 8px;
    border-radius: var(--smrt-radius-full, 9999px);
    flex-shrink: 0;
  }

  .presence__dot.online {
    background: #4caf50;
  }

  .presence__dot.away {
    background: #ff9800;
  }

  .presence__dot.dnd {
    background: #f44336;
  }

  .presence__dot.offline {
    background: var(--smrt-color-outline, #74777f);
  }

  .presence__label {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    line-height: 1;
  }
</style>
