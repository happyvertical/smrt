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
import type {
  AssistantDockController,
  AssistantRun,
} from './create-assistant-dock-controller.svelte.js';

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
  /** Fixed viewport corner used by the launcher and its conversation panel. */
  placement?: 'bottom-left' | 'bottom-right';
  /** Hides empty controls-only chrome while preserving active runs and decisions. */
  hideIdleControls?: boolean;
}

let {
  character,
  launcherLabel = 'Open assistant',
  panelLabel = 'Assistant',
  expanded = $bindable(false),
  placement = 'bottom-right',
  hideIdleControls = false,
  visible = true,
  presentation = 'full',
  onstatus,
  onrun,
  onattentionchange,
  oncontroller,
  ...dockProps
}: Props = $props();

let status = $state<AssistantStatus>({ state: 'idle', label: null });
let run = $state<AssistantRun | null>(null);
let attentionRequired = $state(false);
let dockController = $state.raw<AssistantDockController | null>(null);
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
const hasActionableRun = $derived(
  run?.state === 'running' ||
    run?.state === 'paused' ||
    run?.state === 'waiting',
);
const hasActionableStatus = $derived(
  status.state === 'working' || status.state === 'error',
);
const hasControllerError = $derived(!!dockController?.error);
const panelExpanded = $derived(
  visible &&
    (expanded || attentionRequired) &&
    (!hideIdleControls ||
      presentation === 'full' ||
      attentionRequired ||
      hasActionableRun ||
      hasActionableStatus ||
      hasControllerError),
);
const launcherVisible = $derived(
  !hideIdleControls ||
    presentation === 'full' ||
    attentionRequired ||
    hasActionableRun ||
    hasActionableStatus ||
    hasControllerError,
);
const presentationState = $derived({ expanded: panelExpanded, status, run });

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

function handleController(next: AssistantDockController) {
  dockController = next;
  oncontroller?.(next);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !visible || !expanded) return;
  event.preventDefault();
  collapse();
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="smrt-floating-assistant__root"
  data-expanded={panelExpanded || undefined}
  hidden={!visible}
  inert={!visible}
  aria-hidden={!visible} data-smrt-component="FloatingAssistant"

  class:smrt-floating-assistant__bottom-left={placement === 'bottom-left'}
>
  {#if launcherVisible}
    <Button
      {@attach captureLauncher}
      variant="ghost"
      type="button"
      aria-expanded={panelExpanded}
      aria-controls={panelId}
      onclick={open}
    >
      {#if character}
        <span class="smrt-floating-assistant__character" data-smrt-part="icon" aria-hidden="true">
          {@render character(presentationState)}
        </span>
      {/if}
      <span>{launcherLabel}</span>
    </Button>
  {/if}

  <section
    bind:this={panel}
    id={panelId}
    class="smrt-floating-assistant__panel"
    data-smrt-part="panel"
    aria-label={panelLabel}
    aria-hidden={!panelExpanded}
    inert={!panelExpanded}
  >
    <Button
      variant="ghost"
      type="button"
      aria-label={t(M['chat.floating_assistant.collapse'])}
      onclick={collapse}
    >
      {t(M['chat.floating_assistant.close'])}
    </Button>
    <AssistantDock
      {...dockProps}
      {presentation}
      visible={panelExpanded}
      oncontroller={handleController}
      onstatus={handleStatus}
      onrun={handleRun}
      onattentionchange={handleAttentionChange}
    />
  </section>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-floating-assistant__root {
    position: fixed;
    z-index: var(--smrt-z-index-overlay, 1200);
    right: max(1rem, env(safe-area-inset-right));
    bottom: max(1rem, env(safe-area-inset-bottom));
    display: grid;
    justify-items: end;
    gap: 0.75rem;
  }
  .smrt-floating-assistant__root.smrt-floating-assistant__bottom-left {
    right: auto;
    left: max(1rem, env(safe-area-inset-left));
    justify-items: start;
  }
  .smrt-floating-assistant__root[hidden] {
    display: none;
  }
  .smrt-floating-assistant__root > :global([data-smrt-component="Button"]) {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    padding: 0.5rem 0.875rem;
  }
  .smrt-floating-assistant__character {
    display: grid;
    place-items: center;
    inline-size: 1.75rem;
    block-size: 1.75rem;
    overflow: hidden;
  }
  .smrt-floating-assistant__root:not([data-expanded]) .smrt-floating-assistant__panel {
    visibility: hidden;
    pointer-events: none;
  }
  .smrt-floating-assistant__panel {
    box-sizing: border-box;
    display: block;
    inline-size: min(28rem, calc(100vw - 2rem));
    max-block-size: min(42rem, calc(100dvh - 6rem));
    overflow: auto;
    padding: 0.75rem;
  }
  .smrt-floating-assistant__panel > :global([data-smrt-component="Button"]) {
    float: inline-end;
    min-block-size: 2rem;
    padding-inline: 0.625rem;
  }
  @media (max-width: 30rem) {
    .smrt-floating-assistant__root {
      right: max(0.5rem, env(safe-area-inset-right));
      bottom: max(0.5rem, env(safe-area-inset-bottom));
    }
    .smrt-floating-assistant__root.smrt-floating-assistant__bottom-left {
      right: auto;
      left: max(0.5rem, env(safe-area-inset-left));
    }
    .smrt-floating-assistant__panel {
      inline-size: calc(100vw - 1rem);
      max-block-size: calc(100dvh - 4.5rem);
    }
  }
}

@layer smrt.theme {
  .smrt-floating-assistant__root > :global([data-smrt-component="Button"]),
  .smrt-floating-assistant__panel > :global([data-smrt-component="Button"]) {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface, Canvas);
    color: var(--smrt-color-on-surface, CanvasText);
    font: inherit;
  }
  .smrt-floating-assistant__root > :global([data-smrt-component="Button"]) {
    box-shadow: var(
      --smrt-elevation-4,
      0 0.5rem 1.5rem color-mix(in srgb, CanvasText 18%, transparent)
    );
  }
  .smrt-floating-assistant__character {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-floating-assistant__panel {
    border: var(--smrt-hairline-strong);
    border-radius: 1rem;
    background: var(--smrt-color-surface, Canvas);
    color: var(--smrt-color-on-surface, CanvasText);
    box-shadow: var(
      --smrt-elevation-5,
      0 1rem 2rem color-mix(in srgb, CanvasText 24%, transparent)
    );
    transition: opacity 160ms ease, transform 160ms ease, visibility 160ms ease;
  }
  .smrt-floating-assistant__root:not([data-expanded]) .smrt-floating-assistant__panel {
    opacity: 0;
    transform: translateY(0.5rem);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-floating-assistant__panel {
      transition: none;
    }
  }
}

</style>
