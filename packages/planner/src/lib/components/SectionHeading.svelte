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

<header class="smrt-section-heading__root" data-smrt-component="SectionHeading">
  <span class="smrt-section-heading__icon" data-smrt-part="icon"><ShellSectionIcon name={icon} size={28} /></span>
  <div class="smrt-section-heading__heading" data-smrt-part="heading">
    <h1>{title}</h1>
    {#if description}<p>{description}</p>{/if}
  </div>
  {@render actions?.()}
</header>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4);
  }
  .smrt-section-heading__icon {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    inline-size: 3rem;
    block-size: 3rem;
  }
  .smrt-section-heading__heading {
    flex: 1 1 auto;
    min-inline-size: 0;
  }
  h1 {
    margin: 0;
  }
  .smrt-section-heading__heading p {
    margin: var(--smrt-spacing-1) 0 0;
  }
}

@layer smrt.theme {
  .smrt-section-heading__icon {
    border-radius: var(--smrt-radius-large, 0.75rem);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-section-heading__heading p {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
