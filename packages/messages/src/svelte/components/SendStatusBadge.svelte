<script lang="ts" module>
export interface Props {
  /** Send status to display: draft, pending, sending, sent, failed, or scheduled. */
  status: 'draft' | 'pending' | 'sending' | 'sent' | 'failed' | 'scheduled';
  /** Visual size of the badge: small or medium. */
  size?: 'sm' | 'md';
}
</script>

<script lang="ts">
  let { status, size = 'sm' }: Props = $props();

  const statusConfig = $derived.by(() => {
    switch (status) {
      case 'draft':
        return { label: 'Draft', color: 'var(--smrt-color-outline)', icon: '✎' };
      case 'pending':
        return { label: 'Pending', color: 'var(--smrt-color-tertiary)', icon: '◷' };
      case 'sending':
        return { label: 'Sending', color: 'var(--smrt-color-primary)', icon: '↑' };
      case 'sent':
        return { label: 'Sent', color: 'var(--smrt-color-success)', icon: '✓' };
      case 'failed':
        return { label: 'Failed', color: 'var(--smrt-color-error)', icon: '✕' };
      case 'scheduled':
        return { label: 'Scheduled', color: 'var(--smrt-color-secondary)', icon: '⏰' };
      default:
        return { label: status, color: 'var(--smrt-color-outline)', icon: '?' };
    }
  });
</script>

<span
  class="smrt-send-status-badge__root smrt-send-status-badge__{size}"
  style="--smrt-send-status-badge-color: {statusConfig.color}" data-smrt-component="SendStatusBadge"
>
  <span class="smrt-send-status-badge__icon" data-smrt-part="icon">{statusConfig.icon}</span>
  <span class="smrt-send-status-badge__label" data-smrt-part="label">{statusConfig.label}</span>
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-send-status-badge__root {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    white-space: nowrap;
  }
  .smrt-send-status-badge__sm {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-send-status-badge__md {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
  }
}

@layer smrt.theme {
  .smrt-send-status-badge__root {
    border-radius: var(--smrt-radius-sm);
    border: 1px solid var(--smrt-send-status-badge-color);
    color: var(--smrt-send-status-badge-color);
    font-family: var(--smrt-font-family, system-ui);
  }
  .smrt-send-status-badge__sm {
    font-size: var(--smrt-typography-label-small-size);
  }
  .smrt-send-status-badge__md {
    font-size: var(--smrt-typography-label-large-size);
  }
  .smrt-send-status-badge__icon {
    font-size: inherit;
  }
}

</style>
