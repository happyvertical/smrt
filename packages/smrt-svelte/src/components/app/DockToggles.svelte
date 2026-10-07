<script lang="ts">
import { useShellDock } from '../workspace/admin-shell/dock.js';
import type { DockToggle } from './dock-toggle.js';

interface Props {
  toggles: DockToggle[];
}

let { toggles }: Props = $props();
const dock = useShellDock();

function iconFor(toggle: DockToggle): string | undefined {
  return toggle.icon ?? (toggle.tool === 'assistant' ? 'chat' : undefined);
}

function press(event: MouseEvent, toggle: DockToggle): void {
  if (!dock.has(toggle.tool) || !dock.available) return;
  dock.toggle(toggle.tool, {
    returnFocus: event.currentTarget as HTMLElement,
  });
}
</script>

<div class="smrt-dock-toggles" data-testid="dock-toggles">
  {#each toggles as toggle (toggle.tool)}
    {@const registered = dock.has(toggle.tool) && dock.available}
    {@const open = dock.isOpen(toggle.tool)}
    {@const icon = iconFor(toggle)}
    <!-- raw-primitive-allow: shell chrome toggle, not a content button -->
    <button
      type="button"
      class="smrt-dock-toggles__button"
      class:active={open}
      data-dock-tool={toggle.tool}
      aria-label={toggle.label}
      title={toggle.label}
      aria-pressed={open}
      aria-expanded={open}
      aria-controls="smrt-admin-shell-right-panel"
      aria-disabled={registered ? undefined : true}
      onclick={(event) => press(event, toggle)}
    >
      {#if icon === 'chat'}
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 20.5l1.6-5A8.5 8.5 0 1 1 21 11.5z" />
        </svg>
      {:else}
        <span aria-hidden="true">{icon ?? toggle.label.charAt(0)}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .smrt-dock-toggles {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
  }

  .smrt-dock-toggles__button {
    display: inline-grid;
    place-items: center;
    inline-size: 2.25rem;
    block-size: 2.25rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: transparent;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
  }

  .smrt-dock-toggles__button:hover {
    background: var(--smrt-color-surface-container-high);
  }

  .smrt-dock-toggles__button:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }

  .smrt-dock-toggles__button.active {
    background: var(--smrt-color-primary-container, var(--smrt-color-surface-container-high));
    color: var(--smrt-color-on-primary-container, var(--smrt-color-primary));
  }

  .smrt-dock-toggles__button[aria-disabled='true'] {
    opacity: 0.5;
    cursor: default;
  }
</style>
