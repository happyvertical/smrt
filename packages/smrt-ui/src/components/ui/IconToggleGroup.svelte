<script lang="ts">
/**
 * IconToggleGroup — joins a row of `IconToggle`s into one labelled group: a
 * single segmented strip with shared edges and rounded ends, exposed to
 * assistive technology as `role="group"` named by `label` ("Filter by type").
 * It adds no behaviour; each toggle keeps its own `pressed` state and
 * `onclick`, so it works for one-of-many and many-of-many alike. Put one group
 * per kind of filter and lay the groups out yourself.
 */
import type { Snippet } from 'svelte';

export interface Props {
  /** Names the group for assistive technology (what these toggles filter). */
  label: string;
  /** The `IconToggle`s. */
  children: Snippet;
  /** Additional CSS class names. */
  class?: string;
}

const { label, children, class: className = '' }: Props = $props();
</script>

<div class="smrt-icon-toggle-group__root {className}" role="group" aria-label={label} data-smrt-component="IconToggleGroup">
  {@render children()}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-icon-toggle-group__root {
    display: inline-flex;
    flex-wrap: wrap;
    max-width: 100%;
    isolation: isolate;
  }
  .smrt-icon-toggle-group__root > :global(* + *) {
    margin-inline-start: -1px;
  }
  /* The pressed one sits above its neighbours so its tint is not clipped by them. */
  .smrt-icon-toggle-group__root :global([data-smrt-component="IconToggle"][aria-pressed="true"]),
  .smrt-icon-toggle-group__root :global([data-smrt-component="IconToggle"]:focus-visible) {
    z-index: 1;
  }
}

@layer smrt.theme {
  /* Shared edges: one border between neighbours, square inside, round ends.
  Each toggle sits in tooltip wrappers, so the rules reach it by descendant. */
  .smrt-icon-toggle-group__root :global([data-smrt-component="IconToggle"]) {
    border-radius: 0;
  }
  .smrt-icon-toggle-group__root > :global(:first-child [data-smrt-component="IconToggle"]) {
    border-start-start-radius: var(--smrt-radius-full);
    border-end-start-radius: var(--smrt-radius-full);
  }
  .smrt-icon-toggle-group__root > :global(:last-child [data-smrt-component="IconToggle"]) {
    border-start-end-radius: var(--smrt-radius-full);
    border-end-end-radius: var(--smrt-radius-full);
  }
}

</style>
