<script lang="ts">
interface Props {
  status: 'active' | 'inactive' | 'pending';
}

const { status }: Props = $props();

const label = $derived(
  status === 'active'
    ? 'Connected'
    : status === 'pending'
      ? 'Pending'
      : 'Disconnected',
);
</script>

<span class="status-badge" class:connected={status === 'active'} class:pending={status === 'pending'} class:disconnected={status === 'inactive'}>
	<span class="status-dot"></span>
	{label}
</span>

<style>
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		border-radius: var(--smrt-radius-full, 9999px);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.status-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--smrt-radius-full, 9999px);
	}

	.connected {
		background: var(--color-success-bg, #dcfce7);
		color: var(--color-success-text, #166534);
	}

	.connected .status-dot {
		background: var(--color-success-main, #22c55e);
	}

	.pending {
		background: var(--color-warning-bg, #fef9c3);
		color: var(--color-warning-text, #854d0e);
	}

	.pending .status-dot {
		background: var(--color-warning-main, #eab308);
	}

	.disconnected {
		background: var(--color-neutral-bg, #f3f4f6);
		color: var(--color-neutral-text, #4b5563);
	}

	.disconnected .status-dot {
		background: var(--color-neutral-main, #9ca3af);
	}
</style>
