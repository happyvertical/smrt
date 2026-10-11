<script lang="ts">
import { AssistantDock } from '@happyvertical/smrt-chat/svelte';
import { Button } from '@happyvertical/smrt-ui';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { cancelsSpeech } from '../ai/echo-gate.ts';
import { aiState } from '../ai/instance.ts';
import { getModel, shortLabel } from '../assistant/models.ts';
import { isOfferRef } from '../assistant/offers.svelte.ts';
import { isThemeUndoRef } from '../assistant/theme-undo.svelte.ts';
import { createHandsFreeCapture as handsFreeCapture } from '../assistant/voice-host.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { applyLibraryCookbook, needsConfirm } from '../library/apply.ts';
import { getLibraryCookbook } from '../library/index.ts';
import { previewMenu } from '../library/menu.ts';
import { libraryState } from '../library/state.svelte.ts';
import { appHref } from '../planner/app.svelte.ts';
import { settingsOfCookbook } from '../settings/app-settings.ts';
import AiSetup from './AiSetup.svelte';
import VoiceTyping from './VoiceTyping.svelte';

interface BrowserAssistantProps {
  /** The registry the shell gives its `dock` snippet. */
  registry: DataSurfaceRegistry;
}

let { registry }: BrowserAssistantProps = $props();

// The model and voice live in the shared AI state (the sidebar icons and the
// AI models page read the same), so closing the dock keeps them loaded.
const session = $derived(aiState.session);
const voice = $derived(aiState.voice);
const model = $derived(getModel(session.prefs.modelId));
const dataSource = useDataSource();
const thinkName = $derived(
  session.mode === 'browser'
    ? model
      ? shortLabel(model)
      : ''
    : session.mode === 'host'
      ? 'Server'
      : session.remoteLabel,
);

// Applying a cookbook runs the Cookbooks tab's path, with the cookbook's own
// settings. It only ever runs from the confirm button below.
$effect(() => {
  const offers = session.offers;
  offers.applier = (cookbook) => {
    const result = applyLibraryCookbook(
      cookbook,
      cookbookStore,
      settingsOfCookbook(cookbook.settings),
    );
    if (!result.ok) return result.error;
    dataSource.reset?.();
    libraryState.select(cookbook.id);
    return null;
  };
  return () => {
    offers.applier = null;
  };
});
</script>

