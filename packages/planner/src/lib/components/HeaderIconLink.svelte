<script lang="ts">
/**
 * An icon-only link in the shell header's end slot: the planner's "Plan the
 * app" (chef's hat) and "Export the app" (download) controls, in the mounted
 * `Planner` and the static app's layout alike. `label` is the accessible name
 * and the tooltip; `current` marks the control whose page is open
 * (`aria-current="page"`); `transitionName` is the `view-transition-name` it
 * carries while a route transition runs (one per control, unique on screen).
 */
import { Icon } from '@happyvertical/smrt-ui';

interface Props {
  href: string;
  label: string;
  /** A smrt-ui preset icon name. */
  icon?: string;
  /** A custom icon path (wins over `icon`). */
  path?: string;
  current?: boolean;
  transitionName: string;
  onclick?: (event: MouseEvent) => void;
}

let {
  href,
  label,
  icon,
  path,
  current = false,
  transitionName,
  onclick,
}: Props = $props();
</script>

<a
  class="header-link"
  {href}
  aria-label={label}
  title={label}
  aria-current={current ? 'page' : undefined}
  style:--planner-transition-name={transitionName}
  {onclick}
>
  <Icon {path} name={path ? undefined : icon} size={18} />
</a>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .header-link {
    display: inline-grid;
    place-items: center;
    inline-size: 2rem;
    block-size: 2rem;
    color: inherit;
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }
  .header-link:hover {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
  .header-link:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .header-link[aria-current='page'] {
    background: var(--smrt-color-secondary-container, rgb(0 0 0 / 12%));
    color: var(--smrt-color-primary);
  }
  /* Named only while a transition runs, as in Planner.svelte: a permanent
     name makes a stacking context. */
  :global([data-smrt-view-transition]) .header-link {
    view-transition-name: var(--planner-transition-name);
  }
  /* Forced colours: the current page's background is replaced, so it is
     drawn as a selected item. */
  @media (forced-colors: active) {
    .header-link[aria-current='page'] {
      background: Highlight;
      color: HighlightText;
    }
  }
}
</style>
