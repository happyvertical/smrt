<script lang="ts">
import { AssistantDock } from '@happyvertical/smrt-chat/svelte';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { onDestroy } from 'svelte';
import { ASSISTANT_MODELS, formatSize, getModel } from '../assistant/models.ts';
import { AssistantSession } from '../assistant/session.svelte.ts';
import { browserStorage } from '../blueprint/storage.ts';
import { recipes } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';

interface BrowserAssistantProps {
  /** The registry the shell gives its `dock` snippet. */
  registry: DataSurfaceRegistry;
}

let { registry }: BrowserAssistantProps = $props();

const session = new AssistantSession({
  store: recipeState,
  recipes,
  storage: browserStorage(),
});

onDestroy(() => session.unload());

const model = $derived(getModel(session.prefs.modelId));
const percent = $derived(Math.round(session.progress.progress * 100));
</script>

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
    <div class="bar">
      <span>{model?.label}</span>
      <button type="button" onclick={() => session.unload()}>Change model</button>
    </div>
    <div class="dock">
      <AssistantDock
        transport={session.transport}
        {registry}
        contextMode="server"
        composerPlaceholder="Describe your business, e.g. I sell clothes online"
      />
    </div>
  {:else if session.status === 'loading'}
    <div class="panel" role="status" aria-live="polite">
      <h2>Getting {model?.label} ready</h2>
      <progress max="100" value={percent} aria-label="Model download progress"
        >{percent}%</progress
      >
      <p>{percent}%. {session.progress.text}</p>
      <button type="button" onclick={() => session.cancel()}>Cancel</button>
    </div>
  {:else}
    <form
      class="panel"
      onsubmit={(event) => {
        event.preventDefault();
        void session.start();
      }}
    >
      <h2>Assistant</h2>
      <p>
        Describe your business and an assistant adds the matching recipes. It
        runs on your own device, so nothing you type leaves this page.
      </p>
      {#if session.status === 'error'}
        <p class="error" role="alert">
          The model could not start: {session.error}
        </p>
      {/if}
      <label>
        Model
        <select
          value={session.prefs.modelId}
          onchange={(event) => session.select(event.currentTarget.value)}
        >
          {#each ASSISTANT_MODELS as option (option.id)}
            <option value={option.id}>{option.label}</option>
          {/each}
        </select>
      </label>
      {#if model}
        <p class="size">
          {#if session.consented}
            You already agreed to this download, so it is probably cached and
            starts quickly.
          {:else}
            This downloads {formatSize(model.downloadMB)} once and keeps it in
            your browser. It needs {formatSize(model.vramMB)} of graphics
            memory. Use Wi-Fi if you are on a metered connection.
          {/if}
        </p>
      {/if}
      <button type="submit">
        {session.consented ? 'Start assistant' : 'Download and start'}
      </button>
    </form>
  {/if}
</div>

<style>
  .assistant {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }

  .dock {
    min-height: 0;
    overflow: hidden;
  }

  .panel {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    align-content: start;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-4);
    color: var(--smrt-color-on-surface-variant);
  }

  h2,
  p {
    margin: 0;
  }

  p,
  label {
    color: var(--smrt-color-on-surface-variant);
  }

  label {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  progress {
    width: 100%;
  }

  .error {
    color: var(--smrt-color-error);
  }
</style>
