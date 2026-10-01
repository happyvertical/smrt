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

<div class="icon-toggle-group {className}" role="group" aria-label={label}>
  {@render children()}
</div>

<style>
  .icon-toggle-group {
    display: inline-flex;
    flex-wrap: wrap;
    max-width: 100%;
    isolation: isolate;
  }
  /* Shared edges: one border between neighbours, square inside, round ends.
     Each toggle sits in tooltip wrappers, so the rules reach it by descendant. */
  .icon-toggle-group :global(.icon-toggle) {
    border-radius: 0;
  }
  .icon-toggle-group > :global(* + *) {
    margin-inline-start: -1px;
  }
  .icon-toggle-group > :global(:first-child .icon-toggle) {
    border-start-start-radius: var(--smrt-radius-full, 999px);
    border-end-start-radius: var(--smrt-radius-full, 999px);
  }
  .icon-toggle-group > :global(:last-child .icon-toggle) {
    border-start-end-radius: var(--smrt-radius-full, 999px);
    border-end-end-radius: var(--smrt-radius-full, 999px);
  }
  /* The pressed one sits above its neighbours so its tint is not clipped by them. */
  .icon-toggle-group :global(.icon-toggle.pressed),
  .icon-toggle-group :global(.icon-toggle:focus-visible) {
    z-index: 1;
  }
</style>
