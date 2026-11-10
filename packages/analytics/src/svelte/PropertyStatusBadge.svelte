<script lang="ts">
interface Props {
  /** Connection status of the analytics property. */
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

<span class="smrt-property-status-badge__root" class:smrt-property-status-badge__connected={status === 'active'} class:smrt-property-status-badge__pending={status === 'pending'} class:smrt-property-status-badge__disconnected={status === 'inactive'} data-smrt-component="PropertyStatusBadge">
	<span class="smrt-property-status-badge__dot" data-smrt-part="indicator" aria-hidden="true"></span>
	{label}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {

.smrt-property-status-badge__root {
display: inline-flex;
align-items: center;
gap: 0.375rem;
padding: 0.25rem 0.625rem;

}
.smrt-property-status-badge__dot {
width: 0.5rem;
height: 0.5rem;

}

}
@layer smrt.theme {

.smrt-property-status-badge__root {
border-radius: var(--smrt-radius-full);
font-size: var(--smrt-typography-label-medium-size, 0.75rem);
font-weight: var(--smrt-typography-weight-medium, 500);

}
.smrt-property-status-badge__dot {
border-radius: var(--smrt-radius-full);

}
.smrt-property-status-badge__connected {
background: var(--smrt-color-success-container);
color: var(--smrt-color-on-success-container);

}
.smrt-property-status-badge__connected .smrt-property-status-badge__dot {
background: var(--smrt-color-success);

}
.smrt-property-status-badge__pending {
background: var(--smrt-color-warning-container);
color: var(--smrt-color-on-warning-container);

}
.smrt-property-status-badge__pending .smrt-property-status-badge__dot {
background: var(--smrt-color-warning);

}
.smrt-property-status-badge__disconnected {
background: var(--smrt-color-surface-container);
color: var(--smrt-color-on-surface-variant);

}
.smrt-property-status-badge__disconnected .smrt-property-status-badge__dot {
background: var(--smrt-color-outline);

}

}

</style>
