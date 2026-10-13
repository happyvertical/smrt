<script lang="ts">
/**
 * Header nav toggle for tablet/desktop: a chevron that points left while
 * the nav is open (collapse) and right while it is collapsed (expand),
 * with an accessible label and `aria-expanded`. Pair it with
 * `ShellTitle` in AdminShell's `header` snippet; phones use the bottom
 * bar's Menu item instead.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.workspace.js';

interface Props {
  /** Whether the nav is open. */
  expanded: boolean;
  /** Toggle the nav (e.g. `() => shell.togglePanel('left')`). */
  onclick: () => void;
  /** id of the nav panel (default AdminShell's left panel). */
  controls?: string;
  /** What is toggled, for the accessible name ("Collapse site navigation"). */
  label?: string;
}

let {
  expanded,
  onclick,
  controls = 'smrt-admin-shell-left-panel',
  label,
}: Props = $props();

const { t } = useI18n();
const name = $derived(label ?? t(M['ui.shell_nav_toggle.navigation']));
</script>

<!-- raw-primitive-allow: shell chrome toggle, not a content button -->
<button
  type="button"
  class="smrt-shell-nav-toggle"
  aria-label={expanded
    ? t(M['ui.shell_nav_toggle.collapse'], { label: name })
    : t(M['ui.shell_nav_toggle.expand'], { label: name })}
  aria-expanded={expanded}
  aria-controls={controls}
  data-testid="shell-nav-toggle"
  {onclick} data-smrt-component="ShellNavToggle"
>
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {#if expanded}
      <path d="m15 18-6-6 6-6" />
    {:else}
      <path d="m9 18 6-6-6-6" />
    {/if}
  </svg>
</button>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-shell-nav-toggle {
    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    border: 0;
    border-radius: var(--smrt-control-radius);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }

  .smrt-shell-nav-toggle:hover {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
    color: var(--smrt-color-on-surface);
  }

  .smrt-shell-nav-toggle:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
}
</style>
