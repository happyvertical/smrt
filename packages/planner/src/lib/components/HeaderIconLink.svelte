<script lang="ts">
/**
 * A normally icon-only link in the shell header's end slot: the planner's "Plan the
 * app" (chef's hat) and "Export the app" (download) controls, in the mounted
 * `Planner` and the static app's layout alike. `label` is the accessible name
 * and the tooltip; `showLabel` opts into visible text. `current` marks the control whose page is open
 * (`aria-current="page"`); `transitionName` is the `view-transition-name` it
 * carries while a route transition runs (one per control, unique on screen).
 */
import {
  shellTargetAction,
  tryUseShellTargets,
} from '@happyvertical/smrt-svelte/workspace';
import { Icon } from '@happyvertical/smrt-ui';

interface Props {
  href: string;
  guideTarget?: string;
  label: string;
  /** Opt-in visible text for a host-labelled action; other links stay icon-only. */
  showLabel?: boolean;
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
  guideTarget,
  label,
  showLabel = false,
  icon,
  path,
  current = false,
  transitionName,
  onclick,
}: Props = $props();
const target = shellTargetAction(tryUseShellTargets());
</script>

<a
  use:target={guideTarget ?? `item:${transitionName}`}
  class="header-link"
  class:header-link--labelled={showLabel}
  {href}
  aria-label={label}
  title={label}
  aria-current={current ? 'page' : undefined}
  style:--smrt-header-icon-link-transition-name={transitionName}
  {onclick}
>
  <Icon {path} name={path ? undefined : icon} size={18} />
  {#if showLabel}<span>{label}</span>{/if}
</a>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .header-link {
    /* The shell's header slot is a shrinking flex row: keep the hit area, as
       the shell's own icon buttons do. */
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    inline-size: 2rem;
    block-size: 2rem;
    color: inherit;
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }
  .header-link--labelled {
    display: inline-flex;
    gap: var(--smrt-spacing-1);
    inline-size: auto;
    padding-inline: var(--smrt-spacing-2);
    white-space: nowrap;
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
    view-transition-name: var(--smrt-header-icon-link-transition-name);
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
