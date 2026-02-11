<script lang="ts">
import type { Membership, Tenant } from '@happyvertical/smrt-users';

export interface Props {
  memberships: Membership[];
  tenants: Map<string, Tenant>;
  currentTenantId: string;
  onchange?: (tenantId: string) => void;
}

const { memberships, tenants, currentTenantId, onchange }: Props = $props();

const currentTenant = $derived(tenants.get(currentTenantId));

function handleChange(event: Event) {
  const select = event.target as HTMLSelectElement;
  onchange?.(select.value);
}
</script>

<div class="tenant-switcher">
  {#if memberships.length <= 1}
    <span class="tenant-name">{currentTenant?.name ?? 'Unknown'}</span>
  {:else}
    <select value={currentTenantId} onchange={handleChange} class="tenant-select">
      {#each memberships as membership}
        {#if membership.tenantId}
          {@const tenant = tenants.get(membership.tenantId)}
          <option value={membership.tenantId}>
            {tenant?.name ?? 'Unknown'}
          </option>
        {/if}
      {/each}
    </select>
  {/if}
</div>

<style>
  .tenant-switcher {
    display: inline-flex;
    align-items: center;
  }

  .tenant-name {
    font-weight: var(--md-sys-typescale-weight-medium, 500);
  }

  .tenant-select {
    padding: var(--md-sys-spacing-sm, 0.5rem) var(--md-sys-spacing-md, 1rem);
    border: 1px solid var(--md-sys-color-outline-variant, #c4c6cf);
    border-radius: var(--md-sys-shape-corner-medium, 0.5rem);
    background: var(--md-sys-color-surface, white);
    font: var(--md-sys-typescale-body-medium-font, 0.875rem / 1.25 sans-serif);
    cursor: pointer;
    transition: border-color var(--md-sys-motion-duration-short2, 150ms) var(--md-sys-motion-easing-standard, ease);
  }

  .tenant-select:focus {
    outline: 2px solid var(--md-sys-color-primary, #005ac1);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .tenant-select {
      transition: none;
    }
  }
</style>
