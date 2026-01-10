<script lang="ts">
import Card from '../ui/Card.svelte';

interface CouncilMember {
  name: string;
  position?: string;
  ward?: string;
}

interface Props {
  councilName: string;
  members?: CouncilMember[];
}

const { councilName, members = [] }: Props = $props();

const _sortedMembers = $derived(() => {
  if (!members.length) return [];

  // Sort: Mayor first, then Deputy Mayor, then by position/ward
  return [...members].sort((a, b) => {
    const positionOrder = (pos?: string) => {
      if (!pos) return 99;
      const lower = pos.toLowerCase();
      if (lower === 'mayor') return 0;
      if (lower.includes('deputy')) return 1;
      if (lower.includes('reeve')) return 0;
      if (lower.includes('deputy reeve')) return 1;
      return 10;
    };
    return positionOrder(a.position) - positionOrder(b.position);
  });
});
</script>

<aside class="council-sidebar">
  <Card>
    <h3 class="council-name">{councilName}</h3>

    {#if members.length > 0}
      <ul class="member-list">
        {#each _sortedMembers() as member}
          <li class="member">
            <span class="member-name">{member.name}</span>
            {#if member.position}
              <span class="member-position">{member.position}</span>
            {/if}
            {#if member.ward}
              <span class="member-ward">{member.ward}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="no-members">Council member information not available.</p>
    {/if}
  </Card>
</aside>

<style>
  .council-sidebar {
    width: 100%;
  }

  .council-name {
    margin: 0 0 var(--spacing-md) 0;
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-primary);
    border-bottom: 2px solid var(--color-primary-main);
    padding-bottom: var(--spacing-sm);
  }

  .member-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .member {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
    padding: var(--spacing-sm) 0;
    border-bottom: 1px solid var(--color-neutral-gray200);
  }

  .member:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .member-name {
    font-weight: var(--font-weight-medium);
    color: var(--color-text-primary);
  }

  .member-position {
    font-size: var(--font-size-sm);
    color: var(--color-primary-main);
    font-weight: var(--font-weight-medium);
  }

  .member-ward {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .no-members {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    margin: 0;
  }
</style>
