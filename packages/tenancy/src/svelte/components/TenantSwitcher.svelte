<script lang="ts">
import type { Membership, Tenant } from '@happyvertical/smrt-types';

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
    <!-- raw-primitive-allow: the Select form primitive lives in @happyvertical/smrt-svelte, which transitively depends on smrt-tenancy (smrt-svelte to smrt-languages to smrt-tenancy), so importing it would create a DAG cycle (#1582); the native select element retains full keyboard/AT a11y -->
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
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .tenant-select {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: var(--smrt-color-surface, white);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    cursor: pointer;
    transition: border-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .tenant-select:focus {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .tenant-select {
      transition: none;
    }
  }
</style>
