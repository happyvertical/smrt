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
	<span class="status-dot" aria-hidden="true"></span>
	{label}
</span>

<style>
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		border-radius: var(--smrt-radius-full, 9999px);
		font-size: var(--smrt-typography-label-medium-size, 0.75rem);
		font-weight: var(--smrt-typography-weight-medium, 500);
	}

	.status-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--smrt-radius-full, 9999px);
	}

	.connected {
		background: var(--smrt-color-success-container);
		color: var(--smrt-color-on-success-container);
	}

	.connected .status-dot {
		background: var(--smrt-color-success);
	}

	.pending {
		background: var(--smrt-color-warning-container);
		color: var(--smrt-color-on-warning-container);
	}

	.pending .status-dot {
		background: var(--smrt-color-warning);
	}

	.disconnected {
		background: var(--smrt-color-surface-container);
		color: var(--smrt-color-on-surface-variant);
	}

	.disconnected .status-dot {
		background: var(--smrt-color-outline);
	}
</style>
