<script lang="ts">
import type { Membership, Tenant } from '@happyvertical/smrt-users';

interface Props {
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
    font-weight: 500;
  }

  .tenant-select {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border-color, #e2e8f0);
    border-radius: 0.375rem;
    background: var(--bg-color, white);
    font-size: 0.875rem;
    cursor: pointer;
  }

  .tenant-select:focus {
    outline: 2px solid var(--focus-color, #3b82f6);
    outline-offset: 2px;
  }
</style>
