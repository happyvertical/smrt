<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.workspace.js';
import { useShellDock } from '../workspace/admin-shell/dock.js';
import {
  isShellIconName,
  SHELL_DEFAULT_TOOL_ICON,
  SHELL_ICON_PATHS,
} from '../workspace/admin-shell/shell-icons.js';
import {
  type DockToggle,
  type DockToggleResolution,
  resolveDockToggle,
  runDockTogglePress,
} from './dock-toggle.js';

interface Props {
  toggles: DockToggle[];
}

let { toggles }: Props = $props();
const dock = useShellDock();
const { t } = useI18n();

function iconFor(toggle: DockToggle): string | undefined {
  return toggle.icon ?? (toggle.tool === 'assistant' ? 'chat' : undefined);
}

function resolve(toggle: DockToggle): DockToggleResolution {
  return resolveDockToggle(toggle, dock.has(toggle.tool) && dock.available);
}

function nameFor(toggle: DockToggle, notReady: boolean): string {
  if (!notReady) return toggle.label;
  return (
    toggle.labelNotReady ??
    t(M['ui.dock_toggles.set_up'], { label: toggle.label })
  );
}

function press(event: MouseEvent, toggle: DockToggle): void {
  const resolution = resolve(toggle);
  if (!runDockTogglePress(toggle, event, resolution)) return;
  if (resolution.mode !== 'toggle') return;
  dock.toggle(toggle.tool, {
    returnFocus: event.currentTarget as HTMLElement,
  });
}
</script>

{#snippet glyph(icon: string | undefined)}
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
  {:else if icon === undefined || isShellIconName(icon)}
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={SHELL_ICON_PATHS[icon === undefined ? SHELL_DEFAULT_TOOL_ICON : icon]} />
    </svg>
  {:else}
    <span aria-hidden="true">{icon}</span>
  {/if}
{/snippet}

<div class="smrt-dock-toggles" data-testid="dock-toggles">
  {#each toggles as toggle (toggle.tool)}
    {@const resolution = resolve(toggle)}
    {@const registered = resolution.mode === 'toggle'}
    {@const open = registered && dock.isOpen(toggle.tool)}
    {@const icon = iconFor(toggle)}
    {@const name = nameFor(toggle, resolution.notReady)}
    {#if resolution.mode === 'link'}
      <a
        class="smrt-dock-toggles__button"
        href={toggle.href}
        data-dock-tool={toggle.tool}
        aria-label={name}
        title={name}
        onclick={(event) => press(event, toggle)}
      >
        {@render glyph(icon)}
      </a>
    {:else}
      <!-- raw-primitive-allow: shell chrome toggle, not a content button -->
      <button
        type="button"
        class="smrt-dock-toggles__button"
        class:active={open}
        data-dock-tool={toggle.tool}
        aria-label={name}
        title={name}
        aria-pressed={open}
        aria-expanded={open}
        aria-controls="smrt-admin-shell-right-panel"
        aria-disabled={registered ? undefined : true}
        onclick={(event) => press(event, toggle)}
      >
        {@render glyph(icon)}
      </button>
    {/if}
  {/each}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-dock-toggles {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
  }

  .smrt-dock-toggles__button {
    display: inline-grid;
    text-decoration: none;
    place-items: center;
    position: relative;
    inline-size: var(--smrt-control-height-small);
    block-size: var(--smrt-control-height-small);
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--smrt-control-radius);
    background: transparent;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
  }

  @media (max-width: 48rem) {
    .smrt-dock-toggles__button {
      min-inline-size: var(--smrt-touch-target-min);
      min-block-size: var(--smrt-touch-target-min);
    }
  }

  /* State layer over the button; the active container fill sits under it. */
  .smrt-dock-toggles__button::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    pointer-events: none;
  }

  .smrt-dock-toggles__button:hover::after {
    opacity: var(--smrt-state-hover);
  }

  .smrt-dock-toggles__button:active::after {
    opacity: var(--smrt-state-pressed);
  }

  .smrt-dock-toggles__button:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }

  .smrt-dock-toggles__button.active {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .smrt-dock-toggles__button[aria-disabled='true'] {
    opacity: var(--smrt-state-disabled);
    cursor: default;
  }
}
</style>
