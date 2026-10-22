<script lang="ts">
/**
 * A normally icon-only link in the shell header's end slot: the planner's "Plan the
 * app" (chef's hat) and "Export the app" (download) controls, in the mounted
 * `Planner` and the static app's layout alike. `label` is the accessible name
 * and the tooltip; `showLabel` opts into visible text. `current` marks the control whose page is open
 * (`aria-current="page"`); `transitionName` is the `view-transition-name` it
 * carries while a route transition runs (one per control, unique on screen).
 *
 * `tone` turns it into one of the labelled header navigation buttons
 * (`headerNav: 'labelled'`): a bordered button with icon and visible text in
 * its own theme colour (info, success, tertiary, warning). A host overrides
 * `--smrt-header-icon-link-accent` on `[data-tone='…']` to recolour one.
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
  /** Labelled navigation button: its accent colour; implies visible text. */
  tone?: 'specs' | 'features' | 'styles' | 'build';
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
  tone,
  transitionName,
  onclick,
}: Props = $props();
const target = shellTargetAction(tryUseShellTargets());
</script>

<a
  use:target={guideTarget ?? `item:${transitionName}`}
  class="header-link"
  class:header-link--labelled={showLabel || tone !== undefined}
  class:header-link--nav={tone !== undefined}
  data-tone={tone}
  {href}
  aria-label={label}
  title={label}
  aria-current={current ? 'page' : undefined}
  style:--smrt-header-icon-link-transition-name={transitionName}
  {onclick}
>
  <Icon {path} name={path ? undefined : icon} size={18} />
  {#if showLabel || tone}<span>{label}</span>{/if}
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
  /* The labelled navigation buttons. The accent is the border, the icon and a
     tint; the text stays the theme's own on-surface colour, so its contrast is
     the theme's whatever the accent. The icon and border mix the accent toward
     on-surface (a darker tone in light schemes, a lighter one in dark), so
     they stay at 3:1 or better against the surface in both. */
  .header-link--nav {
    --smrt-header-icon-link-accent: var(--smrt-color-info);
    --smrt-header-icon-link-ink: color-mix(in srgb, var(--smrt-header-icon-link-accent) 60%, var(--smrt-color-on-surface, CanvasText));
    gap: var(--smrt-spacing-2);
    block-size: 2.25rem;
    padding-inline: var(--smrt-spacing-3);
    border: 0.125rem solid var(--smrt-header-icon-link-ink);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: color-mix(in srgb, var(--smrt-header-icon-link-accent) 14%, var(--smrt-color-surface, Canvas));
    color: var(--smrt-color-on-surface, CanvasText);
    font-weight: 600;
    text-decoration: none;
  }
  .header-link--nav[data-tone='features'] {
    --smrt-header-icon-link-accent: var(--smrt-color-success);
  }
  .header-link--nav[data-tone='styles'] {
    --smrt-header-icon-link-accent: var(--smrt-color-tertiary);
  }
  .header-link--nav[data-tone='build'] {
    --smrt-header-icon-link-accent: var(--smrt-color-warning);
  }
  .header-link--nav :global(svg) {
    color: var(--smrt-header-icon-link-ink);
  }
  .header-link--nav:hover {
    background: color-mix(in srgb, var(--smrt-header-icon-link-accent) 28%, var(--smrt-color-surface, Canvas));
  }
  .header-link--nav[aria-current='page'] {
    background: color-mix(in srgb, var(--smrt-header-icon-link-accent) 32%, var(--smrt-color-surface, Canvas));
    color: var(--smrt-color-on-surface, CanvasText);
    box-shadow: inset 0 -0.25rem 0 var(--smrt-header-icon-link-ink);
  }
  /* Phone footer bar: four buttons share the row, icon over text. */
  @media (max-width: 30rem) {
    .header-link--nav {
      flex: 1 1 0;
      min-inline-size: 0;
      flex-direction: column;
      gap: 0;
      block-size: auto;
      padding: var(--smrt-spacing-1);
      font-size: 0.6875rem;
      line-height: 1.2;
    }
    .header-link--nav :global(span) {
      max-inline-size: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
  @media (max-width: 20rem) {
    .header-link--nav {
      font-size: 0.625rem;
      border-width: 0.0625rem;
    }
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
    .header-link--nav {
      border-color: ButtonText;
      background: ButtonFace;
      color: ButtonText;
    }
    .header-link--nav :global(svg) {
      color: ButtonText;
    }
    .header-link--nav:hover {
      border-color: Highlight;
    }
    .header-link--nav[aria-current='page'] {
      border-color: Highlight;
      background: Highlight;
      color: HighlightText;
      box-shadow: none;
    }
    .header-link--nav[aria-current='page'] :global(svg) {
      color: HighlightText;
    }
  }
}
</style>
