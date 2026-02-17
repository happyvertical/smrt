<script lang="ts" module>
export interface Props {
  status: 'draft' | 'pending' | 'sending' | 'sent' | 'failed' | 'scheduled';
  size?: 'sm' | 'md';
}
</script>

<script lang="ts">
  let { status, size = 'sm' }: Props = $props();

  const statusConfig = $derived.by(() => {
    switch (status) {
      case 'draft':
        return { label: 'Draft', color: 'var(--smrt-color-outline, #79747e)', icon: '✎' };
      case 'pending':
        return { label: 'Pending', color: 'var(--smrt-color-tertiary, #7d5260)', icon: '◷' };
      case 'sending':
        return { label: 'Sending', color: 'var(--smrt-color-primary, #6750a4)', icon: '↑' };
      case 'sent':
        return { label: 'Sent', color: 'var(--smrt-color-primary, #006d3b)', icon: '✓' };
      case 'failed':
        return { label: 'Failed', color: 'var(--smrt-color-error, #ba1a1a)', icon: '✕' };
      case 'scheduled':
        return { label: 'Scheduled', color: 'var(--smrt-color-secondary, #625b71)', icon: '⏰' };
      default:
        return { label: status, color: 'var(--smrt-color-outline, #79747e)', icon: '?' };
    }
  });
</script>

<span
  class="send-status-badge {size}"
  style="--badge-color: {statusConfig.color}"
>
  <span class="icon">{statusConfig.icon}</span>
  <span class="label">{statusConfig.label}</span>
</span>

<style>
  .send-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: var(--smrt-radius-sm, 8px);
    border: 1px solid var(--badge-color);
    color: var(--badge-color);
    font-family: var(--smrt-typography-label, system-ui);
    white-space: nowrap;
  }

  .sm {
    padding: 2px 8px;
    font-size: 11px;
  }

  .md {
    padding: 4px 12px;
    font-size: 13px;
  }

  .icon {
    font-size: inherit;
  }
</style>
