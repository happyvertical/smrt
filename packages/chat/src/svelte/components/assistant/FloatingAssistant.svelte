<script lang="ts">
/**
 * A permanently mounted AssistantDock with a compact launcher.
 *
 * The wrapper intentionally owns only presentation. AssistantDock remains
 * the one controller, conversation, and confirmation authority. A character
 * is an optional Svelte snippet so a host can use a still image, CSS art, or
 * an animation package without making any of them a chat dependency.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { type Snippet, tick } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { AssistantStatus } from '../../../assistant-turn-events.js';
import { M } from '../../i18n.js';
import AssistantDock, {
  type Props as AssistantDockProps,
} from './AssistantDock.svelte';
import type { AssistantRun } from './create-assistant-dock-controller.svelte.js';

const { t } = useI18n();

export interface FloatingAssistantPresentationState {
  expanded: boolean;
  status: AssistantStatus;
  run: AssistantRun | null;
}

export interface Props extends AssistantDockProps {
  /** Optional host-owned visual; it receives no media or animation contract. */
  character?: Snippet<[FloatingAssistantPresentationState]>;
  /** Accessible launcher text. */
  launcherLabel?: string;
  /** Accessible panel title. */
  panelLabel?: string;
  /** Starts expanded; the bindable value can also be controlled by the host. */
  expanded?: boolean;
}

let {
  character,
  launcherLabel = 'Open assistant',
  panelLabel = 'Assistant',
  expanded = $bindable(false),
  visible = true,
  onstatus,
  onrun,
  onattentionchange,
  ...dockProps
}: Props = $props();

let status = $state<AssistantStatus>({ state: 'idle', label: null });
let run = $state<AssistantRun | null>(null);
let attentionRequired = $state(false);
let launcher: HTMLButtonElement | undefined = $state();
let panel: HTMLElement | undefined = $state();

// Button forwards Svelte attachments to its native button; retain that DOM
// reference for collapse focus without introducing a second control.
const captureLauncher: Attachment<HTMLButtonElement> = (element) => {
  launcher = element;
  return () => {
    launcher = undefined;
  };
};

const floatingAssistantId = $props.id();
const panelId = `floating-assistant-${floatingAssistantId}`;
const panelExpanded = $derived(visible && (expanded || attentionRequired));
const presentation = $derived({ expanded: panelExpanded, status, run });

function open() {
  expanded = true;
}

function collapse() {
  if (!expanded || attentionRequired) return;
  const focusWasInPanel =
    typeof document !== 'undefined' &&
    !!panel?.contains(document.activeElement);
  expanded = false;
  if (focusWasInPanel) void tick().then(() => launcher?.focus());
}

function handleStatus(next: AssistantStatus) {
  status = next;
  onstatus?.(next);
}

function handleRun(next: AssistantRun | null) {
  run = next;
  // A browser-tool confirmation is authoritative only in the dock. Reveal
  // that existing UI rather than creating another approval path here.
  if (next?.waitingFor?.kind === 'confirm') open();
  onrun?.(next);
}

function handleAttentionChange(required: boolean) {
  // Previewed data actions and pending browser-tool calls must remain
  // reachable. This changes visibility only; it never confirms an action.
  attentionRequired = required;
  if (required) open();
  onattentionchange?.(required);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !visible || !expanded) return;
  event.preventDefault();
  collapse();
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="floating-assistant"
  data-expanded={panelExpanded || undefined}
  hidden={!visible}
  inert={!visible}
  aria-hidden={!visible}
>
  <Button
    {@attach captureLauncher}
    variant="ghost"
    type="button"
    class="floating-assistant-launcher"
    aria-expanded={panelExpanded}
    aria-controls={panelId}
    onclick={open}
  >
    {#if character}
      <span class="floating-assistant-character" aria-hidden="true">
        {@render character(presentation)}
      </span>
    {/if}
    <span>{launcherLabel}</span>
  </Button>

  <section
    bind:this={panel}
    id={panelId}
    class="floating-assistant-panel"
    aria-label={panelLabel}
    aria-hidden={!panelExpanded}
    inert={!panelExpanded}
  >
    <Button
      variant="ghost"
      type="button"
      class="floating-assistant-collapse"
      aria-label={t(M['chat.floating_assistant.collapse'])}
      onclick={collapse}
    >
      {t(M['chat.floating_assistant.close'])}
    </Button>
    <AssistantDock
      {...dockProps}
      visible={panelExpanded}
      onstatus={handleStatus}
      onrun={handleRun}
      onattentionchange={handleAttentionChange}
    />
  </section>
</div>

<style>
  .floating-assistant {
    position: fixed;
    z-index: var(--smrt-z-index-overlay, 1200);
    right: max(1rem, env(safe-area-inset-right));
    bottom: max(1rem, env(safe-area-inset-bottom));
    display: grid;
    justify-items: end;
    gap: 0.75rem;
  }

  .floating-assistant[hidden] {
    display: none;
  }

  .floating-assistant :global(.floating-assistant-launcher),
  .floating-assistant :global(.floating-assistant-collapse) {
    border: 1px solid var(--smrt-color-outline, currentColor);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface, Canvas);
    color: var(--smrt-color-on-surface, CanvasText);
    font: inherit;
  }

  .floating-assistant :global(.floating-assistant-launcher) {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    padding: 0.5rem 0.875rem;
    box-shadow: var(
      --smrt-elevation-4,
      0 0.5rem 1.5rem color-mix(in srgb, CanvasText 18%, transparent)
    );
  }

  .floating-assistant-character {
    display: grid;
    place-items: center;
    inline-size: 1.75rem;
    block-size: 1.75rem;
    overflow: hidden;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .floating-assistant-panel {
    box-sizing: border-box;
    display: block;
    inline-size: min(28rem, calc(100vw - 2rem));
    max-block-size: min(42rem, calc(100dvh - 6rem));
    overflow: auto;
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline, currentColor);
    border-radius: 1rem;
    background: var(--smrt-color-surface, Canvas);
    color: var(--smrt-color-on-surface, CanvasText);
    box-shadow: var(
      --smrt-elevation-5,
      0 1rem 2rem color-mix(in srgb, CanvasText 24%, transparent)
    );
    transition: opacity 160ms ease, transform 160ms ease, visibility 160ms ease;
  }

  .floating-assistant:not([data-expanded]) .floating-assistant-panel {
    visibility: hidden;
    pointer-events: none;
    opacity: 0;
    transform: translateY(0.5rem);
  }

  .floating-assistant :global(.floating-assistant-collapse) {
    float: inline-end;
    min-block-size: 2rem;
    padding-inline: 0.625rem;
  }

  @media (max-width: 30rem) {
    .floating-assistant {
      right: max(0.5rem, env(safe-area-inset-right));
      bottom: max(0.5rem, env(safe-area-inset-bottom));
    }

    .floating-assistant-panel {
      inline-size: calc(100vw - 1rem);
      max-block-size: calc(100dvh - 4.5rem);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .floating-assistant-panel {
      transition: none;
    }
  }
</style>
