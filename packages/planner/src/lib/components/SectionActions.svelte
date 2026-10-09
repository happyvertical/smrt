<script lang="ts">
// Planner actions on a navigation section in the shell's layout edit mode. A
// section usually maps to one Options/Help group (direct icons); when it holds
// several recipes' groups (Sales: Customers and Sales) a single gear opens a
// small menu so the sidebar row never overflows.
import { Icon } from '@happyvertical/smrt-ui';
import { appHref } from '$lib/planner/app.svelte.ts';
import SectionIcons from './SectionIcons.svelte';

// Material Design Icons "settings" (Apache-2.0); smrt-ui's Icon fills its path.
const SETTINGS =
  'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';

interface SectionActionsProps {
  /** The navigation section's label, for accessible names. */
  label: string;
  /** Options/Help groups whose items live in this section. */
  groups: { id: string; label: string }[];
}

let { label, groups }: SectionActionsProps = $props();
</script>

{#if groups.length === 1}
  <SectionIcons section={groups[0].id} label={groups[0].label} compact />
{:else if groups.length > 1}
  <details class="menu">
    <summary title={`${label} options and help`} aria-label={`${label} options and help`}>
      <Icon path={SETTINGS} size={16} />
    </summary>
    <ul>
      {#each groups as group (group.id)}
        <li><a href={appHref(`/recipes/${group.id}/`)}>{group.label} options</a></li>
        <li><a href={appHref(`/recipes/${group.id}/help/`)}>{group.label} help</a></li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .menu {
    position: relative;
  }

  summary {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--smrt-radius-small, 0.25rem);
    list-style: none;
    cursor: pointer;
    color: var(--smrt-color-on-surface-variant);
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }

  ul {
    position: absolute;
    inset-inline-end: 0;
    z-index: 20;
    min-width: 11rem;
    margin: var(--smrt-spacing-1) 0 0;
    padding: var(--smrt-spacing-1);
    list-style: none;
    background: var(--smrt-color-surface-container-high, var(--smrt-color-surface));
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium);
  }

  a {
    display: block;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    border-radius: var(--smrt-radius-small, 0.25rem);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    white-space: nowrap;
  }

  a:hover,
  a:focus-visible {
    background: var(--smrt-color-surface-container-highest, var(--smrt-color-surface-variant));
  }
</style>