{#snippet themeUndo(ref: unknown)}
  {#if isThemeUndoRef(ref) && session.themeUndos}
    {@const entry = session.themeUndos.undos[ref.undoId]}
    {#if entry?.status === 'available'}
      <div class="offer" role="group" aria-label="Theme change">
        <Button variant="secondary" onclick={() => session.themeUndos?.undo(entry.id)}>
          Undo theme change
        </Button>
      </div>
    {:else if entry?.status === 'undone'}
      <p class="offer-note" role="status">Theme restored.</p>
    {/if}
  {/if}
{/snippet}

{#snippet toolCard(message: { toolCallData?: unknown })}
  {#each Array.isArray(message.toolCallData) ? message.toolCallData : [message.toolCallData] as ref, i (i)}
    {@render offerCard(ref)}
    {@render themeUndo(ref)}
  {/each}
{/snippet}

{#snippet offerCard(data: unknown)}
  {#if isOfferRef(data)}
    {@const offer = session.offers.offers[data.offerId]}
    {@const cookbook = offer ? getLibraryCookbook(offer.cookbookId) : undefined}
    {#if offer && cookbook}
      {#if offer.status === 'pending'}
        {@const menu = previewMenu(cookbook.document)}
        <div class="offer" role="group" aria-label="Add the {cookbook.name} cookbook">
          <div class="offer-text">
            <strong>{cookbook.name} cookbook</strong>
            <span>{cookbook.summary}</span>
            {#if menu.length}
              <ul class="offer-menu">
                {#each menu as section (section.id)}
                  <li>
                    <b>{section.label}</b>:
                    {section.entries.map((entry) => entry.label).join(', ')}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          <Button onclick={() => session.offers.accept(offer.id)}>
            Add {cookbook.name} cookbook
          </Button>
          <Button variant="secondary" onclick={() => session.offers.decline(offer.id)}>
            No thanks
          </Button>
          {#if needsConfirm(cookbookStore)}
            <small>Replaces your recipes, menu and sample records.</small>
          {/if}
        </div>
      {:else if offer.status === 'applied'}
        <p class="offer-note" role="status">{cookbook.name} set up.</p>
      {:else if offer.status === 'failed'}
        <p class="offer-note" role="alert">{offer.error}</p>
      {/if}
    {/if}
  {/if}
{/snippet}

<div class="assistant">
  {#if session.status === 'unsupported'}
    <div class="panel" role="status">
      <h2>Assistant unavailable</h2>
      <p>
        The assistant runs a small model on your graphics card using WebGPU, and
        this browser does not offer it. Try a recent Chrome, Edge or Safari on a
        computer. Nothing else changes: the cards on the Planner page add and
        remove recipes without it.
      </p>
    </div>
  {:else if session.status === 'ready'}
    <div class="top">
      <div class="bar">
        <span class="model-name">{thinkName}</span>
        <a
          class="model-link"
          href={appHref('/ai/')}
          aria-label="AI settings: change model or voice"
          title="AI settings"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path
              d="M4 6h8M15 6h1M4 14h1M8 14h8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
            <circle cx="13.5" cy="6" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5" />
            <circle cx="6.5" cy="14" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </a>
      </div>
      <VoiceTyping {voice} />
    </div>
    <!-- Typing or pressing the microphone interrupts a spoken reply. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="dock"
      oninputcapture={(event) => {
        if (cancelsSpeech(event)) aiState.cancelSpeech();
      }}
      onclickcapture={(event) => {
        if (cancelsSpeech(event)) aiState.cancelSpeech();
      }}
    >
      <AssistantDock
        transport={session.transport}
        {registry}
        contextMode="server"
        conversations="single"
        composerPlaceholder="I run a bakery…"
        toolCall={toolCard}
        dictation={voice.dictation}
        dictationMode={aiState.handsFreeActive ? 'hands-free' : 'push'}
        {handsFreeCapture}
        sendOnPause={aiState.sendOnPauseActive}
        speaking={aiState.speaking}
      />
    </div>
  {:else}
    <div class="panel">
      <h2>Assistant</h2>
      <p>
        Describe your business and an assistant adds the matching recipes.
        {aiState.inference.mode === 'browser'
          ? 'It runs on your own device, so nothing you type leaves this page.'
          : aiState.privacyNote}
      </p>
      <AiSetup show={['think']} />
      <a href={appHref('/ai/')}>All AI settings</a>
    </div>
  {/if}
</div>

<style>
  .assistant {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .top {
    min-width: 0;
  }

  .dock {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .panel {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    align-content: start;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-4);
    min-width: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .model-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

  .model-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: var(--smrt-radius-full, 9999px);
    color: var(--smrt-color-on-surface-variant);
  }

  .model-link:hover {
    background: var(--smrt-color-surface-container);
  }

  .model-link:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 1px;
  }

  .offer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2);
    margin-top: var(--smrt-spacing-2);
  }

  .offer-text {
    display: grid;
    gap: var(--smrt-spacing-1);
    flex-basis: 100%;
  }

  .offer-text span,
  .offer-menu {
    color: var(--smrt-color-on-surface-variant);
  }

  .offer-menu {
    margin: 0;
    padding-inline-start: var(--smrt-spacing-4);
  }

  .offer small,
  .offer-note {
    color: var(--smrt-color-on-surface-variant);
  }

  .offer-note {
    margin: var(--smrt-spacing-2) 0 0;
  }

  h2,
  p {
    margin: 0;
  }

  p {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
