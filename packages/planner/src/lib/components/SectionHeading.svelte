<script lang="ts">
// A section page's heading: the section's icon, title and description, then
// any controls (the static app's Help and Options icons). The static app's
// `SectionView` and the mounted `Planner`'s `CookbookSectionPage` (its
// `heading` snippet) both draw it, so the two pages read the same.
import { ShellSectionIcon } from '@happyvertical/smrt-svelte/workspace';
import type { Snippet } from 'svelte';

interface SectionHeadingProps {
  icon: string;
  title: string;
  description?: string;
  /** Controls after the heading. */
  actions?: Snippet;
}

let { icon, title, description, actions }: SectionHeadingProps = $props();
</script>

<header class="section-heading">
  <span class="mark"><ShellSectionIcon name={icon} size={28} /></span>
  <div class="heading">
    <h1>{title}</h1>
    {#if description}<p>{description}</p>{/if}
  </div>
  {@render actions?.()}
</header>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4);
  }

  .mark {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    inline-size: 3rem;
    block-size: 3rem;
    border-radius: var(--smrt-radius-large, 0.75rem);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .heading {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  h1 {
    margin: 0;
  }

  .heading p {
    margin: var(--smrt-spacing-1) 0 0;
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
