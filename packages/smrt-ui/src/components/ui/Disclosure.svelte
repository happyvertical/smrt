<script lang="ts">
import type { Snippet } from 'svelte';

export interface Props {
  /** Header text for the disclosure control. */
  title: string;
  /** Whether the disclosure content is visible. */
  open?: boolean;
  /** Blocks opening the disclosure. */
  disabled?: boolean;
  /** The content shown when the disclosure is open. */
  children?: Snippet;
  /** Fired when the open state changes. */
  onopenchange?: (open: boolean) => void;
  /** Additional CSS class names. */
  class?: string;
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
}

let {
  title,
  open = $bindable(false),
  disabled = false,
  children,
  onopenchange,
  class: className = '',
  density,
}: Props = $props();

function handleToggle(event: Event) {
  const next = (event.currentTarget as HTMLDetailsElement).open;
  if (disabled && next) {
    open = false;
    return;
  }
  open = next;
  onopenchange?.(next);
}
</script>

<details class="smrt-disclosure__root {className}" data-density={density} bind:open ontoggle={handleToggle} data-smrt-component="Disclosure">
  <summary aria-disabled={disabled} onclick={(event) => disabled && event.preventDefault()}>
    <span>{title}</span><span class="smrt-disclosure__chevron" data-smrt-part="indicator" aria-hidden="true">⌄</span>
  </summary>
  <div class="smrt-disclosure__content" data-smrt-part="content">{#if children}{@render children()}{/if}</div>
</details>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-disclosure__root[data-density='touch'] {
    --smrt-control-target-min: var(--smrt-touch-target-min);
  }
  .smrt-disclosure__root[data-density='comfortable'] {
    --smrt-control-target-min: 0px;
  }
  .smrt-disclosure__root[data-density='touch'] summary {
    align-items: center;
  }
  summary {
    display: flex;
    min-height: var(--smrt-control-target-min);
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3) 0;
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary[aria-disabled='true'] {
    cursor: not-allowed;
  }
  .smrt-disclosure__content {
    padding: 0 0 var(--smrt-spacing-4);
  }
}

@layer smrt.theme {
  .smrt-disclosure__root {
    border-bottom: var(--smrt-hairline);
    color: var(--smrt-color-on-surface);
  }
  summary {
    font: var(--smrt-typography-title-small-font);
  }
  summary:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  summary[aria-disabled='true'] {
    opacity: .5;
  }
  .smrt-disclosure__chevron {
    transition: transform var(--smrt-duration-short4) var(--smrt-easing-standard);
  }
  details[open] .smrt-disclosure__chevron {
    transform: rotate(180deg);
  }
  .smrt-disclosure__content {
    color: var(--smrt-color-on-surface-variant);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-disclosure__chevron {
      transition: none;
    }
  }
}

</style>
